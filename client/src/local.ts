// Local client RPC + SDK replacements (fetch-based, no Hatch runtime).
import { QueryClient } from "@tanstack/react-query";

export const queryClient = new QueryClient();

export function createActionClient<TActions extends Record<string, unknown>>(): {
  [K in keyof TActions]: TActions[K] extends {
    request: { parse: (v: unknown) => infer Req };
    response: { parse: (v: unknown) => infer Res };
  }
    ? (args: Req) => Promise<Res>
    : (args: unknown) => Promise<unknown>;
} {
  return new Proxy(
    {},
    {
      get:
        (_t, action: string) =>
        async (args: unknown): Promise<unknown> => {
          const res = await fetch("./actions", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action, args }),
          });
          const body = (await res.json()) as { error?: string } & Record<string, unknown>;
          if (!res.ok || body.error) {
            throw new Error(
              typeof body.error === "string" ? body.error : `Action ${action} failed (${res.status}).`,
            );
          }
          return body;
        },
    },
  ) as never;
}

export async function fileToBase64(
  file: File,
): Promise<{ dataBase64: string; mimeType: string }> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let bin = "";
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]!);
  return { dataBase64: btoa(bin), mimeType: file.type || "image/jpeg" };
}

export function SafeAreaTopScrim(_props: { backgroundColor?: string }): null {
  return null;
}
