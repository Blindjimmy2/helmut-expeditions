// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `createActionClient` returns a proxy that POSTs `{action, args}`
// to `./actions` and returns the typed response.
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime. With `verbatimModuleSyntax: true`, dropping
// `type` is a compile error.

import type { Actions } from "../../server/src/actions";
import { createActionClient } from "./local";

export const api = createActionClient<typeof Actions>();

export type ApiResponse<
  TApi extends Record<string, (args: never) => Promise<unknown>>,
  TAction extends keyof TApi,
> = TApi[TAction] extends (args: never) => Promise<infer R> ? R : never;

export type ApiRequest<
  TApi extends Record<string, (args: never) => Promise<unknown>>,
  TAction extends keyof TApi,
> = TApi[TAction] extends (args: infer A) => Promise<unknown> ? A : never;
