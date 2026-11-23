// Stripe hookup verifier — run from YOUR terminal (not the agent sandbox):
//   node scripts/verify-stripe.mjs
// Maps the two pasted price IDs to Researcher/Institution by their amounts,
// saves the mapping to .env, then runs a full test-checkout dry run and
// cleans up after itself (expires the session, deletes the test customer).
import * as path from "node:path";
import { readFileSync, writeFileSync } from "node:fs";
import { APP_ROOT, sqlite } from "../server/local/ctx.ts";
import { billingStatus, startCheckout, stripeClient } from "../server/local/billing.ts";

process.loadEnvFile(path.join(APP_ROOT, ".env"));
const stripe = stripeClient();

const seen = await stripe.prices.list({ limit: 20 });console.log("prices visible to this key:", seen.data.map((p) => p.id + "=" + p.unit_amount + p.currency).join(", ") || "(none)");
const ids = ["price_1Ue7VGCHzm3VJTCjXl9mxrLV", "price_1Ue7UuCHzm3VJTCjzuGTIQjX"];
const prices = [];
for (const id of ids) {
  const p = await stripe.prices.retrieve(id);
  prices.push({ id, amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval });
  console.log(id, "->", p.unit_amount, p.currency, p.recurring?.interval, "active=" + p.active, "live=" + p.livemode);
}
const researcher = prices.find((p) => p.amount === 2000);
const institution = prices.find((p) => p.amount === 10000);
if (!researcher || !institution || researcher.currency !== "usd" || institution.currency !== "usd") {
  throw new Error("Price mapping failed: expected $20.00 and $100.00 USD monthly prices.");
}
process.env.STRIPE_RESEARCHER_PRICE = researcher.id;
process.env.STRIPE_INSTITUTION_PRICE = institution.id;
const envPath = path.join(APP_ROOT, ".env");
let envText = readFileSync(envPath, "utf8");
envText = envText.replace("STRIPE_RESEARCHER_PRICE=", `STRIPE_RESEARCHER_PRICE=${researcher.id}`);
envText = envText.replace("STRIPE_INSTITUTION_PRICE=", `STRIPE_INSTITUTION_PRICE=${institution.id}`);
writeFileSync(envPath, envText);
console.log("mapped: researcher =", researcher.id, "| institution =", institution.id);

const UID = "user_stripe_probe";
const now = Math.floor(Date.now() / 1000);
sqlite.prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?,?,?,?)").run(UID, "sp@x.com", now, now);
const co = await startCheckout(UID, "sp@x.com", "researcher");
console.log("checkout url:", (co.url ?? "NONE").slice(0, 40) + "...");
console.log("plan after checkout (still free until paid):", billingStatus(UID).plan);
const brow = sqlite.prepare("SELECT stripe_customer_id, checkout_session_id FROM user_billing WHERE user_id = ?").get(UID);
await stripe.checkout.sessions.expire(brow.checkout_session_id);
await stripe.customers.del(brow.stripe_customer_id);
sqlite.exec("DELETE FROM user_billing WHERE user_id = 'user_stripe_probe'");
sqlite.exec("DELETE FROM users WHERE id = 'user_stripe_probe'");
console.log("cleaned (session expired, test customer deleted, rows removed)");
