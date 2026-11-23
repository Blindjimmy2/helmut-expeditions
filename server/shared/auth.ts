// Passwordless auth: email + 6-digit code. Ported from Bottom Drawer's
// src/auth.js (same HMAC'd challenges, rate limits, 30-day sessions).
// Host-agnostic: storage/mail/env come through the Platform argument.

import type { Platform } from "./platform";

export const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;
export const CHALLENGE_TTL_SECONDS = 60 * 10;
const MAX_VERIFY_ATTEMPTS = 5;

export interface AuthUser {
  id: string;
  email: string;
  sessionId: string;
  expiresAt: number;
}

export function authError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

const seconds = () => Math.floor(Date.now() / 1000);

function cookieSecure(p: Platform): boolean {
  return p.env.get("COOKIE_SECURE") === "true";
}

export function sessionCookieName(p: Platform): string {
  return cookieSecure(p) ? "__Host-plate_session" : "plate_session";
}

export function normalizeEmail(value: unknown): string {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "";
  return email;
}

function randomBytes(size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/g, "");
}

function randomToken(): string {
  return bytesToBase64Url(randomBytes(32));
}

function randomCode(): string {
  const bucket = 1_000_000;
  const limit = Math.floor(0x1_0000_0000 / bucket) * bucket;
  const value = new Uint32Array(1);
  do crypto.getRandomValues(value);
  while (value[0]! >= limit);
  return String(value[0]! % bucket).padStart(6, "0");
}

const enc = new TextEncoder();

async function hmacHex(secret: string, value: string): Promise<string> {
  if (!secret) throw new Error("AUTH_PEPPER is not configured.");
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(value));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function safeEqual(a: string, b: string): boolean {
  const aa = String(a || "");
  const bb = String(b || "");
  let diff = aa.length ^ bb.length;
  const max = Math.max(aa.length, bb.length);
  for (let i = 0; i < max; i++) diff |= (aa.charCodeAt(i) || 0) ^ (bb.charCodeAt(i) || 0);
  return diff === 0;
}

export function parseCookies(header = ""): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of String(header).split(";")) {
    const index = part.indexOf("=");
    if (index <= 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) out[key] = value;
  }
  return out;
}

export function sessionCookieHeader(p: Platform, token: string, maxAge = SESSION_TTL_SECONDS): string {
  const name = sessionCookieName(p);
  const secure = cookieSecure(p) ? "; Secure" : "";
  return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function pepper(p: Platform): string {
  const v = p.env.get("AUTH_PEPPER");
  if (!v) throw authError("Sign-in is not configured on this server.", 503);
  return v;
}

async function fingerprint(p: Platform, namespace: string, value: string): Promise<string> {
  return hmacHex(pepper(p), `${namespace}:${value}`);
}

async function prune(p: Platform, email = ""): Promise<void> {
  const t = seconds();
  await p.raw
    .prepare("DELETE FROM auth_sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)")
    .run(t, t - 86400 * 7);
  await p.raw
    .prepare("DELETE FROM auth_challenges WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)")
    .run(t - 86400, t - 86400 * 7);
  if (email) {
    await p.raw.prepare("DELETE FROM auth_challenges WHERE email = ? AND created_at < ?").run(email, t - 86400 * 7);
  }
}

export async function requestCode(
  p: Platform,
  args: { email: string; ip: string },
): Promise<{ expiresInSeconds: number }> {
  const email = normalizeEmail(args.email);
  if (!email) throw authError("Enter a valid email address.", 400);

  await prune(p, email);
  const t = seconds();
  const ipHash = await fingerprint(p, "ip", args.ip);
  const emailHash = await fingerprint(p, "email", email);
  const recentEmail = (await p.raw
    .prepare("SELECT COUNT(*) AS n, MAX(created_at) AS latest FROM auth_challenges WHERE email = ? AND created_at > ?")
    .get(email, t - 3600)) as unknown as { n: number; latest: number | null };
  const recentIp = (await p.raw
    .prepare("SELECT COUNT(*) AS n FROM auth_challenges WHERE ip_hash = ? AND created_at > ?")
    .get(ipHash, t - 3600)) as unknown as { n: number };

  if (Number(recentEmail?.n || 0) >= 5 || (Number(recentEmail?.latest || 0) && t - Number(recentEmail.latest) < 60)) {
    throw authError("Please wait before requesting another sign-in code.", 429);
  }
  if (Number(recentIp?.n || 0) >= 25) {
    throw authError("Too many sign-in requests from this connection. Try again later.", 429);
  }

  const challengeId = `auth_${crypto.randomUUID().replaceAll("-", "")}`;
  const code = randomCode();
  const codeHash = await hmacHex(pepper(p), `otp:${challengeId}:${email}:${code}`);
  const expiresAt = t + CHALLENGE_TTL_SECONDS;

  await p.raw
    .prepare(
      `INSERT INTO auth_challenges
      (id, email, email_hash, code_hash, ip_hash, expires_at, attempts, created_at)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(challengeId, email, emailHash, codeHash, ipHash, expiresAt, t);

  try {
    await p.mail.send(
      email,
      "Your Helmut sign-in code",
      `Your Helmut sign-in code is ${code}. It expires in 10 minutes. If you did not request this code, you can ignore this email.`,
      `<div style="font-family:system-ui,-apple-system,Segoe UI,sans-serif;max-width:520px;margin:auto;padding:24px"><div style="font-size:14px;letter-spacing:.08em;color:#666">HELMUT</div><h1 style="font-size:24px">Your sign-in code</h1><div style="font-size:34px;font-weight:700;letter-spacing:.18em;margin:24px 0">${code}</div><p>This code expires in 10 minutes.</p><p style="color:#666">If you did not request this code, you can ignore this email.</p></div>`,
    );
  } catch (err) {
    await p.raw.prepare("DELETE FROM auth_challenges WHERE id = ?").run(challengeId);
    console.error("auth_email_send_failed", err instanceof Error ? err.message : "unknown");
    throw authError("We could not send the sign-in email. Please try again in a moment.", 503);
  }

  return { expiresInSeconds: CHALLENGE_TTL_SECONDS };
}

async function ensureUser(p: Platform, email: string): Promise<{ id: string; email: string }> {
  const t = seconds();
  const found = (await p.raw.prepare("SELECT id, email FROM users WHERE email = ?").get(email)) as unknown as
    | { id: string; email: string }
    | undefined;
  if (found) {
    await p.raw.prepare("UPDATE users SET updated_at = ? WHERE id = ?").run(t, found.id);
    return found;
  }
  const userId = `user_${crypto.randomUUID().replaceAll("-", "")}`;
  await p.raw
    .prepare("INSERT OR IGNORE INTO users (id, email, created_at, updated_at) VALUES (?, ?, ?, ?)")
    .run(userId, email, t, t);
  const created = (await p.raw.prepare("SELECT id, email FROM users WHERE email = ?").get(email)) as unknown as {
    id: string;
    email: string;
  };
  return created;
}

async function createSession(
  p: Platform,
  userAgent: string,
  userId: string,
): Promise<{ raw: string; expiresAt: number }> {
  const raw = randomToken();
  const tokenHash = await hmacHex(pepper(p), `session:${raw}`);
  const t = seconds();
  const expiresAt = t + SESSION_TTL_SECONDS;
  const uaHash = await fingerprint(p, "ua", userAgent);
  const sessionId = `sess_${crypto.randomUUID().replaceAll("-", "")}`;
  await p.raw
    .prepare(
      `INSERT INTO auth_sessions
      (id, user_id, token_hash, user_agent_hash, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(sessionId, userId, tokenHash, uaHash, expiresAt, t, t);

  const old = (await p.raw
    .prepare("SELECT id FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL ORDER BY created_at DESC LIMIT -1 OFFSET 10")
    .all(userId)) as unknown as { id: string }[];
  if (old.length) {
    const stamp = seconds();
    for (const row of old) {
      await p.raw.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ?").run(stamp, row.id);
    }
  }
  return { raw, expiresAt };
}

export async function verifyCode(
  p: Platform,
  args: { email: string; code: string; userAgent: string },
): Promise<{ user: { id: string; email: string }; raw: string; expiresAt: number }> {
  const email = normalizeEmail(args.email);
  const code = String(args.code || "").trim();
  if (!email || !/^\d{6}$/.test(code)) throw authError("Enter the six-digit code from your email.", 400);

  const t = seconds();
  const challenge = (await p.raw
    .prepare(
      `SELECT * FROM auth_challenges
      WHERE email = ? AND used_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC LIMIT 1`,
    )
    .get(email, t)) as unknown as { id: string; attempts: number; code_hash: string } | undefined;
  if (!challenge || Number(challenge.attempts || 0) >= MAX_VERIFY_ATTEMPTS) {
    throw authError("That code is invalid or expired.", 401);
  }

  const reserved = await p.raw
    .prepare(
      `UPDATE auth_challenges SET attempts = attempts + 1
      WHERE id = ? AND used_at IS NULL AND expires_at > ? AND attempts < ?`,
    )
    .run(challenge.id, t, MAX_VERIFY_ATTEMPTS);
  if (!reserved.changes) throw authError("That code is invalid or expired.", 401);

  const expected = await hmacHex(pepper(p), `otp:${challenge.id}:${email}:${code}`);
  if (!safeEqual(expected, challenge.code_hash)) throw authError("That code is invalid or expired.", 401);

  const used = await p.raw
    .prepare("UPDATE auth_challenges SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .run(t, challenge.id);
  if (!used.changes) throw authError("That code has already been used.", 401);

  const user = await ensureUser(p, email);
  const session = await createSession(p, args.userAgent, user.id);
  return { user: { id: user.id, email: user.email }, raw: session.raw, expiresAt: session.expiresAt };
}

export async function authenticate(p: Platform, cookieHeader: string): Promise<AuthUser | null> {
  try {
    if (!p.env.get("AUTH_PEPPER")) return null;
    const raw = parseCookies(cookieHeader)[sessionCookieName(p)];
    if (!raw || raw.length < 32 || raw.length > 128) return null;
    const tokenHash = await hmacHex(pepper(p), `session:${raw}`);
    const t = seconds();
    const row = (await p.raw
      .prepare(
        `SELECT s.id AS session_id, s.user_id, s.expires_at, s.last_seen_at,
        u.id, u.email
        FROM auth_sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ? LIMIT 1`,
      )
      .get(tokenHash, t)) as unknown as
      | { session_id: string; user_id: string; expires_at: number; last_seen_at: number; id: string; email: string }
      | undefined;
    if (!row) return null;
    if (t - Number(row.last_seen_at || 0) > 3600) {
      await p.raw.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(t, row.session_id);
    }
    return { id: row.id, email: row.email, sessionId: row.session_id, expiresAt: row.expires_at };
  } catch (err) {
    console.error("auth_session_failed", err instanceof Error ? err.message : "Error");
    return null;
  }
}

export async function logout(p: Platform, cookieHeader: string): Promise<void> {
  try {
    if (p.env.get("AUTH_PEPPER")) {
      const raw = parseCookies(cookieHeader)[sessionCookieName(p)];
      if (raw) {
        const tokenHash = await hmacHex(pepper(p), `session:${raw}`);
        await p.raw
          .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL")
          .run(seconds(), tokenHash);
      }
    }
  } catch (err) {
    console.error("auth_logout_failed", err instanceof Error ? err.message : "Error");
  }
}
