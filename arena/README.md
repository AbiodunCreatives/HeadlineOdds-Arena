# HeadlineOdds Arena Mini App

This directory is now a single-purpose Telegram mini app for live BTC arena trading.

## Routes

- `/` - trade mini app
- `/trade` - trade mini app alias used by the bot

Both routes render the same UI.

## Required environment variable

Set this in Vercel before deploying:

```bash
NEXT_PUBLIC_BOT_API_URL=https://headlineodds-arena.fly.dev
```

The mini app uses that backend for `/api/trade-state`.
The redesigned mini app now loads from `/api/miniapp-state`, which includes live Bayse round data plus optional arena-specific trade state when opened with an arena code.

## Local commands

```bash
npm install
npm run typecheck
npm run build
```

## Deployment

Deploy `arena/` as its own Vercel project with `arena` as the root directory.

After Vercel gives you the frontend URL, set `ARENA_URL` on the Fly bot so Telegram opens the mini app from the Trade button.
