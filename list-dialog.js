// list-dialogs.js
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

  console.log("📋 All your dialogs (channels, groups, DMs):\n");

  for await (const dialog of client.iterDialogs({})) {
    const type = dialog.entity?.className || "Unknown";
    const id = dialog.entity?.id?.toString() || "?";
    const name = dialog.name || "(no name)";
    const username = dialog.entity?.username ? `@${dialog.entity.username}` : "";

    // Highlight anything with "univest" in the name
    const flag = name.toLowerCase().includes("univest") ? " ⬅️  FOUND IT" : "";

    console.log(`[${type}] "${name}" ${username} | id: ${id}${flag}`);
  }

  await client.disconnect();
}

main().catch(console.error);