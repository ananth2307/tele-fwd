// check-access.js
require("dotenv").config();
const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");
const fs = require("fs");

const SESSION_FILE = ".telegram_session";
const session = new StringSession(
  (process.env.TELEGRAM_SESSION_STRING || fs.readFileSync(SESSION_FILE, "utf8")).trim()
);

async function main() {
  const client = new TelegramClient(
    session,
    parseInt(process.env.TELEGRAM_API_ID),
    process.env.TELEGRAM_API_HASH,
    { connectionRetries: 5 }
  );

  await client.connect();
  console.log("✅ Connected\n");

  const SOURCE = process.env.TELEGRAM_SOURCE_CHANNEL || "Univest Official";

  // 1. Can we resolve the channel at all?
  let entity;
  try {
    entity = await client.getEntity(SOURCE);
    console.log("✅ Entity resolved:");
    console.log("   ID:", entity.id?.toString());
    console.log("   Title:", entity.title);
    console.log("   Username:", entity.username || "none");
    console.log("   Type:", entity.className);
  } catch (err) {
    console.error("❌ Cannot resolve entity:", err.message);
    console.log("   → You may not be a member, or the name is wrong");
    await client.disconnect();
    return;
  }

  // 2. Can we actually fetch messages?
  try {
    const messages = await client.getMessages(entity, { limit: 5 });
    if (messages.length === 0) {
      console.log("⚠️  Channel exists but returned 0 messages (possibly restricted)");
    } else {
      console.log(`\n✅ Can read messages! Got ${messages.length} messages:`);
      for (const msg of messages) {
        console.log(`   [${msg.id}] ${msg.text?.slice(0, 80) || "(media/no text)"}`);
      }
    }
  } catch (err) {
    console.error("❌ Cannot fetch messages:", err.message);
    console.log("   → Channel may be restricted or require special access");
  }

  // 3. Check if we're actually a participant
  try {
    const participant = await client.invoke(
      new (require("telegram").Api.channels.GetParticipant)({
        channel: entity,
        participant: await client.getMe(),
      })
    );
    console.log("\n✅ Membership confirmed:", participant.participant?.className);
  } catch (err) {
    console.error("\n❌ Membership check failed:", err.message);
    console.log("   → Not a member or channel doesn't allow participant lookup");
  }

  // 4. Check if events will work (is it a broadcast channel or a group?)
  console.log("\n📋 Channel flags:");
  console.log("   broadcast (one-way channel):", entity.broadcast ?? "unknown");
  console.log("   megagroup:", entity.megagroup ?? "unknown");
  console.log("   restricted:", entity.restricted ?? "unknown");
  console.log("   scam:", entity.scam ?? "unknown");

  await client.disconnect();
}

main().catch(console.error);