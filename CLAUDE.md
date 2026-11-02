# CLAUDE.md — PropCall AI

Multi-tenant, Turkish-language AI cold-calling SaaS for real-estate consultants (KW Platin Karma).
Outbound calls via **Vapi**, prompt generation via **Anthropic**, ElevenLabs only for quota/cost display,
balance top-ups via **Fonzip**. Also: WhatsApp CRM/campaigns (Twilio, Meta templates, personal WA via
Baileys), Meta lead sync, Smart Plans scheduler, DNC list, roleplay practice calls.

UI text and code comments are **Turkish**.

## Commands

```bash
npm run dev     # ts-node-dev src/server.ts (needs DATABASE_URL)
npm run build   # tsc — this is also the only typecheck gate
npm start       # node dist/server.js
npm test        # Playwright E2E — runs against LIVE STAGING, see tests/README.md
docker compose up -d   # local Postgres 16 on host :5433 + app
```

No linter, no migration tool, no unit tests.

## Architecture

- **Backend:** Node 20, TypeScript (strict, CommonJS, `src` → `dist`), plain Express. Flat files in `src/`.
- **Frontend:** static vanilla JS/HTML in `public/` — no build step.
- **DB:** PostgreSQL via raw `pg` (no ORM). **Schema = idempotent DDL in `initDb()` in `src/db.ts`**
  (`CREATE TABLE IF NOT EXISTS` / `ADD COLUMN IF NOT EXISTS`), run at boot. Schema changes go there.
- **Auth:** email+password (scrypt), cookie `propcall_sid` → `user_sessions` (30d). `/admin` uses
  `ADMIN_PASSWORD` → `admin_sessions`. Stored API keys are encrypted (`src/crypto.ts`).

| Area | Where |
|---|---|
| All routes + boot-time intervals (stale-call reconcile, cleanup, Meta sync, Smart Plan scheduler) | `src/server.ts` (~2500 lines) |
| Vapi + webhook `POST /webhook/:userId` (legacy `POST /webhook` slated for removal) | `src/vapi.ts`, `src/calls.ts` |
| Campaign tick + calling hours / campaign CRUD / errors | `src/campaign.ts` / `src/campaigns.ts` / `src/campaignErrors.ts` |
| Prompts & scripts | `src/ai.ts`, `src/promptgen.ts`, `src/scenarios.ts`, `src/personas.ts`, `src/scriptRules.ts` |
| Payments (`POST /webhook/fonzip`, `/api/billing*`) | `src/fonzip.ts` |
| Leads / Meta / DNC | `src/leads.ts`, `src/metaLeads.ts`, `src/dncList.ts` |
| WhatsApp | `src/whatsapp*.ts` |

`fonzip` and `meta` are reserved path segments so `/webhook/:userId` can't shadow them.

## Deploy

Railway, built from the `Dockerfile` (port 3000); DB is Railway Postgres. No railway.json — config lives in
the Railway project. `trust proxy` is set for Railway's edge (login rate limit uses real client IP).
Env var names: see `.env.example`; more are read in code (`APP_URL`, `FONZIP_CLIENT_ID/SECRET`,
`META_WEBHOOK_VERIFY_TOKEN`, `DEFAULT_*_API_KEY`, `BOOTSTRAP_ADMIN_*`, `ROLEPLAY_FREE`).

## Gotchas

- **E2E tests hit live staging, sequentially (`workers: 1`, shared DB).** Never call routes that cost money
  or reach real people: `/api/call`, `/api/campaign/start|resume`, WhatsApp sends, template submit,
  personal WA connect. Full list in `tests/README.md`.
- **All time logic is `Europe/Istanbul`** (calling hours, day boundaries in `src/campaign.ts`).
- **Fonzip allows one active token** (2nd request → 409); it's cached in DB table `fonzip_config`, not memory.
- Webhooks (Vapi, Fonzip, Meta) need a public `APP_URL`; locally use the ngrok scripts or `cloudflared.exe`.
- Postgres SSL is disabled only when `DATABASE_URL` matches `localhost` or `@db:`. Pool size 20.
- `data/` holds legacy JSON files; `.replit*` files are leftovers.

## Git

Remote `MustafaCelen/propcall-ai`, branch `main`.
