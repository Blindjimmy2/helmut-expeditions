// Local SDK shim: the pieces server/src/actions.ts needs.
// `z` is zod itself; `defineAction` is an identity wrapper carrying the
// request/response schemas the dispatcher validates with.
import { z } from "zod";
import type { Ctx } from "./types";

export { z };
export type { Ctx };

export interface ActionDef<
  Req extends z.ZodTypeAny = z.ZodTypeAny,
  Res extends z.ZodTypeAny = z.ZodTypeAny,
> {
  description: string;
  request: Req;
  response: Res;
  handler: (ctx: Ctx, args: z.infer<Req>) => Promise<z.infer<Res>>;
}

export function defineAction<
  Req extends z.ZodTypeAny,
  Res extends z.ZodTypeAny,
>(def: ActionDef<Req, Res>): ActionDef<Req, Res> {
  return def;
}

export type ActionsModule = Record<string, ActionDef>;

// Attaches a Set-Cookie value to an action result. The dispatcher reads
// `__setCookie` for the response header; zod strips it from the JSON body.
export function withSetCookie<T extends object>(obj: T, cookie: string): T {
  return { ...obj, __setCookie: cookie } as T;
}
