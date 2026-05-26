# Fly.io Deployment

This project already has the files needed to run on Fly.io:

- `Dockerfile`
- `.dockerignore`
- `fly.toml`

## 1. Create the Fly app

Install and authenticate:

```bash
fly auth login
```

Create the app without deploying yet:

```bash
fly launch --no-deploy
```

Fly will block app creation until billing is enabled on the account. If app creation fails with a billing message, add a payment method in the Fly dashboard first, then rerun the command.

Use these choices:

- Reuse the existing `fly.toml`
- Do not create Postgres
- Do not create Redis

If `headlineodds-arena` is already taken, update the `app` value in `fly.toml` first.

## 2. Set secrets

Set every secret from your local `.env` that is not already hard-coded in `fly.toml`.

This repo includes a helper that stages Fly secrets from the local env file without printing secret values:

```bash
pnpm fly:secrets:dry-run
pnpm fly:secrets:stage
```

The helper:

- reads from `.env` by default
- skips keys already defined in `fly.toml`
- overrides `WEBHOOK_URL` and `PAJCASH_WEBHOOK_BASE_URL` to `https://<app>.fly.dev`
- stages secrets with `fly secrets import --stage`

If you want to use a different file, run the helper directly and pass `-EnvFile`:

```bash
powershell -ExecutionPolicy Bypass -File scripts/fly-stage-secrets.ps1 -EnvFile .env.example -DryRun
```

At minimum for production:

```bash
fly secrets set \
  BOT_TOKEN="..." \
  WEBHOOK_URL="https://<your-app>.fly.dev" \
  WEBHOOK_PATH_SECRET="..." \
  WEBHOOK_SECRET="..." \
  HEALTH_CHECK_TOKEN="..." \
  ADMIN_DASHBOARD_TOKEN="..." \
  ADMIN_USER_ID="..." \
  PAJCASH_API_KEY="..." \
  PAJCASH_SESSION_RECIPIENT="..." \
  PAJCASH_SESSION_TOKEN="..." \
  PAJCASH_SESSION_EXPIRES_AT="..." \
  PAJCASH_WEBHOOK_BASE_URL="https://<your-app>.fly.dev" \
  PAJCASH_WEBHOOK_PATH_SECRET="..." \
  PAJCASH_OTP="..." \
  PAJCASH_BUSINESS_USDC_FEE="..." \
  SUPABASE_URL="..." \
  SUPABASE_SERVICE_ROLE_KEY="..." \
  REDIS_URL="redis://..." \
  SOLANA_RPC_URL="..." \
  SOLANA_TREASURY_SECRET_KEY="..." \
  SOLANA_WALLET_ENCRYPTION_KEY="..." \
  DEXTOPUS_PARTNER_FEE_RECIPIENT="..." \
  GROQ_API_KEY="..."
```

Optional secrets if you use them:

```bash
fly secrets set \
  DEV_OVERRIDE_TG_IDS="..." \
  TESTER_ALLOWLIST="..."
```

Notes:

- `WEBHOOK_URL` must be the Fly hostname because [src/index.ts](C:/Users/USER/OneDrive/Desktop/fantasybot/src/index.ts:377) registers the Telegram webhook from that env var at startup.
- `PAJCASH_WEBHOOK_BASE_URL` should also move off the old Render domain.
- `HEALTH_CHECK_TOKEN` is required because [src/config.ts](C:/Users/USER/OneDrive/Desktop/fantasybot/src/config.ts:175) fails startup without it.

## 3. Deploy

```bash
fly deploy
```

Watch logs:

```bash
fly logs
```

## 4. Verify cutover

Confirm these after deploy:

1. `GET /` returns `200`.
2. `GET /health` with `x-health-check-token` returns `200`.
3. Logs show Redis startup ping succeeded.
4. Logs show the bot initialized and registered the webhook.
5. Logs show the fantasy and Solana monitors started.

Example health check:

```bash
curl -H "x-health-check-token: <token>" https://<your-app>.fly.dev/health
```

## 5. Decommission Render

Only remove the Render service after:

- Telegram messages are reaching Fly
- PajCash webhook deliveries are reaching Fly
- Scheduler logs are stable for at least one full cycle

If you leave Render active with the old webhook URL, updates can split across two deployments.
