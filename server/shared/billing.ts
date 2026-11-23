// Stripe billing: HelmutReads Researcher ($20/mo) + Institution ($100/mo).
// Ported from Bottom Drawer's src/billing.js, per-user instead of per-home.
// Host-agnostic: storage/env come through the Platform argument.
import Stripe from "stripe";
import type { Platform } from "./platform";

export const WEBHOOK_EVENTS = [
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
];

export type Plan = "researcher" | "institution";

const terminal = new Set(["canceled", "incomplete_expired"]);
const seconds = () => Math.floor(Date.now() / 1000);
const objectId = (v: unknown): string | null => (typeof v === "string" ? v : (v as { id?: string } | null)?.id ?? null);

export function billingError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

function liveMode(p: Platform): boolean {
  return p.env.get("BILLING_MODE") === "live";
}

function validMode(p: Platform): boolean {
  const m = p.env.get("BILLING_MODE") || "test";
  return m === "test" || m === "live";
}

function keyMatchesMode(p: Platform): boolean {
  const key = p.env.get("STRIPE_SECRET_KEY");
  return liveMode(p) ? /^(rk|sk)_live_/.test(key) : /^(rk|sk)_test_/.test(key);
}

export function stripeClient(p: Platform): Stripe {
  if (!validMode(p) || !keyMatchesMode(p)) {
    throw new Error("Stripe credentials do not match BILLING_MODE.");
  }
  return new Stripe(p.env.get("STRIPE_SECRET_KEY"), { timeout: 10000, maxNetworkRetries: 1, httpClient: Stripe.createFetchHttpClient() });
}

function assertStripeMode<T extends { livemode?: boolean }>(p: Platform, obj: T): T {
  if (obj?.livemode !== liveMode(p)) {
    throw new Error(`Refusing Stripe data from the wrong mode (expected ${p.env.get("BILLING_MODE") || "test"}).`);
  }
  return obj;
}

export interface BillingRow {
  user_id: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  plan: string;
  subscription_status: string;
  paid_until: number;
  cancel_at_period_end: number;
  beta_access: number;
  runs_used: number;
  checkout_session_id: string | null;
  checkout_attempt: string | null;
  checkout_plan: string | null;
  checkout_started: number | null;
  lock_token: string | null;
  lock_until: number;
  updated_at: number;
}

export async function billingRow(p: Platform, userId: string): Promise<BillingRow> {
  await p.raw.prepare("INSERT OR IGNORE INTO user_billing (user_id) VALUES (?)").run(userId);
  return (await p.raw.prepare("SELECT * FROM user_billing WHERE user_id = ?").get(userId)) as unknown as BillingRow;
}

export const isPaid = (row: BillingRow, at = seconds()): boolean =>
  ["active", "trialing"].includes(row.subscription_status) && row.paid_until > at;

export function freeRunLimit(p: Platform): number {
  return Number(p.env.get("FREE_RUN_LIMIT") || 10);
}

export async function billingStatus(p: Platform, userId: string): Promise<{
  mode: string;
  paid: boolean;
  betaAccess: boolean;
  plan: string;
  subscriptionStatus: string;
  paidUntil: number;
  cancelAtPeriodEnd: boolean;
  canManage: boolean;
  configured: boolean;
  freeRuns: number;
}> {
  const r = await billingRow(p, userId);
  return {
    mode: p.env.get("BILLING_MODE") || "test",
    paid: isPaid(r),
    betaAccess: !!r.beta_access,
    plan: r.plan,
    subscriptionStatus: r.subscription_status,
    paidUntil: r.paid_until,
    cancelAtPeriodEnd: !!r.cancel_at_period_end,
    canManage: !!r.stripe_customer_id,
    configured: validMode(p) && keyMatchesMode(p) && !!p.env.get("STRIPE_WEBHOOK_SECRET"),
    freeRuns: Math.max(0, freeRunLimit(p) - r.runs_used),
  };
}

/** Reserve one free run atomically; failures return the allowance. Paid/beta skip the counter. */
export async function withAllowance<T>(p: Platform, userId: string, run: () => Promise<T>): Promise<T> {
  const r = await billingRow(p, userId);
  if (r.beta_access || isPaid(r)) return run();
  const limit = freeRunLimit(p);
  const reserved = await p.raw
    .prepare("UPDATE user_billing SET runs_used = runs_used + 1 WHERE user_id = ? AND runs_used < ?")
    .run(userId, limit);
  if (!reserved.changes) {
    throw billingError("Your free runs are used. Choose a HelmutReads plan to keep transcribing.", 402);
  }
  try {
    return await run();
  } catch (err) {
    await p.raw.prepare("UPDATE user_billing SET runs_used = MAX(0, runs_used - 1) WHERE user_id = ?").run(userId);
    throw err;
  }
}

async function locked<T>(p: Platform, userId: string, action: (token: string) => Promise<T>): Promise<T> {
  await billingRow(p, userId);
  const token = crypto.randomUUID();
  const t = seconds();
  const res = await p.raw
    .prepare("UPDATE user_billing SET lock_token = ?, lock_until = ? WHERE user_id = ? AND lock_until < ?")
    .run(token, t + 120, userId, t);
  if (!res.changes) throw billingError("Billing is updating. Try again in a few seconds.", 409);
  try {
    return await action(token);
  } finally {
    await p.raw
      .prepare("UPDATE user_billing SET lock_token = NULL, lock_until = 0 WHERE user_id = ? AND lock_token = ?")
      .run(userId, token);
  }
}

async function saveLocked(p: Platform, userId: string, token: string, sql: string, values: unknown[]): Promise<void> {
  const r = await p.raw
    .prepare(`UPDATE user_billing SET ${sql}, updated_at = ? WHERE user_id = ? AND lock_token = ? AND lock_until > ?`)
    .run(...(values as (string | number)[]), seconds(), userId, token, seconds());
  if (!r.changes) throw new Error("Billing lease expired; retry required.");
}

function priceFor(p: Platform, plan: Plan): string {
  const id = p.env.get(plan === "institution" ? "STRIPE_INSTITUTION_PRICE" : "STRIPE_RESEARCHER_PRICE");
  if (!id) throw billingError("Billing prices are not configured on this server.", 503);
  return id;
}

async function validatePrices(p: Platform, stripe: Stripe): Promise<void> {
  const checks: [string, number][] = [
    [p.env.get("STRIPE_RESEARCHER_PRICE"), 2000],
    [p.env.get("STRIPE_INSTITUTION_PRICE"), 10000],
  ];
  for (const [id, amount] of checks) {
    if (!id) throw billingError("Billing prices are not configured on this server.", 503);
    const price = assertStripeMode(p, await stripe.prices.retrieve(id));
    if (!price.active || price.currency !== "usd" || price.unit_amount !== amount || price.recurring?.interval !== "month" || price.recurring.interval_count !== 1) {
      throw new Error("Incorrect HelmutReads Stripe prices for the configured billing mode.");
    }
  }
}

function appOrigin(p: Platform): string {
  return (p.env.get("APP_ORIGIN") || "http://localhost:3105").replace(/\/+$/, "");
}

export async function startCheckout(
  p: Platform,
  userId: string,
  email: string,
  plan: Plan,
): Promise<{ url: string | null }> {
  if (!p.env.get("STRIPE_WEBHOOK_SECRET") && !p.env.get("STRIPE_SECRET_KEY")) {
    throw billingError("Billing is still being configured.", 503);
  }
  const stripe = stripeClient(p);
  return locked(p, userId, async (token) => {
    const row = await billingRow(p, userId);
    await validatePrices(p, stripe);
    if (!row.stripe_customer_id) {
      const c = assertStripeMode(
        p,
        await stripe.customers.create(
          { email, metadata: { app: "helmut_reads", user_id: userId } },
          { idempotencyKey: `helmutreads-customer-${userId}` },
        ),
      );
      await saveLocked(p, userId, token, "stripe_customer_id = ?", [c.id]);
      row.stripe_customer_id = c.id;
    }
    const subs = await stripe.subscriptions.list({ customer: row.stripe_customer_id, status: "all", limit: 100 });
    if (subs.data.some((s) => !terminal.has(assertStripeMode(p, s).status))) {
      throw billingError("This account already has a subscription or pending payment. Use Manage billing.", 409);
    }
    if (row.checkout_session_id) {
      const s = assertStripeMode(p, await stripe.checkout.sessions.retrieve(row.checkout_session_id));
      if (s.status === "open" && row.checkout_plan === plan) return { url: s.url };
      if (s.status === "complete") {
        const subId = objectId(s.subscription);
        const sub = subId && assertStripeMode(p, await stripe.subscriptions.retrieve(subId));
        if (!sub || !terminal.has(sub.status)) {
          throw billingError("Payment is processing. Please wait for confirmation.", 409);
        }
      }
      if (s.status === "open") await stripe.checkout.sessions.expire(s.id);
      row.checkout_attempt = null;
    }
    if (!row.checkout_attempt || row.checkout_plan !== plan || (row.checkout_started ?? 0) < seconds() - 1800) {
      row.checkout_attempt = crypto.randomUUID();
      row.checkout_started = seconds();
      row.checkout_plan = plan;
      await saveLocked(p, userId, token, "checkout_attempt = ?, checkout_started = ?, checkout_plan = ?, checkout_session_id = NULL", [
        row.checkout_attempt,
        row.checkout_started,
        plan,
      ]);
    }
    const session = assertStripeMode(
      p,
      await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: row.stripe_customer_id,
          client_reference_id: userId,
          line_items: [{ price: priceFor(p, plan), quantity: 1 }],
          subscription_data: { metadata: { app: "helmut_reads", user_id: userId, plan } },
          payment_method_collection: "always",
          metadata: { app: "helmut_reads", user_id: userId, plan },
          success_url: `${appOrigin(p)}/?billing=success&session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${appOrigin(p)}/?billing=cancel`,
          expires_at: row.checkout_started! + 1860,
          allow_promotion_codes: true,
        },
        { idempotencyKey: `helmutreads-checkout-v1-${row.checkout_attempt}` },
      ),
    );
    await saveLocked(p, userId, token, "checkout_session_id = ?", [session.id]);
    return { url: session.url };
  });
}

export async function customerPortal(p: Platform, userId: string): Promise<{ url: string }> {
  const row = await billingRow(p, userId);
  if (!row.stripe_customer_id) throw billingError("This account does not have billing set up yet.", 409);
  const params: Stripe.BillingPortal.SessionCreateParams = {
    customer: row.stripe_customer_id,
    return_url: `${appOrigin(p)}/?billing=return`,
  };
  const config = p.env.get("STRIPE_PORTAL_CONFIGURATION");
  if (config) params.configuration = config;
  const s = await stripeClient(p).billingPortal.sessions.create(params);
  return { url: s.url };
}

export function subscriptionState(
  p: Platform,
  sub: Stripe.Subscription,
  row: BillingRow,
): { plan: string; status: Stripe.Subscription.Status; paidUntil: number; cancelAtPeriodEnd: number } | null {
  assertStripeMode(p, sub);
  if (objectId(sub.customer) !== row.stripe_customer_id) return null;
  const item = sub.items?.data?.find((i) =>
    [p.env.get("STRIPE_RESEARCHER_PRICE"), p.env.get("STRIPE_INSTITUTION_PRICE")].includes(i.price?.id),
  );
  if (!item || sub.items.data.length !== 1) {
    return { plan: "free", status: sub.status, paidUntil: 0, cancelAtPeriodEnd: 0 };
  }
  const plan = item.price.id === p.env.get("STRIPE_INSTITUTION_PRICE") ? "institution" : "researcher";
  const inv = sub.latest_invoice;
  const paid =
    !!inv && typeof inv !== "string" && inv.status === "paid" && objectId(inv.customer) === row.stripe_customer_id;
  let until = 0;
  if ((sub.status === "active" || sub.status === "trialing") && paid) until = item.current_period_end || 0;
  const cancelAt = (sub as { cancel_at?: number | null }).cancel_at ?? null;
  if (cancelAt) until = Math.min(until, cancelAt);
  if (sub.pause_collection) until = 0;
  return { plan, status: sub.status, paidUntil: until, cancelAtPeriodEnd: sub.cancel_at_period_end || cancelAt ? 1 : 0 };
}

/** Debug/localhost alternative to webhooks: poll Stripe for the latest state. */
export async function syncBilling(p: Platform, userId: string): Promise<Awaited<ReturnType<typeof billingStatus>>> {
  const stripe = stripeClient(p);
  return locked(p, userId, async (token) => {
    const row = await billingRow(p, userId);
    let subId: string | null = row.stripe_subscription_id;
    if (row.checkout_session_id) {
      const s = assertStripeMode(p, await stripe.checkout.sessions.retrieve(row.checkout_session_id));
      if (s.status === "complete" && ["paid", "no_payment_required"].includes(s.payment_status ?? "")) {
        subId = objectId(s.subscription);
      }
    }
    if (subId) {
      const sub = assertStripeMode(p, await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] }));
      const state = subscriptionState(p, sub, row);
      if (state) {
        await saveLocked(
          p,
          userId,
          token,
          "stripe_subscription_id = ?, plan = ?, subscription_status = ?, paid_until = ?, cancel_at_period_end = ?",
          [sub.id, state.plan, state.status, state.paidUntil, state.cancelAtPeriodEnd],
        );
      }
    }
    return billingStatus(p, userId);
  });
}

export async function handleWebhook(
  p: Platform,
  rawBody: string,
  signature: string,
): Promise<{ received: boolean; ignored?: boolean; duplicate?: boolean }> {
  if (!validMode(p) || !p.env.get("STRIPE_WEBHOOK_SECRET")) {
    throw billingError("Webhook not configured.", 503);
  }
  if (rawBody.length > 1048576) throw billingError("Payload too large.", 413);
  const stripe = stripeClient(p);
  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, p.env.get("STRIPE_WEBHOOK_SECRET"));
  } catch {
    throw billingError("Invalid webhook signature or configuration.", 400);
  }
  const accountId = p.env.get("STRIPE_ACCOUNT_ID");
  if (event.livemode !== liveMode(p) || (accountId && event.account && event.account !== accountId)) {
    throw billingError("Stripe event does not match the configured account or mode.", 400);
  }
  if (!WEBHOOK_EVENTS.includes(event.type)) return { received: true, ignored: true };
  const dup = await p.raw.prepare("SELECT event_id FROM billing_events WHERE event_id = ?").get(event.id);
  if (dup) return { received: true, duplicate: true };
  const obj = event.data.object as { customer?: unknown; subscription?: unknown };
  const customerId = objectId(obj.customer);
  if (!customerId) return { received: true, ignored: true };
  const row = (await p.raw.prepare("SELECT * FROM user_billing WHERE stripe_customer_id = ?").get(customerId)) as unknown as
    | BillingRow
    | undefined;
  if (!row) return { received: true, ignored: true };

  return locked(p, row.user_id, async (token) => {
    const current = await billingRow(p, row.user_id);
    let subId: string | null = event.type.startsWith("customer.subscription.")
      ? ((obj as { id?: string }).id ?? null)
      : objectId(obj.subscription);
    if (event.type.startsWith("checkout.session.")) {
      const paymentStatus = (obj as { payment_status?: string }).payment_status;
      if (!["paid", "no_payment_required"].includes(paymentStatus ?? "")) subId = null;
    }
    if (subId) {
      const sub = assertStripeMode(p, await stripe.subscriptions.retrieve(subId, { expand: ["latest_invoice"] }));
      if (current.stripe_subscription_id && current.stripe_subscription_id !== sub.id) {
        const previous = assertStripeMode(p, await stripe.subscriptions.retrieve(current.stripe_subscription_id));
        if (!terminal.has(previous.status) || sub.created <= previous.created) subId = null;
      }
      if (subId) {
        const state = subscriptionState(p, sub, current);
        if (state) {
          await saveLocked(
            p,
            current.user_id,
            token,
            "stripe_subscription_id = ?, plan = ?, subscription_status = ?, paid_until = ?, cancel_at_period_end = ?",
            [sub.id, state.plan, state.status, state.paidUntil, state.cancelAtPeriodEnd],
          );
        }
      }
    }
    await p.raw
      .prepare("INSERT OR IGNORE INTO billing_events (event_id, user_id, event_type, processed_at) VALUES (?, ?, ?, ?)")
      .run(event.id, current.user_id, event.type, seconds());
    return { received: true };
  });
}
