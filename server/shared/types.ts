// Shared Ctx: everything server/src/actions.ts needs, on either host.
import type { z } from "zod";
import type { AuthUser } from "./auth";
import type { Platform } from "./platform";

export interface InferenceImage {
  dataBase64: string;
  mimeType: string;
  filename?: string;
}

export interface UsageMeta {
  userId?: string | null;
  runId?: number | null;
  action: "transcribe" | "compare" | "ask";
  onEventId?: (id: number) => void;
}

export interface InferenceOptions {
  schema: z.ZodTypeAny;
  system?: string;
  images?: InferenceImage[];
  timeout_secs?: number;
  usage?: UsageMeta;
}

export interface WebResult {
  title: string;
  url: string | null;
  source: string | null;
  snippet: string | null;
}

export interface WebSearchResponse {
  content: { results: WebResult[]; unavailable: boolean };
}

export interface SearchMeta {
  userId?: string | null;
  runId?: number | null;
}

export interface Ctx {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db(): any;
  user: AuthUser | null;
  req: { ip: string; userAgent: string; cookie: string };
  blobs: {
    put(key: string, bytes: Uint8Array, opts?: { contentType?: string }): Promise<void>;
    getUrl(key: string): Promise<string>;
    delete(key: string): Promise<void>;
  };
  inference: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    complete(prompt: string, opts: InferenceOptions): Promise<any>;
  };
  tool: { web_search(query: string, meta?: SearchMeta): Promise<WebSearchResponse> };
  invalidateQueries(): void;
  platform: Platform;
}
