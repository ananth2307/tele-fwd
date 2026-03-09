# Telegram Channel Forwarder (Railway Ready)

Forwards messages from one Telegram channel to your target channel.

Supports two modes:
- Live forward of every new message.
- HTTP trigger to forward only the latest message on demand.

## 1) Install

```bash
npm install
```

## 2) Configure env

Use `.env` locally. For Railway, set the same values in Railway Variables.

Required variables:
- `TELEGRAM_API_ID`
- `TELEGRAM_API_HASH`
- `TELEGRAM_ALERT_CHAT_ID`
- `TELEGRAM_SOURCE_CHANNEL`
- `TELEGRAM_SESSION_STRING` (required for Railway/non-interactive runtime)
- `TELEGRAM_USE_WSS` (`1` recommended)
- `TELEGRAM_CONNECT_TIMEOUT` (seconds, e.g. `30`)
- `ENABLE_LIVE_FORWARD` (`1` to auto-forward new messages, `0` to disable)
- `HTTP_PORT` (default `3000`, Railway can override with `PORT`)
- `FORWARD_ENDPOINT_TOKEN` (optional but recommended for endpoint auth)

## 3) Generate session string (one-time, local)

```bash
npm run session:generate
```

Copy output and set it in Railway as `TELEGRAM_SESSION_STRING`.

## 4) Run locally

```bash
npm start
```

## 5) Trigger latest message forward via endpoint

Health check:

```bash
curl http://localhost:3000/health
```

Forward latest message:

```bash
curl "http://localhost:3000/get-last-msg?token=change_me"
```

Or with header:

```bash
curl -H "x-forward-token: change_me" http://localhost:3000/get-last-msg
```

## 6) Deploy on Railway

1. Push this project to GitHub.
2. In Railway: `New Project` -> `Deploy from GitHub Repo`.
3. Add all env vars in Railway Variables (same as `.env`).
4. Deploy. Railway uses `railway.json` and runs `npm start`.

## Notes

- Telegram account used in session must have access to source channel.
- That account must have permission to post in destination channel.
