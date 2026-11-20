// Typed RPC client. Types come straight from `server/src/actions.ts` — no
// codegen. `api` is a proxy that POSTs `{action, args}` to `./actions`
// and returns the typed response (`{ data }` on success, `{ error }`
// on failure — the same contract the server in server/src/index.ts speaks).
//
// `import type { Actions }` is type-only by design: the client bundle never
// pulls in any server runtime (bun:sqlite, file APIs, etc.). With
// `verbatimModuleSyntax: true`, dropping `type` is a compile error.

import type { z } from "zod";
import type { Actions } from "../../server/src/actions";

type ActionDef = { request: z.ZodType; response: z.ZodType };

export type ApiRequest<A, K extends keyof A> =
  A[K] extends ActionDef ? z.infer<A[K]["request"]> : never;
export type ApiResponse<A, K extends keyof A> =
  A[K] extends ActionDef ? z.infer<A[K]["response"]> : never;

type ActionClient<A> = {
  [K in keyof A]: (args: ApiRequest<A, K>) => Promise<ApiResponse<A, K>>;
};

function createActionClient<A>(): ActionClient<A> {
  return new Proxy({} as ActionClient<A>, {
    get(_target, name) {
      if (typeof name !== "string") return undefined;
      if (name === "then" || name === "catch" || name === "finally") return undefined;
      return async (args: unknown) => {
        const res = await fetch("./actions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: name, args: args ?? {} }),
        });
        const body = (await res.json()) as { data?: unknown; error?: unknown };
        if (!res.ok || body.error) {
          throw new Error(`action ${name} error: ${String(body.error ?? res.statusText)}`);
        }
        return body.data;
      };
    },
  });
}

export const api = createActionClient<typeof Actions>();
