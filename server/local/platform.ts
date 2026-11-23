// Local Platform: node:sqlite + process.env + Resend/dev-print mail.
import type { Platform } from "../shared/platform";
import { sqlite } from "./db.ts";

type Stmt = ReturnType<typeof sqlite.prepare>;
type StmtArgs = Parameters<Stmt["get"]>;

export function localPlatform(): Platform {
  return {
    env: { get: (name) => (process.env[name] ?? "").trim() },
    raw: {
      prepare: (sql: string) => {
        const stmt = sqlite.prepare(sql);
        return {
          get: async (...params) => stmt.get(...(params as StmtArgs)) as Record<string, unknown> | undefined,
          all: async (...params) => stmt.all(...(params as StmtArgs)) as Record<string, unknown>[],
          run: async (...params) => {
            const r = stmt.run(...(params as StmtArgs));
            return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
          },
        };
      },
      exec: async (sql: string) => {
        sqlite.exec(sql);
      },
    },
    mail: {
      send: async (to: string, subject: string, text: string, html: string) => {
        const key = (process.env["RESEND_API_KEY"] ?? "").trim();
        if (!key) {
          if ((process.env["AUTH_DEV_PRINT_CODE"] ?? "").trim() === "true") {
            console.log(`[auth-dev] email to ${to} (${subject}):\n${text}`);
            return;
          }
          throw new Error("Email is not configured (RESEND_API_KEY).");
        }
        const from = (process.env["AUTH_FROM_EMAIL"] ?? "").trim();
        if (!from) throw new Error("AUTH_FROM_EMAIL is not configured.");
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
          body: JSON.stringify({ from, to: [to], subject, text, html }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`Email send failed (${res.status}).`);
      },
    },
  };
}
