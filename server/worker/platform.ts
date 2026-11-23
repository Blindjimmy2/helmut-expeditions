// Worker Platform: D1 + R2 + Email Sending. Structural types only —
// no @cloudflare/workers-types dependency needed.
import type { Platform } from "../shared/platform";

export interface D1Like {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first(): Promise<unknown>;
      all(): Promise<{ results?: unknown[] }>;
      run(): Promise<{ meta: { changes?: number; last_row_id?: number | null } }>;
    };
  };
  exec(sql: string): Promise<unknown>;
}

export interface R2Like {
  put(key: string, data: Uint8Array, opts?: { httpMetadata?: { contentType?: string } }): Promise<unknown>;
  get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer>; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<unknown>;
}

export interface EmailLike {
  send(msg: unknown): Promise<unknown>;
}

export interface WorkerEnv {
  DB: D1Like;
  FILES: R2Like;
  EMAIL: EmailLike;
  ASSETS: { fetch(req: Request): Promise<Response> };
  [key: string]: unknown;
}

export function workerPlatform(env: WorkerEnv): Platform {
  const get = (name: string): string => {
    const v = env[name];
    return typeof v === "string" ? v.trim() : "";
  };
  return {
    env: { get },
    raw: {
      prepare: (sql: string) => ({
        get: async (...params) => {
          const r = await env.DB.prepare(sql).bind(...params).first();
          return (r ?? undefined) as Record<string, unknown> | undefined;
        },
        all: async (...params) => {
          const r = await env.DB.prepare(sql).bind(...params).all();
          return (r.results ?? []) as Record<string, unknown>[];
        },
        run: async (...params) => {
          const r = await env.DB.prepare(sql).bind(...params).run();
          return { changes: r.meta.changes ?? 0, lastInsertRowid: r.meta.last_row_id ?? 0 };
        },
      }),
      exec: async (sql: string) => {
        await env.DB.exec(sql);
      },
    },
    mail: {
      send: async (to: string, subject: string, text: string, html: string) => {
        const from = get("AUTH_FROM_EMAIL");
        if (!from) throw new Error("AUTH_FROM_EMAIL is not configured.");
        await env.EMAIL.send({
          to,
          from: { email: from, name: "HelmutReads" },
          subject,
          text,
          html,
        });
      },
    },
  };
}
