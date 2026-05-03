const { Client, GatewayIntentBits } = require("discord.js");
const admin = require("firebase-admin");

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 환경변수 (Railway에서 설정)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const DISCORD_TOKEN    = process.env.DISCORD_TOKEN;       // 봇 토큰
const DISCORD_CHANNEL  = process.env.DISCORD_CHANNEL_ID;  // 연동할 채널 ID
const WEBHOOK_URL      = process.env.DISCORD_WEBHOOK_URL; // Webhook URL
const FIREBASE_DB_URL  = process.env.FIREBASE_DB_URL;     // DB URL
const CHAT_CHANNEL     = process.env.CHAT_CHANNEL || "general"; // 앱 채널명

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Firebase 초기화
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Discord 봇 초기화
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 앱 → 디스코드
// Firebase 새 메시지 감지 → Webhook으로 전송
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let isInit = true; // 서버 시작 시 기존 메시지 무시
db.ref(`messages/${CHAT_CHANNEL}`)
  .limitToLast(1)
  .on("child_added", async (snap) => {
    if (isInit) return; // 처음 로드는 건너뜀

    const msg = snap.val();
    if (!msg) return;
    if (msg.fromDiscord) return; // 디스코드에서 온 메시지는 다시 보내지 않음

    try {
      const body = {
        username: `${msg.nick} (채팅앱)`,
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.nick)}&background=5c6ef8&color=fff&rounded=true`,
      };

      if (msg.type === "image") {
        body.content = "📷 이미지를 보냈습니다";
        body.embeds = [{ image: { url: msg.content } }];
      } else {
        body.content = msg.content;
      }

      await fetch(WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.error("Webhook 전송 실패:", e.message);
    }
  });

// 초기 로드 완료 후 플래그 해제
setTimeout(() => { isInit = false; }, 3000);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 디스코드 → 앱
// 디스코드 메시지 감지 → Firebase에 쓰기
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
client.on("messageCreate", async (message) => {
  // 봇 메시지 무시, 지정 채널만 처리
  if (message.author.bot) return;
  if (message.channelId !== DISCORD_CHANNEL) return;

  const nick = `${message.author.displayName} 💬`;

  // 이미지 첨부 처리
  if (message.attachments.size > 0) {
    message.attachments.forEach(att => {
      if (att.contentType?.startsWith("image/")) {
        db.ref(`messages/${CHAT_CHANNEL}`).push({
          uid: `discord_${message.author.id}`,
          nick,
          content: att.url,
          type: "image",
          ts: Date.now(),
          fromDiscord: true,
        });
      }
    });
  }

  // 텍스트 메시지 처리
  if (message.content.trim()) {
    db.ref(`messages/${CHAT_CHANNEL}`).push({
      uid: `discord_${message.author.id}`,
      nick,
      content: message.content,
      type: "text",
      ts: Date.now(),
      fromDiscord: true,
    });
  }
});

client.once("ready", () => {
  console.log(`✅ 봇 로그인 완료: ${client.user.tag}`);
  console.log(`📡 Firebase 채널: ${CHAT_CHANNEL}`);
  console.log(`💬 Discord 채널 ID: ${DISCORD_CHANNEL}`);
});

client.login(DISCORD_TOKEN);
