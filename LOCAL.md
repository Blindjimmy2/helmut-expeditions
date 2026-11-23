# Plate Transcriber — local Windows build

Ported from the Hatch space of the same name. Same chat UI, same
two-phase blind-first loop, running on localhost with zero platform
dependencies.

## Run it

```powershell
npm install
npm run build:client
npm start
```

Then open http://localhost:3105 in a browser.

Copy `.env.example` to `.env` and add keys:

- `MODEL_API_KEY` — required for phase 1 (blind transcription) and the
  phase-2 comparison. Anthropic by default, or any OpenAI-compatible
  vision endpoint via `MODEL_PROVIDER` / `MODEL_BASE_URL` / `MODEL_NAME`.
- `SEARCH_API_KEY` — Brave Search key for phase-2 web research. Without
  it, research runs with no sources and says so in the verdict summary
  instead of faking a "nothing published" result.

## What changed from the Hatch original

- `server/local/` is new: `sdk.ts` (tiny `defineAction`/`z` shim),
  `ctx.ts` (SQLite via node:sqlite + drizzle sqlite-proxy, file blobs,
  model + Brave search calls), `serve.ts` (static files + `/actions` RPC).
- `server/src/actions.ts`: import points at the local SDK shim; `.ts`
  extensions on relative imports (Node type-stripping); research notes
  explicitly when web search is unconfigured.
- `client/src/local.ts` replaces the Hatch client SDK (RPC proxy over
  fetch, `fileToBase64`, QueryClient, SafeArea stub). `api.ts`,
  `main.tsx`, `App.tsx` import from there; the Bun-only `actionFields`
  macro is replaced with plain input props.
- Build is Vite (`vite.config.ts`), output still `client/dist/`.
- Data stays local in ONE file: `app.db` holds the `runs` table plus a
  `blobs` table with the plate photos. No directories to set up. (The
  leftover Hatch `blobs/` dir is unused and can be deleted.)

## Sign-in (same setup as Bottom Drawer)

Email first, then the 6-digit code from the email. 30-day HttpOnly
session cookie, 10-minute codes, single-use, 5 verify attempts max,
rate-limited (5/hr per email, 25/hr per IP, 60s between sends).
Runs and photos belong to the signed-in user.

Env: `AUTH_PEPPER` (secret), `AUTH_FROM_EMAIL`, `RESEND_API_KEY`
for real emails. Without a Resend key, set `AUTH_DEV_PRINT_CODE=true`
to print codes to the server console (debug only — never in production).

## Usage & cost tracking

Every model call logs input/output/reasoning tokens + latency to
`usage_events`; every Brave call logs a `search` event. The dashboard
(visible when signed in) shows per-phase totals, per-run breakdown,
and live cost math from $/M-token rates you type in (kept in the
browser). Reasoning tokens count at output rates. Searches are flat
per-request — check the Brave plan for that line item.

## Billing (same setup as Bottom Drawer, per-user)

HelmutReads Researcher ($20/mo) + Institution ($100/mo) via Stripe
Checkout. Verified webhooks are the entitlement authority; on
localhost the Refresh-status button polls Stripe instead (Stripe
can't reach localhost). Free runs gate with a 402 paywall
(`FREE_RUN_LIMIT`, default 10 — tune from debug cost data); failed
runs refund the allowance. Customer portal for manage/cancel.

Env: `BILLING_MODE=test`, `STRIPE_SECRET_KEY`,
`STRIPE_RESEARCHER_PRICE`, `STRIPE_INSTITUTION_PRICE`,
`STRIPE_WEBHOOK_SECRET` (deploy time), `APP_ORIGIN`. Price
amounts/intervals are validated against Stripe on every checkout.

## Provenance tiers (checklist gate 3)

Every run carries a holding statement in one of three tiers:
*verified* (names a known collection), *claimed* (holding stated,
unchecked), *unknown* (nothing stated). Trusted submitters pass with
*verified*/*claimed* (claims logged as trust-attested); strangers go
to human review; silence quarantines — tool still works, checklist
never starts. Mark a user trusted with:
`UPDATE users SET trusted_submitter = 1 WHERE email = '...'`.
Gate tests: `npm test` (isolated temp DB, 11 checks).

## Deploying (Cloudflare)

One codebase, two hosts: `server/shared/*` holds all logic,
`server/local/*` binds Node+SQLite, `server/worker/*` binds
Workers+D1+R2+Email. See [DEPLOY.md](DEPLOY.md) for the runbook and
`DEPLOY_HELMUTREADS.bat` for one-shot deploys.

## Protocol preserved

Phase 1 receives only the image bytes (model API, no browsing, no
tools). Phase 2 refuses runs without a saved transcription. The UI
stepper still shows the order.
