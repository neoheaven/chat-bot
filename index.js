const { Client, GatewayIntentBits, Events } = require("discord.js");
const admin = require("firebase-admin");
const https = require("https");
const http  = require("http");

// ── 환경변수 ──
const DISCORD_TOKEN   = process.env.DISCORD_TOKEN;
const DISCORD_CHANNEL = process.env.DISCORD_CHANNEL_ID;
const WEBHOOK_URL     = process.env.DISCORD_WEBHOOK_URL;
const FIREBASE_DB_URL = process.env.FIREBASE_DB_URL;
const CHAT_CHANNEL    = process.env.CHAT_CHANNEL || "general";
const PORT            = process.env.PORT || 3000;

// ── Railway용 더미 HTTP 서버 (이게 없으면 Railway가 강제종료함) ──
http.createServer((req, res) => {
  res.writeHead(200);
  res.end("Bot is running!");
}).listen(PORT, () => {
  console.log(`🌐 HTTP 서버 실행 중 (포트 ${PORT})`);
});

// ── Firebase 초기화 ──
admin.initializeApp({
  credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, "\n"),
  }),
  databaseURL: FIREBASE_DB_URL,
});
const db = admin.database();

// ── Webhook 전송 (내장 https 모듈) ──
function sendWebhook(body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url  = new URL(WEBHOOK_URL);
    const req  = https.request({
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   "POST",
      headers:  {
        "Content-Type":   "application/json",
        "Content-Length": Buffer.byteLength(data),
      },
    }, res => {
      res.on("data", () => {});
      res.on("end", resolve);
    });
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

// ── Discord 봇 ──
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ── 앱 → 디스코드 ──
let isInit = true;
db.ref(`messages/${CHAT_CHANNEL}`)
  .limitToLast(1)
  .on("child_added", async (snap) => {
    if (isInit) return;
    const msg = snap.val();
    if (!msg || msg.fromDiscord) return;
    try {
      const body = {
        username:   `${msg.nick} (채팅앱)`,
        avatar_url: `https://ui-avatars.com/api/?name=${encodeURIComponent(msg.nick)}&background=5c6ef8&color=fff&rounded=true`,
      };
      if (msg.type === "image") {
        body.content = "📷 이미지를 보냈습니다";
        body.embeds  = [{ image: { url: msg.content } }];
      } else {
        body.content = msg.content;
      }
      await sendWebhook(body);
      console.log(`📤 앱→디코: [${msg.nick}] ${msg.type === "image" ? "이미지" : msg.content}`);
    } catch (e) {
      console.error("Webhook 전송 실패:", e.message);
    }
  });

setTimeout(() => {
  isInit = false;
  console.log("✅ Firebase 리스너 준비 완료");
}, 3000);

// ── 디스코드 → 앱 ──
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot) return;
  if (message.channelId !== DISCORD_CHANNEL) return;

  const nick = `${message.author.displayName} 💬`;
  console.log(`📥 디코→앱: [${nick}] ${message.content}`);

  if (message.attachments.size > 0) {
    message.attachments.forEach(att => {
      if (att.contentType?.startsWith("image/")) {
        db.ref(`messages/${CHAT_CHANNEL}`).push({
          uid: `discord_${message.author.id}`,
          nick, content: att.url, type: "image",
          ts: Date.now(), fromDiscord: true,
        });
      }
    });
  }

  if (message.content.trim()) {
    db.ref(`messages/${CHAT_CHANNEL}`).push({
      uid: `discord_${message.author.id}`,
      nick, content: message.content, type: "text",
      ts: Date.now(), fromDiscord: true,
    });
  }
});

// ── 봇 준비 ──
client.once(Events.ClientReady, () => {
  console.log(`✅ 봇 로그인 완료: ${client.user.tag}`);
  console.log(`📡 Firebase 채널: ${CHAT_CHANNEL}`);
  console.log(`💬 Discord 채널 ID: ${DISCORD_CHANNEL}`);
});

client.login(DISCORD_TOKEN);
