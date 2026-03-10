#!/usr/bin/env node

/**
 * Listen to a Telegram channel and forward every new message to another channel.
 *
 * Env vars:
 *   TELEGRAM_API_ID=34475076
 *   TELEGRAM_API_HASH=...
 *   TELEGRAM_ALERT_CHAT_ID=-1002853790251
 *   TELEGRAM_SOURCE_CHANNEL=-1001983880498   (optional, defaults to Univest Official ID)
 *   TELEGRAM_SESSION_STRING="..."            (optional; saved to .telegram_session if absent)
 *   ENABLE_LIVE_FORWARD=1                    (set to 0 to disable live forwarding)
 *   POLLING_INTERVAL_MS=30000               (polling fallback interval, default 30s)
 */

const fs = require("fs");
const http = require("http");
const path = require("path");
const readline = require("readline/promises");
const { URL } = require("url");
const { stdin: input, stdout: output } = require("process");
require("dotenv").config();

const { TelegramClient } = require("telegram");
const { Api } = require("telegram");
const { StringSession } = require("telegram/sessions");
const { NewMessage } = require("telegram/events");

// Use channel ID instead of name — much more reliable
const SOURCE_CHANNEL = process.env.TELEGRAM_SOURCE_CHANNEL || "-1001983880498";
const SESSION_FILE = path.join(process.cwd(), ".telegram_session");

function requiredEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function cleanSession(value) {
  return (value || "").trim().replace(/^['"]|['"]$/g, "");
}

async function resolveSourceEntity(client, source) {
  try {
    return await client.getEntity(source);
  } catch {
    // Fallback to exact dialog title match
  }

  for await (const dialog of client.iterDialogs({})) {
    if (dialog?.name === source) return dialog.entity;
  }

  throw new Error(
    `Could not resolve source channel '${source}'. Ensure this account can access it and title is exact.`
  );
}

async function getChannelDetails(client, sourceEntity) {
  try {
    const inputChannel = await client.getInputEntity(sourceEntity);
    const full = await client.invoke(new Api.channels.GetFullChannel({ channel: inputChannel }));
    const chat = full.chats && full.chats.length ? full.chats[0] : sourceEntity;
    const about = full.fullChat?.about || "";
    const participantsCount = full.fullChat?.participantsCount;
    return { chat, about, participantsCount };
  } catch {
    return { chat: sourceEntity, about: "", participantsCount: undefined };
  }
}

async function promptText(rl, question) {
  const value = await rl.question(question);
  return value.trim();
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

async function main() {
  const apiIdRaw = requiredEnv("TELEGRAM_API_ID");
  const apiHash = requiredEnv("TELEGRAM_API_HASH");
  const targetChatIdRaw = requiredEnv("TELEGRAM_ALERT_CHAT_ID");
  const useWSS = (process.env.TELEGRAM_USE_WSS || "1").trim() !== "0";
  const connectTimeoutSeconds = Number.parseInt(process.env.TELEGRAM_CONNECT_TIMEOUT || "30", 10);
  const endpointPort = Number.parseInt(process.env.HTTP_PORT || process.env.PORT || "3000", 10);
  const endpointToken = (process.env.FORWARD_ENDPOINT_TOKEN || "").trim();
  const enableLiveForward = (process.env.ENABLE_LIVE_FORWARD || "1").trim() !== "0";
  const pollingIntervalMs = Number.parseInt(process.env.POLLING_INTERVAL_MS || "30000", 10);

  const apiId = Number.parseInt(apiIdRaw, 10);
  if (!Number.isInteger(apiId)) throw new Error("TELEGRAM_API_ID must be an integer");

  const targetChatId = Number.parseInt(targetChatIdRaw, 10);
  if (!Number.isInteger(targetChatId)) {
    throw new Error("TELEGRAM_ALERT_CHAT_ID must be an integer like -1001234567890");
  }
  if (!Number.isInteger(connectTimeoutSeconds) || connectTimeoutSeconds < 1) {
    throw new Error("TELEGRAM_CONNECT_TIMEOUT must be a positive integer");
  }
  if (!Number.isInteger(endpointPort) || endpointPort < 1 || endpointPort > 65535) {
    throw new Error("HTTP_PORT/PORT must be a valid port number");
  }

  const sessionFromEnv = cleanSession(
    process.env.TELEGRAM_SESSION_STRING || process.env.TELEGRAM_STRING_SESSION || ""
  );
  const sessionFromFile = fs.existsSync(SESSION_FILE)
    ? cleanSession(fs.readFileSync(SESSION_FILE, "utf8"))
    : "";
  const stringSession = new StringSession(sessionFromEnv || sessionFromFile || "");

  const client = new TelegramClient(stringSession, apiId, apiHash, {
    useWSS,
    timeout: connectTimeoutSeconds,
    connectionRetries: 20,
    requestRetries: 10,
    retryDelay: 2000,
    sequentialUpdates: true, // Ensures updates are processed in order
  });

  const hasSession = Boolean(sessionFromEnv || sessionFromFile);
  let authorized = false;

  if (!hasSession && !input.isTTY) {
    throw new Error(
      "No TELEGRAM_SESSION_STRING found for non-interactive runtime. " +
        "Generate it locally and set it in Railway variables."
    );
  }

  if (hasSession) {
    await client.connect();
    authorized = await client.checkAuthorization();
  }

  if (!authorized) {
    if (!input.isTTY) {
      throw new Error(
        "Provided TELEGRAM_SESSION_STRING is invalid or expired. Generate a new one and redeploy."
      );
    }

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
  }

  const sessionString = client.session.save();
  if (!sessionFromEnv && sessionString) {
    fs.writeFileSync(SESSION_FILE, sessionString, { encoding: "utf8", mode: 0o600 });
  }

  const me = await client.getMe();
  const sourceEntity = await resolveSourceEntity(client, SOURCE_CHANNEL);
  const channelDetails = await getChannelDetails(client, sourceEntity);
  const sourceChat = channelDetails.chat || sourceEntity;

  // FIX: Use raw positive ID (sourceEntity.id) for event comparison.
  // utils.getPeerId() returns the -100 prefixed version, but event.chatId
  // is always the raw positive ID — so they would never match.
  const sourceRawId = BigInt(sourceEntity.id);

  const sourceTitle = sourceChat.title || SOURCE_CHANNEL;
  const sourceUsername = sourceChat.username ? `@${sourceChat.username}` : "N/A";
  const sourceMembers =
    typeof channelDetails.participantsCount === "number"
      ? channelDetails.participantsCount.toString()
      : "unavailable";

  console.log(`Logged in as: ${me.username || me.id}`);
  console.log("Listening channel details:");
  console.log(`- Name: ${sourceTitle}`);
  console.log(`- Username: ${sourceUsername}`);
  console.log(`- Raw ID: ${sourceRawId.toString()}`);
  console.log(`- Members/Subscribers: ${sourceMembers}`);
  if (channelDetails.about) {
    console.log(`- About: ${channelDetails.about}`);
  }
  console.log(`Forwarding to chat id: ${targetChatId}`);
  console.log(`Live forward mode: ${enableLiveForward ? "enabled" : "disabled"}`);

  // ─── Forward helpers ────────────────────────────────────────────────────────

  async function forwardLastMessage() {
    const messages = await client.getMessages(sourceEntity, { limit: 1 });
    const lastMessage = messages && messages.length ? messages[0] : null;
    if (!lastMessage) {
      return { forwarded: false, reason: "No messages found in source channel" };
    }
    await client.forwardMessages(targetChatId, {
      messages: [lastMessage.id],
      fromPeer: sourceEntity,
    });
    return { forwarded: true, messageId: lastMessage.id };
  }

  // ─── Live event-based forwarding ────────────────────────────────────────────

  if (enableLiveForward) {
    client.addEventHandler(
      async (event) => {
        // Debug: log every incoming event so we can confirm events are firing
        console.log(
          "RAW EVENT — chatId:",
          event.chatId?.toString() ?? "undefined",
          "| sourceRawId:",
          sourceRawId.toString()
        );

        try {
          // Guard: must have a message and a chatId
          if (!event.message || event.chatId == null) return;

          // FIX: Compare raw positive IDs (no -100 prefix on event.chatId)
          if (BigInt(event.chatId) !== sourceRawId) return;

          // Confirm it's a channel/supergroup peer (not a DM or group)
          const peer = event.message.peerId;
          const isChannelMsg =
            peer?.className === "PeerChannel" || peer?.className === "PeerChat";
          if (!isChannelMsg) return;

          await client.forwardMessages(targetChatId, {
            messages: [event.message.id],
            fromPeer: sourceEntity,
          });
          console.log(`✅ Forwarded live message id ${event.message.id}`);
        } catch (err) {
          console.error(
            `❌ Failed to forward live message id ${event.message?.id}:`,
            err?.message || err
          );
        }
      },
      new NewMessage({})
    );

    console.log("👂 Live event listener registered.");
  }

  // ─── Polling fallback ────────────────────────────────────────────────────────
  // Broadcast channels sometimes throttle MTProto update delivery.
  // This polling loop catches anything the event handler misses.

  let lastSeenMessageId = null;

  // Seed the last seen ID on startup so we don't re-forward old messages
  try {
    const seedMessages = await client.getMessages(sourceEntity, { limit: 1 });
    if (seedMessages && seedMessages.length) {
      lastSeenMessageId = seedMessages[0].id;
      console.log(`📌 Polling seeded at message id: ${lastSeenMessageId}`);
    }
  } catch (err) {
    console.warn("Could not seed last message id for polling:", err?.message || err);
  }

  setInterval(async () => {
    try {
      const messages = await client.getMessages(sourceEntity, { limit: 1 });
      if (!messages || !messages.length) return;

      const latest = messages[0];
      if (lastSeenMessageId === null || latest.id > lastSeenMessageId) {
        console.log(`📡 Polling detected new message id ${latest.id} — forwarding...`);
        await client.forwardMessages(targetChatId, {
          messages: [latest.id],
          fromPeer: sourceEntity,
        });
        console.log(`✅ Polling forwarded message id ${latest.id}`);
        lastSeenMessageId = latest.id;
      }
    } catch (err) {
      console.error("Polling error:", err?.message || err);
    }
  }, pollingIntervalMs);

  console.log(`🔄 Polling fallback active every ${pollingIntervalMs / 1000}s`);

  // ─── HTTP endpoint ───────────────────────────────────────────────────────────

  const server = http.createServer(async (req, res) => {
    try {
      const host = req.headers.host || `127.0.0.1:${endpointPort}`;
      const url = new URL(req.url || "/", `http://${host}`);
      const method = req.method || "GET";

      if (url.pathname === "/health") {
        return sendJson(res, 200, { ok: true });
      }

      if (url.pathname !== "/get-last-msg") {
        return sendJson(res, 404, { ok: false, error: "Not found" });
      }

      if (method !== "GET" && method !== "POST") {
        return sendJson(res, 405, { ok: false, error: "Use GET or POST" });
      }

      const providedToken = (
        url.searchParams.get("token") ||
        req.headers["x-forward-token"] ||
        ""
      ).toString();
      if (endpointToken && providedToken !== endpointToken) {
        return sendJson(res, 401, { ok: false, error: "Unauthorized" });
      }

      const result = await forwardLastMessage();
      if (result.forwarded) {
        console.log(`Forwarded latest message via endpoint: ${result.messageId}`);
      } else {
        console.log(`Endpoint hit but nothing forwarded: ${result.reason}`);
      }
      return sendJson(res, 200, { ok: true, ...result });
    } catch (err) {
      console.error("Endpoint error:", err?.message || err);
      return sendJson(res, 500, { ok: false, error: err?.message || String(err) });
    }
  });

  server.listen(endpointPort, "0.0.0.0", () => {
    console.log(`🌐 HTTP endpoint listening on port ${endpointPort}`);
    console.log("   GET /health        → health check");
    console.log("   GET /get-last-msg  → manually trigger forward of latest message");
  });

  console.log("✅ Service is running. Press Ctrl+C to stop.");
}

main().catch((err) => {
  console.error("Error:", err?.message || err);
  process.exit(1);
});