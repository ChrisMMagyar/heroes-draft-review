# heroes-draft-review

Netlify site hosting the Telegram gateway for kraken_gateway_bot.

- Webhook: `netlify/functions/telegram-gateway.mts` at `/telegram-gateway`
- Photo intake (phase 1, off unless `INTAKE_ENABLED=true`): see [docs/telegram-intake.md](docs/telegram-intake.md)
  for every env var (names only), setup steps, the kill switch and rollback.

Development: `npm install`, `npm test`, `npm run typecheck`.

This repo is public: never commit secret values. All credentials live in Netlify env vars.
