#!/usr/bin/env node

const readline = require("readline/promises");
const { stdin: input, stdout: output } = require("process");
require("dotenv").config();

const { TelegramClient } = require("telegram");
const { StringSession } = require("telegram/sessions");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

async function promptText(rl, question) {
  const value = await rl.question(question);
  return value.trim();
}

async function main() {
  const apiId = Number.parseInt(requiredEnv("TELEGRAM_API_ID"), 10);
  const apiHash = requiredEnv("TELEGRAM_API_HASH");
  const useWSS = (process.env.TELEGRAM_USE_WSS || "1").trim() !== "0";
  const connectTimeoutSeconds = Number.parseInt(process.env.TELEGRAM_CONNECT_TIMEOUT || "30", 10);

  if (!Number.isInteger(apiId)) {
    throw new Error("TELEGRAM_API_ID must be an integer");
  }
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1) {
    throw new Error("TELEGRAM_CONNECT_TIMEOUT must be a positive integer");
  }

  const client = new TelegramClient(new StringSession(""), apiId, apiHash, {
    useWSS,
    timeout: connectTimeoutSeconds,
    connectionRetries: 20,
    requestRetries: 10,
    retryDelay: 2000,
  });

  const rl = readline.createInterface({ input, output });
  try {
    await client.start({
      phoneNumber: async () => promptText(rl, "Phone number (with country code): "),
      password: async () => promptText(rl, "2FA password (if enabled): "),
      phoneCode: async () => promptText(rl, "Login code from Telegram: "),
      onError: (err) => console.error("Auth error:", err?.message || err),
    });
  } finally {
    rl.close();
  }

  const sessionString = client.session.save();
  console.log("\nCopy this into Railway variable TELEGRAM_SESSION_STRING:\n");
  console.log(sessionString);

  await client.disconnect();
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});
