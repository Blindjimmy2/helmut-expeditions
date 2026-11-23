# Deploying HelmutReads to Cloudflare

Same stack as Bottom Drawer: Worker + D1 + R2 + Email Sending, static
client served from the Worker. One codebase runs both localhost (Node +
SQLite) and production — `server/shared/*` holds the logic,
`server/local/*` and `server/worker/*` hold the platform bindings.

## One-time setup (your terminal — Cloudflare login lives there)

```powershell
cd "C:\Users\twill\Desktop\OPERATION MOONWORKS\05_ACTIVE_PROJECTS\INDIANA JONES\plate transcriber app"
npx wrangler login
npx wrangler d1 create helmut-reads
# -> paste the database_id into wrangler.jsonc
npx wrangler r2 bucket create helmut-reads-files
npx wrangler secret put AUTH_PEPPER
npx wrangler secret put MODEL_API_KEY
npx wrangler secret put SEARCH_API_KEY
npx wrangler secret put STRIPE_SECRET_KEY
# use the LIVE sk_live_ key
npx wrangler secret put STRIPE_WEBHOOK_SECRET
# create after the webhook endpoint exists (below), then put it
```

Then in `wrangler.jsonc`, replace the two `FILL-ME` price IDs with the
**live** Researcher ($20) and Institution ($100) price IDs from the
Stripe dashboard. (Test IDs stay in local `.env` only.)

## Custom domain

In the Cloudflare dashboard: Workers & Pages → helmut-reads →
Settings → Domains & Routes → Add custom domain → `helmutreads.com`
(and `www` if wanted). DNS is already on Cloudflare, so this attaches
directly. HTTPS is automatic.

## Stripe webhook (after first deploy)

1. Stripe dashboard (LIVE mode) → Developers → Webhooks → Add endpoint:
   `https://helmutreads.com/billing/webhook`
2. Subscribe to: `checkout.session.completed`,
   `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired`,
   `customer.subscription.created/updated/deleted/paused/resumed`,
   `invoice.paid`, `invoice.payment_failed`,
   `invoice.payment_action_required`.
3. Copy the signing secret → `npx wrangler secret put STRIPE_WEBHOOK_SECRET`
4. Redeploy (or it picks up on next deploy — secrets are live immediately).

## Email sending

Bottom Drawer's account already uses Email Sending. Confirm
`helmutreads.com` is authorized to send (Cloudflare dashboard → Email),
and that `login@helmutreads.com` matches `AUTH_FROM_EMAIL`. Add the
SPF/DKIM records Cloudflare shows you.

## Every deploy

Run `DEPLOY_HELMUTREADS.bat`. It installs, tests, typechecks, builds
the client, migrates D1, and deploys. Then run the checklist it prints.

## Rollback

`npx wrangler rollback` (or Deployments → Rollback in the dashboard).
D1 migrations are additive — never edit an applied migration, always
add a new one.
