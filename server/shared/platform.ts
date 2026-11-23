// Platform bindings: the seam between shared logic and its host.
// Local Node implements this with node:sqlite + files + Resend;
// Cloudflare Workers implements it with D1 + R2 + Email Sending.

export type SQLVal = string | number | bigint | boolean | null | Uint8Array | ArrayBuffer;

export type SQLRow = Record<string, unknown>;

export interface RawStmt {
  get(...params: SQLVal[]): Promise<SQLRow | undefined>;
  all(...params: SQLVal[]): Promise<SQLRow[]>;
  run(...params: SQLVal[]): Promise<{ changes: number; lastInsertRowid: number | bigint }>;
}

export interface RawDb {
  prepare(sql: string): RawStmt;
  exec(sql: string): Promise<void>;
}

export interface PlatformEnv {
  get(name: string): string;
}

export interface Mailer {
  send(to: string, subject: string, text: string, html: string): Promise<void>;
}

export interface Platform {
  env: PlatformEnv;
  raw: RawDb;
  mail: Mailer;
}
