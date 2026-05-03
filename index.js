const { Client, GatewayIntentBits, Events } = require("discord.js");
const admin = require("firebase-admin");
const https = require("https");
const http  = require("http");

// ════════════════════════════════════
// 환경변수
// ════════════════════════════════════
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_URL     = process.env.DISCORD_WEBHOOK_URL;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const CHAT_CHANNEL    = process.env.CHAT_CHANNEL || "general";
const PORT            = process.env.PORT || 3000;

// ── 환경변수 누락 체크 ──
const REQUIRED_ENVS = {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID:    DISCORD_CHANNEL,
  DISCORD_WEBHOOK_URL:   WEBHOOK_URL,
  FIREBASE_DB_URL,
  FIREBASE_PROJECT_ID:   process.env.FIREBASE_PROJECT_ID,
  FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
  FIREBASE_PRIVATE_KEY:  process.env.FIREBASE_PRIVATE_KEY,
};

let envOk = true;
for (const [key, val] of Object.entries(REQUIRED_ENVS)) {
  if (!val) { console.error(`❌ 환경변수 누락: ${key}`); envOk = false; }
}
if (!envOk) { console.error("환경변수 부족으로 종료합니다."); process.exit(1); }

console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
console.log("🚀 봇 시작 중...");
console.log(`📡 Firebase 채널: ${CHAT_CHANNEL}`);
console.log(`💬 Discord 채널 ID: ${DISCORD_CHANNEL}`);
console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

// ════════════════════════════════════
// Railway용 HTTP 서버
// ════════════════════════════════════
http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    status:          "running",
    channel:         CHAT_CHANNEL,
    discord_channel: DISCORD_CHANNEL,
    uptime:          Math.floor(process.uptime()) + "s",
  }));
}).listen(PORT, () => {
  console.log(`🌐 HTTP 서버 실행 중 (포트 ${PORT})`);
});

// ════════════════════════════════════
// Firebase 초기화
// ════════════════════════════════════
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();

// ════════════════════════════════════
// Webhook 전송
// ════════════════════════════════════
function sendWebhook(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(WEBHOOK_URL);
    const req  = https.request(
      {
        hostname: url.hostname,
        path:     url.pathname + url.search,
        method:   "POST",
        headers:  {
          "Content-Type":   "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
      },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => {
          if (res.statusCode >= 400) {
            console.error(`⚠️ Webhook 응답 ${res.statusCode}:`, raw.slice(0, 300));
          }
          resolve();
        });
      }
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ════════════════════════════════════
// Discord 봇 클라이언트
// ════════════════════════════════════
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent, // Developer Portal에서도 반드시 ON
  ],
});

// ════════════════════════════════════
// 앱 → Discord (Firebase child_added)
//
// ❌ 기존 문제: .limitToLast(1) 사용
//    → 채팅앱에서 메시지 삭제하면 Firebase가 이전 메시지를
//      "새 마지막 항목"으로 child_added 재발화
//    → 이미 보낸 이전 메시지가 Discord에 다시 출력되는 버그
//
// ✅ 수정: limitToLast 제거 + sentKeys Set으로 중복 방지
//    → 한 번 보낸 key는 Set에 기록 → 재발화해도 무시
//    → botStartTs 기준으로 봇 시작 전 메시지 전체 무시
// ════════════════════════════════════
const sentKeys  = new Set(); // 이미 Discord로 보낸 Firebase key 목록
const botStartTs = Date.now(); // 봇 시작 시각 (이 시각 이전 메시지는 전부 무시)
let isInit = true;

db.ref(`messages/${CHAT_CHANNEL}`)
  // limitToLast 없음 — 삭제 시 재발화 방지
  .on("child_added", async (snap) => {
    if (isInit) return; // 초기 로드 중 무시

    const key = snap.key;

    // ── 핵심: 이미 처리한 key면 무조건 스킵 (삭제 후 재발화 방지) ──
    if (sentKeys.has(key)) return;

    const msg = snap.val();
    if (!msg) return;

    // 봇 시작 전에 작성된 메시지 무시
    if ((msg.ts || 0) < botStartTs) {
      sentKeys.add(key); // 과거 메시지도 Set에 등록해서 이후 재발화 차단
      return;
    }

    // 디스코드에서 온 메시지는 역방향 전송 안 함 (무한루프 방지)
    if (msg.fromDiscord) {
      sentKeys.add(key);
      return;
    }

    // ── 이 key는 처리 완료로 등록 ──
    sentKeys.add(key);

    try {
      const body = {
        username:   `${msg.nick} (채팅앱)`,
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.nick)}&background=5c6ef8&color=fff&rounded=true`,
      };

      if (msg.type === "image") {
        // base64는 Discord embed에 직접 넣을 수 없음 → 안내 텍스트
        if (msg.content && msg.content.startsWith("data:")) {
          body.content = "📷 *이미지를 보냈습니다 (채팅앱에서 확인)*";
        } else {
          body.content = "📷 이미지";
          body.embeds  = [{ image: { url: msg.content } }];
        }
      } else {
        // 대댓글(replyTo) 인용 표시
        if (msg.replyTo) {
          body.content = `> **${msg.replyTo.nick}**: ${msg.replyTo.text}\n${msg.content}`;
        } else {
          body.content = msg.content;
        }
      }

      await sendWebhook(body);
      console.log(`📤 앱→디코: [${msg.nick}] ${msg.type === "image" ? "(이미지)" : msg.content}`);
    } catch (e) {
      console.error("❌ Webhook 전송 실패:", e.message);
      // 실패 시 key를 Set에서 제거 → 다음 재시도 기회 부여
      sentKeys.delete(key);
    }
  });

// 3초 후 초기 로드 완료 → 이후 새 메시지만 처리
setTimeout(() => {
  isInit = false;
  console.log("✅ Firebase 리스너 준비 완료 — 새 메시지부터 Discord로 전달합니다");
}, 3000);

// ════════════════════════════════════
// Discord → 앱 (MessageCreate)
// ════════════════════════════════════
client.on(Events.MessageCreate, async (message) => {
  // 웹훅 메시지 필터 (앱→디코 웹훅이 루프되는 것 방지)
  if (message.webhookId) return;
  if (message.author.bot) return;
  if (message.channelId !== DISCORD_CHANNEL) return;

  const hasContent     = typeof message.content === "string" && message.content.trim().length > 0;
  const hasAttachments = message.attachments.size > 0;

  // Message Content Intent 미활성화 감지
  if (!hasContent && !hasAttachments) {
    console.warn(
      "⚠️  내용이 없는 메시지 수신. 확인사항:\n" +
      "   → Discord Developer Portal > Bot > Privileged Gateway Intents\n" +
      "   → 'Message Content Intent' 를 ON 으로 설정 후 봇 재시작"
    );
    return;
  }

  const nick       = `${message.author.displayName} 🎮`;
  const discordUid = `discord_${message.author.id}`;

  console.log(`📥 디코→앱: [${nick}] ${hasContent ? message.content : "(첨부파일만)"}`);

  // 이미지 첨부 처리
  if (hasAttachments) {
    for (const att of message.attachments.values()) {
      if (att.contentType?.startsWith("image/")) {
        await db.ref(`messages/${CHAT_CHANNEL}`).push({
          uid: discordUid, nick,
          content: att.url, type: "image",
          ts: Date.now(), fromDiscord: true,
        });
        console.log(`   📷 이미지 Firebase 저장: ${att.url}`);
      }
    }
  }

  // 텍스트 메시지 처리
  if (hasContent) {
    let replyTo = null;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        if (ref) {
          replyTo = {
            key:  `discord_${ref.id}`,
            nick: ref.webhookId
              ? ref.author.username
              : `${ref.author.displayName} 🎮`,
            text: (ref.content || "").slice(0, 80),
          };
        }
      } catch (_) {}
    }

    await db.ref(`messages/${CHAT_CHANNEL}`).push({
      uid: discordUid, nick,
      content: message.content, type: "text",
      ts: Date.now(), fromDiscord: true,
      ...(replyTo ? { replyTo } : {}),
    });

    console.log(`   ✅ Firebase 저장 완료`);
  }
});

// ════════════════════════════════════
// 봇 준비
// ════════════════════════════════════
client.once(Events.ClientReady, (c) => {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log(`✅ 봇 로그인 완료: ${c.user.tag}`);

  const ch = c.channels.cache.get(DISCORD_CHANNEL);
  if (!ch) {
    console.warn(
      `⚠️  채널 ID '${DISCORD_CHANNEL}'를 찾을 수 없습니다.\n` +
      "   1) DISCORD_CHANNEL_ID 값이 정확한지 확인\n" +
      "   2) 봇이 해당 채널 보기 권한이 있는지 확인"
    );
  } else {
    console.log(`📌 감시 채널: #${ch.name} (${ch.id})`);
  }
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
});

// ════════════════════════════════════
// SIGTERM 처리 (Railway 재배포/종료 시 정상 종료)
//
// Railway는 컨테이너 종료 시 SIGTERM 전송
// 처리하지 않으면 npm이 에러로 기록하고 로그가 지저분해짐
// ════════════════════════════════════
function gracefulShutdown(signal) {
  console.log(`\n⚠️  ${signal} 수신 — 정상 종료 중...`);
  client.destroy();
  console.log("👋 봇 연결 종료 완료");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT",  () => gracefulShutdown("SIGINT"));  // Ctrl+C 로컬 테스트용

// 예기치 않은 에러로 봇 강제종료 방지
process.on("unhandledRejection", (err) => {
  console.error("❌ UnhandledRejection:", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("❌ UncaughtException:", err?.message || err);
});

client.login(DISCORD_TOKEN);
