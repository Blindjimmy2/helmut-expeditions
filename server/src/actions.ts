// Actions for Helmut.
//
// The blind-test protocol is enforced here, in the action structure:
//   Phase 1 — `transcribePlate`: the ONLY input is the uploaded image.
//     The model call is vision-only (no browsing, no tools), so the
//     transcription is structurally blind. Its output is saved to the run
//     row before anything else can happen.
//   Phase 2 — `researchRun`: refuses to run unless the run already has a
//     saved transcription. Only then does it search the web for published
//     versions and compare them against the frozen blind transcription.
//
// Auth (same setup as Bottom Drawer): email + 6-digit code, 30-day
// HttpOnly session cookie. All run actions require a session and are
// scoped to the signed-in user's own runs.
//
// Runs on localhost (Node + SQLite) and Cloudflare (Workers + D1 + R2)
// through the shared platform interface.

import { defineAction, withSetCookie, z, type ActionsModule, type Ctx } from "../shared/sdk.ts";
import { and, asc, eq } from "drizzle-orm";
import {
  CHALLENGE_TTL_SECONDS,
  logout as authLogout,
  requestCode,
  sessionCookieHeader,
  verifyCode,
} from "../shared/auth.ts";
import {
  billingStatus,
  customerPortal,
  startCheckout,
  syncBilling,
  withAllowance,
} from "../shared/billing.ts";
import { askRunQuestion as askRun } from "../shared/ask.ts";
import { provenanceGate } from "../shared/provenance.ts";
import { reviewQueue, reviewRun, submitForReview } from "../shared/review.ts";
import * as schema from "./schema.ts";
import type { SQLVal } from "../shared/platform.ts";

import { isAdmin as isAdminUser } from "../shared/review.ts";

function requireUser(ctx: Ctx): NonNullable<Ctx["user"]> {
  if (!ctx.user) throw Object.assign(new Error("Sign in required."), { status: 401 });
  return ctx.user;
}

// Cost-meter constants: the meter reports Ember usage only, and the event
// window matches the hackathon build window (Nov 23, 9:00 AM ET).
export const METER_MODEL = "muse-ember-1.0";
export const METER_EVENT_START_MS = Date.UTC(2026, 10, 23, 14, 0, 0);

// ---------------------------------------------------------------------------
// Shared shapes
// ---------------------------------------------------------------------------

const legibility = z.enum(["clear", "partial", "faint", "illegible"]);

const transcriptionSchema = z.object({
  language: z
    .string()
    .describe("Script/language identified from the image alone, or 'Uncertain'"),
  materialDescription: z
    .string()
    .describe("What the object/page in the photo physically is, as visible"),
  figureDescription: z
    .string()
    .describe("Figures, drawings, or iconography visible in the image"),
  printedCaptions: z
    .array(z.string())
    .describe("Printed (not handwritten) captions visible, e.g. plate numbers"),
  lines: z
    .array(
      z.object({
        text: z
          .string()
          .describe("One line of transcription; illegible characters as [?]"),
        legibility: legibility,
      }),
    )
    .describe("Line-by-line transcription, top to bottom, of the text in the image"),
  uncertainReadings: z
    .array(z.string())
    .describe("Specific readings the transcriber is unsure about, and why"),
  searchAnchors: z
    .array(z.string())
    .max(8)
    .describe(
      "Distinctive identifiers taken ONLY from the image (plate numbers, captions, names, distinctive words) that a later research phase can search for",
    ),
  summary: z.string().describe("One-paragraph summary of what the plate contains"),
  translation: z
    .string()
    .default("")
    .describe("English translation of the transcribed text above; every [?] gap must surface as [...] and uncertain readings stay hedged"),
});

const sourceSchema = z.object({
  title: z.string(),
  url: z.string().nullable(),
  source: z.string().nullable(),
  snippet: z.string().nullable(),
});

const researchSchema = z.object({
  verdict: z.enum(["match_found", "partial", "no_published_version_found"]),
  verdictSummary: z.string(),
  agreements: z.array(z.string()),
  discrepancies: z.array(z.string()),
  queries: z.array(z.string()),
  sources: z.array(sourceSchema),
});

const runObject = z.object({
  id: z.number(),
  note: z.string(),
  provenanceTier: z.enum(["verified", "claimed", "unknown"]),
  provenanceText: z.string(),
  provenanceVerdict: z.enum(["pass", "review", "quarantine"]),
  checklistState: z.enum(["none", "submitted", "approved", "rejected", "published", "hold"]),
  checklistReason: z.string(),
  status: z.enum(["transcribed", "complete"]),
  imageUrl: z.string(),
  transcription: transcriptionSchema,
  research: researchSchema.nullable(),
  createdAt: z.string(),
  researchedAt: z.string().nullable(),
});

const publicUser = z.object({ id: z.string(), email: z.string() });

type RunRow = typeof schema.runs.$inferSelect;

async function toRunObject(
  ctx: Ctx,
  row: RunRow,
): Promise<z.infer<typeof runObject>> {
  return {
    id: row.id,
    note: row.note,
    provenanceTier: (row.provenanceTier ?? "unknown") as "verified" | "claimed" | "unknown",
    provenanceText: row.provenanceText ?? "",
    provenanceVerdict: (row.provenanceVerdict ?? "quarantine") as "pass" | "review" | "quarantine",
    checklistState: (row.checklistState ?? "none") as "none" | "submitted" | "approved" | "rejected" | "published" | "hold",
    checklistReason: row.checklistReason ?? "",
    status: row.status,
    imageUrl: await ctx.blobs.getUrl(row.imageBlobKey),
    transcription: transcriptionSchema.parse(JSON.parse(row.transcription)),
    research: row.research
      ? researchSchema.parse(JSON.parse(row.research))
      : null,
    createdAt: row.createdAt.toISOString(),
    researchedAt: row.researchedAt ? row.researchedAt.toISOString() : null,
  };
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const Actions = {
  requestSignInCode: defineAction({
    description: "Sends a 6-digit sign-in code to an email address.",
    request: z.object({ email: z.string().trim().max(254) }),
    response: z.object({ ok: z.literal(true), expiresInSeconds: z.number() }),
    async handler(ctx, args) {
      await requestCode(ctx.platform, { email: args.email, ip: ctx.req.ip });
      return { ok: true as const, expiresInSeconds: CHALLENGE_TTL_SECONDS };
    },
  }),

  verifySignInCode: defineAction({
    description: "Verifies an email + code pair and starts a session.",
    request: z.object({ email: z.string().trim().max(254), code: z.string().trim().max(12) }),
    response: z.object({ user: publicUser, expiresAt: z.number() }),
    async handler(ctx, args) {
      const s = await verifyCode(ctx.platform, {
        email: args.email,
        code: args.code,
        userAgent: ctx.req.userAgent,
      });
      return withSetCookie(
        { user: s.user, expiresAt: s.expiresAt },
        sessionCookieHeader(ctx.platform, s.raw),
      );
    },
  }),

  currentUser: defineAction({
    description: "Returns the signed-in user, or null.",
    request: z.object({}),
    response: z.object({ user: publicUser.nullable(), isAdmin: z.boolean() }),
    async handler(ctx) {
      return { user: ctx.user ? { id: ctx.user.id, email: ctx.user.email } : null, isAdmin: isAdminUser(ctx.platform, ctx.user ? ctx.user.email : null) };
    },
  }),

  logout: defineAction({
    description: "Revokes the current session.",
    request: z.object({}),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx) {
      await authLogout(ctx.platform, ctx.req.cookie);
      return withSetCookie({ ok: true as const }, sessionCookieHeader(ctx.platform, "", 0));
    },
  }),

  transcribePlate: defineAction({
    description:
      "Phase 1: blindly transcribes a dropped plate photo using only the image (no references), saves the run, and returns it.",
    request: z.object({
      image: z.object({
        dataBase64: z.string().min(1),
        mimeType: z.string(),
      }),
      note: z.string().trim().max(300).default(""),
      provenance: z.string().trim().max(300).default(""),
    }),
    response: z.object({ run: runObject }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      const prov = await provenanceGate(ctx.platform, user.id, args.provenance);
      const { dataBase64, mimeType } = args.image;
      if (mimeType !== "image/jpeg" && mimeType !== "image/png") {
        throw new Error(
          "That image format can't be scanned — please drop a JPEG or PNG photo of the plate.",
        );
      }

      let transcribeEventId: number | null = null;
      return withAllowance(ctx.platform, user.id, async () => {
        const transcription = await ctx.inference.complete(
          "Transcribe the manuscript/catalog plate in this photograph. Work ONLY from what is visible in the image. Transcribe the text line by line, top to bottom, preserving the original script where you can and marking every character you cannot actually read as [?] rather than guessing. Separately record any printed captions (such as a plate number), describe the material and any figures or drawings, identify the script/language from the letterforms alone, list the readings you are uncertain about, translate the transcribed text into English (carrying every [?] through as [...] and hedging every uncertain reading - never fill gaps from outside knowledge), and pull out the distinctive identifiers visible in the image (plate numbers, captions, proper names, distinctive words) as search anchors for a later research phase.",
          {
            schema: transcriptionSchema,
            system:
              "You are a scholarly transcriber performing a BLIND transcription for a verification test. You must work exclusively from the image in front of you. Do not reconstruct text from memory of published editions, do not complete damaged passages from outside knowledge, and do not identify the specific published source of the item even if you suspect it. Where the writing is damaged or illegible, say so with [?] marks - an honest gap is worth more than a plausible guess. The translation must show the same gaps: translate only what was actually read.",
            images: [{ dataBase64, mimeType, filename: "plate" }],
            timeout_secs: 240,
            usage: {
              userId: user.id,
              action: "transcribe",
              onEventId: (id) => {
                transcribeEventId = id;
              },
            },
          },
        );

        const ext = mimeType === "image/png" ? "png" : "jpg";
        const blobKey = `plates/${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 10)}.${ext}`;
        await ctx.blobs.put(blobKey, base64ToBytes(dataBase64), {
          contentType: mimeType,
        });

        const db = ctx.db();
        const inserted = await db
          .insert(schema.runs)
          .values({
            userId: user.id,
            note: args.note,
            provenanceTier: prov.tier,
            provenanceText: args.provenance,
            provenanceVerdict: prov.verdict,
            imageBlobKey: blobKey,
            imageMime: mimeType,
            status: "transcribed",
            transcription: JSON.stringify(transcription),
          })
          .returning();
        const row = inserted[0];
        if (!row) throw new Error("transcribePlate: insert returned no rows");
        if (transcribeEventId !== null) {
          await ctx.platform.raw
            .prepare("UPDATE usage_events SET run_id = ? WHERE id = ?")
            .run(row.id, transcribeEventId);
        }

        ctx.invalidateQueries();
        return { run: await toRunObject(ctx, row) };
      });
    },
  }),

  researchRun: defineAction({
    description:
      "Phase 2: searches the web for published versions of an already-transcribed plate and compares them against the saved blind transcription.",
    request: z.object({ runId: z.number().int().positive() }),
    response: z.object({ run: runObject }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      const db = ctx.db();
      const rows = await db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.id, args.runId), eq(schema.runs.userId, user.id)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("That run no longer exists.");
      // The gate: no saved blind transcription, no research. Ever.
      const transcription = transcriptionSchema.parse(
        JSON.parse(row.transcription),
      );

      // Build search queries from the phase-1 anchors (image-derived only)
      // plus the user's own catalog note, which phase 1 never saw.
      const anchors = transcription.searchAnchors.filter((a) => a.trim());
      const querySet = new Set<string>();
      if (anchors.length > 0) querySet.add(anchors.slice(0, 4).join(" "));
      if (anchors.length > 1)
        querySet.add(
          `${anchors.slice(0, 2).join(" ")} ${transcription.language} transcription published`,
        );
      if (row.note.trim())
        querySet.add(`${row.note.trim()} transcription published edition`);
      querySet.add(
        `${transcription.language} magical papyrus plate published transcription`,
      );
      const queries = [...querySet].slice(0, 4);

      type Source = z.infer<typeof sourceSchema>;
      const byKey = new Map<string, Source>();
      let searchUnavailable = false;
      for (const q of queries) {
        const res = await ctx.tool.web_search(q, { userId: user.id, runId: row.id });
        if (res.content.unavailable) searchUnavailable = true;
        for (const r of res.content.results) {
          const key = r.url ?? r.title;
          if (!byKey.has(key)) {
            byKey.set(key, {
              title: r.title,
              url: r.url,
              source: r.source,
              snippet: r.snippet ? r.snippet.slice(0, 900) : null,
            });
          }
        }
      }
      const sources = [...byKey.values()].slice(0, 12);

      // Comparison: a text-only inference over the frozen transcription and
      // the search evidence. URLs in the output come from the search results
      // above, never from the model.
      const linesText = transcription.lines
        .map((l, i) => `${i + 1}. (${l.legibility}) ${l.text}`)
        .join("\n");
      const sourcesText = searchUnavailable
        ? "(Web search is not configured on this server, so no published sources could be checked. Say so plainly in the verdict summary instead of claiming nothing is published.)"
        : sources
            .map(
              (s, i) =>
                `[${i + 1}] ${s.title} (${s.source ?? "unknown source"})\n${s.snippet ?? "(no excerpt available)"}`,
            )
            .join("\n\n");
      const comparison = await ctx.inference.complete(
        `You are cross-checking a BLIND transcription of a manuscript plate against published references found on the web.\n\nBLIND TRANSCRIPTION (made from the photograph alone, before any reference was consulted):\nLanguage identified: ${transcription.language}\nPrinted captions seen: ${transcription.printedCaptions.join("; ") || "(none)"}\nSummary: ${transcription.summary}\nLines:\n${linesText}\nUncertain readings: ${transcription.uncertainReadings.join("; ") || "(none)"}\n\nWEB SOURCES FOUND:\n${sourcesText || "(no sources found)"}\n\nCompare the two. The verdict describes this search only: it must never claim an item is unpublished, undiscovered, or a first reading - "no match found" means the search came back empty, nothing more. Verdict rules: use "match_found" only when a source actually presents a published transcription, edition, or catalog record of THIS specific item (matching plate number, captions, or distinctive text) that can be checked against the blind transcription. Use "partial" when sources identify the item or close parallels but no full published text is available to compare. Use "no_published_version_found" when nothing found corresponds to this specific item — that is a meaningful result, not a failure. List concrete agreements and concrete discrepancies between the blind transcription and the published material; if there is no published text to compare, say what is missing instead of inventing discrepancies.`,
        {
          schema: z.object({
            verdict: z.enum([
              "match_found",
              "partial",
              "no_published_version_found",
            ]),
            verdictSummary: z.string(),
            agreements: z.array(z.string()),
            discrepancies: z.array(z.string()),
          }),
          system:
            "You are a careful scholarly reviewer. Only claim a match when the evidence in the provided sources supports it. Never invent a published transcription, a shelfmark, or a discrepancy that the sources do not show.",
          timeout_secs: 240,
          usage: { userId: user.id, runId: row.id, action: "compare" },
        },
      );

      const research: z.infer<typeof researchSchema> = {
        ...comparison,
        queries,
        sources,
      };
      const now = new Date();
      await db
        .update(schema.runs)
        .set({
          research: JSON.stringify(research),
          status: "complete",
          researchedAt: now,
        })
        .where(and(eq(schema.runs.id, row.id), eq(schema.runs.userId, user.id)));

      ctx.invalidateQueries();
      const updated = { ...row, research: JSON.stringify(research), status: "complete" as const, researchedAt: now };
      return { run: await toRunObject(ctx, updated) };
    },
  }),

  liveMeter: defineAction({
    description:
      "Public aggregate Ember usage for the expedition cost meter. No auth, no user data — totals only.",
    request: z.object({}),
    response: z.object({
      meter: z.object({
        plates: z.number(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        reasoningTokens: z.number(),
        searches: z.number(),
        event: z.object({
          plates: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          reasoningTokens: z.number(),
          searches: z.number(),
        }),
      }),
    }),
    async handler(ctx) {
      const raw = ctx.platform.raw;
      const row = async (sql: string, ...params: SQLVal[]): Promise<Record<string, number>> =>
        ((await raw.prepare(sql).get(...params)) ?? {}) as Record<string, number>;
      const num = (r: Record<string, number>, key: string): number => r[key] ?? 0;
      // Plate tokens join to completed runs only, so failed calls (run_id
      // null) and Q&A ('ask') never inflate the $/plate figure.
      const base = `FROM usage_events u JOIN runs r ON r.id = u.run_id
        WHERE u.action IN ('transcribe','compare') AND u.model = ? AND r.status = 'complete'`;
      const plates = num(await row(`SELECT COUNT(*) AS n FROM runs WHERE status = 'complete'`), "n");
      const toks = await row(
        `SELECT COALESCE(SUM(u.input_tokens),0) AS i, COALESCE(SUM(u.output_tokens),0) AS o, COALESCE(SUM(u.reasoning_tokens),0) AS r ${base}`,
        METER_MODEL,
      );
      const searches = num(await row(`SELECT COUNT(*) AS n FROM usage_events WHERE action = 'search'`), "n");
      const eplates = num(
        await row(`SELECT COUNT(*) AS n FROM runs WHERE status = 'complete' AND created_at >= ?`, METER_EVENT_START_MS),
        "n",
      );
      const etoks = await row(
        `SELECT COALESCE(SUM(u.input_tokens),0) AS i, COALESCE(SUM(u.output_tokens),0) AS o, COALESCE(SUM(u.reasoning_tokens),0) AS r ${base} AND u.created_at >= ?`,
        METER_MODEL,
        METER_EVENT_START_MS,
      );
      const esearches = num(
        await row(`SELECT COUNT(*) AS n FROM usage_events WHERE action = 'search' AND created_at >= ?`, METER_EVENT_START_MS),
        "n",
      );
      return {
        meter: {
          plates,
          inputTokens: num(toks, "i"),
          outputTokens: num(toks, "o"),
          reasoningTokens: num(toks, "r"),
          searches,
          event: {
            plates: eplates,
            inputTokens: num(etoks, "i"),
            outputTokens: num(etoks, "o"),
            reasoningTokens: num(etoks, "r"),
            searches: esearches,
          },
        },
      };
    },
  }),

  askRunQuestion: defineAction({
    description: "Per-run Q&A: answers from the run's saved outputs, optionally with fresh web searches for comparable material. Never re-reads the image.",
    request: z.object({ runId: z.number().int().positive(), question: z.string().trim().min(1).max(1000) }),
    response: z.object({ answer: z.string(), searched: z.boolean(), queries: z.array(z.string()), sources: z.array(sourceSchema) }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      return askRun(ctx.platform, user.id, args.runId, args.question, {
        complete: (prompt, opts) =>
          ctx.inference.complete(prompt, { ...opts, timeout_secs: 240, usage: { userId: user.id, runId: args.runId, action: "ask" } }),
        search: async (q) => (await ctx.tool.web_search(q, { userId: user.id, runId: args.runId })).content,
      });
    },
  }),

  usageSummary: defineAction({
    description: "Usage and cost-basis summary for the signed-in user.",
    request: z.object({ days: z.number().int().min(1).max(365).default(30) }),
    response: z.object({
      totals: z.object({
        transcribe: z.object({
          calls: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          reasoningTokens: z.number(),
          avgLatencyMs: z.number(),
        }),
        compare: z.object({
          calls: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          reasoningTokens: z.number(),
          avgLatencyMs: z.number(),
        }),
        ask: z.object({
          calls: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          reasoningTokens: z.number(),
          avgLatencyMs: z.number(),
        }),
        search: z.object({ calls: z.number() }),
      }),
      byDay: z.array(
        z.object({
          day: z.string(),
          calls: z.number(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          reasoningTokens: z.number(),
          searches: z.number(),
        }),
      ),
      byRun: z.array(
        z.object({
          runId: z.number(),
          note: z.string(),
          createdAt: z.string(),
          transcribe: z
            .object({ inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number() })
            .nullable(),
          compare: z
            .object({ inputTokens: z.number(), outputTokens: z.number(), reasoningTokens: z.number() })
            .nullable(),
          searches: z.number(),
        }),
      ),
    }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      const since = Date.now() - args.days * 86400 * 1000;
      const aggRows = (await ctx.platform.raw
        .prepare(
          `SELECT action, COUNT(*) AS calls,
          COALESCE(SUM(input_tokens),0) AS inputTokens,
          COALESCE(SUM(output_tokens),0) AS outputTokens,
          COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
          COALESCE(AVG(latency_ms),0) AS avgMs
          FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY action`,
        )
        .all(user.id, since)) as unknown as {
        action: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        avgMs: number;
      }[];
      const zero = () => ({ calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, avgLatencyMs: 0 });
      const transcribe = zero();
      const compare = zero();
      const ask = zero();
      let searchCalls = 0;
      for (const r of aggRows) {
        if (r.action === "search") searchCalls = r.calls;
        else if (r.action === "transcribe") Object.assign(transcribe, { ...r, avgLatencyMs: Math.round(r.avgMs) });
        else if (r.action === "compare") Object.assign(compare, { ...r, avgLatencyMs: Math.round(r.avgMs) });
        else if (r.action === "ask") Object.assign(ask, { ...r, avgLatencyMs: Math.round(r.avgMs) });
      }
      const byDay = (await ctx.platform.raw
        .prepare(
          `SELECT date(created_at/1000, 'unixepoch') AS day,
          SUM(CASE WHEN action IN ('transcribe','compare') THEN 1 ELSE 0 END) AS calls,
          COALESCE(SUM(input_tokens),0) AS inputTokens,
          COALESCE(SUM(output_tokens),0) AS outputTokens,
          COALESCE(SUM(reasoning_tokens),0) AS reasoningTokens,
          SUM(CASE WHEN action = 'search' THEN 1 ELSE 0 END) AS searches
          FROM usage_events WHERE user_id = ? AND created_at >= ? GROUP BY day ORDER BY day DESC`,
        )
        .all(user.id, since)) as unknown as {
        day: string;
        calls: number;
        inputTokens: number;
        outputTokens: number;
        reasoningTokens: number;
        searches: number;
      }[];
      const runRows = (await ctx.platform.raw
        .prepare(
          `SELECT r.id AS runId, r.note AS note, r.created_at AS createdAt,
          SUM(CASE WHEN u.action = 'transcribe' THEN 1 ELSE 0 END) AS tCalls,
          COALESCE(SUM(CASE WHEN u.action = 'transcribe' THEN u.input_tokens ELSE 0 END),0) AS tIn,
          COALESCE(SUM(CASE WHEN u.action = 'transcribe' THEN u.output_tokens ELSE 0 END),0) AS tOut,
          COALESCE(SUM(CASE WHEN u.action = 'transcribe' THEN u.reasoning_tokens ELSE 0 END),0) AS tRe,
          SUM(CASE WHEN u.action = 'compare' THEN 1 ELSE 0 END) AS cCalls,
          COALESCE(SUM(CASE WHEN u.action = 'compare' THEN u.input_tokens ELSE 0 END),0) AS cIn,
          COALESCE(SUM(CASE WHEN u.action = 'compare' THEN u.output_tokens ELSE 0 END),0) AS cOut,
          COALESCE(SUM(CASE WHEN u.action = 'compare' THEN u.reasoning_tokens ELSE 0 END),0) AS cRe,
          SUM(CASE WHEN u.action = 'search' THEN 1 ELSE 0 END) AS searches
          FROM runs r LEFT JOIN usage_events u ON u.run_id = r.id AND u.user_id = r.user_id
          WHERE r.user_id = ? GROUP BY r.id ORDER BY r.id DESC LIMIT 100`,
        )
        .all(user.id)) as unknown as {
        runId: number;
        note: string;
        createdAt: number;
        tCalls: number;
        tIn: number;
        tOut: number;
        tRe: number;
        cCalls: number;
        cIn: number;
        cOut: number;
        cRe: number;
        searches: number;
      }[];
      const byRun = runRows.map((r) => ({
        runId: r.runId,
        note: r.note,
        createdAt: new Date(r.createdAt).toISOString(),
        transcribe:
          r.tCalls > 0 ? { inputTokens: r.tIn, outputTokens: r.tOut, reasoningTokens: r.tRe } : null,
        compare:
          r.cCalls > 0 ? { inputTokens: r.cIn, outputTokens: r.cOut, reasoningTokens: r.cRe } : null,
        searches: r.searches,
      }));
      return { totals: { transcribe, compare, ask, search: { calls: searchCalls } }, byDay, byRun };
    },
  }),

  billingStatus: defineAction({
    description: "Billing status for the signed-in user.",
    request: z.object({}),
    response: z.object({
      mode: z.string(),
      paid: z.boolean(),
      betaAccess: z.boolean(),
      plan: z.string(),
      subscriptionStatus: z.string(),
      paidUntil: z.number(),
      cancelAtPeriodEnd: z.boolean(),
      canManage: z.boolean(),
      configured: z.boolean(),
      freeRuns: z.number(),
    }),
    async handler(ctx) {
      return billingStatus(ctx.platform, requireUser(ctx).id);
    },
  }),

  startCheckout: defineAction({
    description: "Starts a Stripe Checkout for a plan.",
    request: z.object({ plan: z.enum(["researcher", "institution"]) }),
    response: z.object({ url: z.string().nullable() }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      return startCheckout(ctx.platform, user.id, user.email, args.plan);
    },
  }),

  billingPortal: defineAction({
    description: "Opens the Stripe customer portal.",
    request: z.object({}),
    response: z.object({ url: z.string() }),
    async handler(ctx) {
      return customerPortal(ctx.platform, requireUser(ctx).id);
    },
  }),

  syncBilling: defineAction({
    description: "Polls Stripe for the latest billing state (localhost alternative to webhooks).",
    request: z.object({}),
    response: z.object({
      mode: z.string(),
      paid: z.boolean(),
      betaAccess: z.boolean(),
      plan: z.string(),
      subscriptionStatus: z.string(),
      paidUntil: z.number(),
      cancelAtPeriodEnd: z.boolean(),
      canManage: z.boolean(),
      configured: z.boolean(),
      freeRuns: z.number(),
    }),
    async handler(ctx) {
      return syncBilling(ctx.platform, requireUser(ctx).id);
    },
  }),

  submitForReview: defineAction({
    description: "Submits one of your own runs to the human verification track.",
    request: z.object({ runId: z.number().int().positive() }),
    response: z.object({
      runId: z.number(),
      checklistState: z.enum(["none", "submitted", "approved", "rejected", "published", "hold"]),
    }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      return submitForReview(ctx.platform, user.id, args.runId);
    },
  }),

  setRunProvenance: defineAction({
    description: "Sets the holding statement on one of your own undecided runs (re-runs gate 3).",
    request: z.object({ runId: z.number().int().positive(), provenance: z.string().trim().max(300) }),
    response: z.object({ run: runObject }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      const db = ctx.db();
      const rows = await db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.id, args.runId), eq(schema.runs.userId, user.id)))
        .limit(1);
      const row = rows[0];
      if (!row) throw new Error("That run no longer exists.");
      if (row.checklistState !== "none" && row.checklistState !== "rejected") {
        throw Object.assign(new Error("This run is already in the verification track."), { status: 400 });
      }
      const prov = await provenanceGate(ctx.platform, user.id, args.provenance);
      await db
        .update(schema.runs)
        .set({ provenanceTier: prov.tier, provenanceText: args.provenance, provenanceVerdict: prov.verdict })
        .where(and(eq(schema.runs.id, row.id), eq(schema.runs.userId, user.id)));
      const updated = { ...row, provenanceTier: prov.tier, provenanceText: args.provenance, provenanceVerdict: prov.verdict };
      return { run: await toRunObject(ctx, updated) };
    },
  }),
  reviewQueue: defineAction({
    description: "Admin-only review queue of runs awaiting a human verdict.",
    request: z.object({}),
    response: z.object({
      items: z.array(
        z.object({
          runId: z.number(),
          userId: z.string(),
          userEmail: z.string(),
          note: z.string(),
          provenanceTier: z.string(),
          provenanceText: z.string(),
          provenanceVerdict: z.string(),
          checklistState: z.string(),
          status: z.string(),
          createdAt: z.string(),
          researchVerdict: z.string().nullable(),
        }),
      ),
    }),
    async handler(ctx) {
      const user = requireUser(ctx);
      const items = await reviewQueue(ctx.platform, user.email);
      return {
        items: items.map((i) => ({ ...i, createdAt: new Date(i.createdAt).toISOString() })),
      };
    },
  }),

  reviewRun: defineAction({
    description: "Admin-only human verdict on a run, with a logged reason.",
    request: z.object({
      runId: z.number().int().positive(),
      decision: z.enum(["approve", "reject", "publish", "hold"]),
      reason: z.string().trim().max(500),
    }),
    response: z.object({
      runId: z.number(),
      checklistState: z.enum(["none", "submitted", "approved", "rejected", "published", "hold"]),
    }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      return reviewRun(ctx.platform, user.email, args.runId, args.decision, args.reason);
    },
  }),
  listRuns: defineAction({
    description:
      "Lists the signed-in user's plate transcription runs, oldest first (chat order), with transcriptions and research results.",
    request: z.object({
      limit: z.number().int().positive().max(100).default(50),
    }),
    response: z.object({ runs: z.array(runObject) }),
    async handler(ctx, args) {
      const user = requireUser(ctx);
      const db = ctx.db();
      const rows = await db
        .select()
        .from(schema.runs)
        .where(eq(schema.runs.userId, user.id))
        .orderBy(asc(schema.runs.id))
        .limit(args.limit);
      const runs: z.infer<typeof runObject>[] = [];
      for (const row of rows) runs.push(await toRunObject(ctx, row));
      return { runs };
    },
  }),

  deleteRun: defineAction({
    description: "Deletes one transcription run and its stored plate photo.",
    request: z.object({ runId: z.number().int().positive() }),
    response: z.object({ ok: z.literal(true) }),
    async handler(ctx, args): Promise<{ ok: true }> {
      const user = requireUser(ctx);
      const db = ctx.db();
      const rows = await db
        .select()
        .from(schema.runs)
        .where(and(eq(schema.runs.id, args.runId), eq(schema.runs.userId, user.id)))
        .limit(1);
      const row = rows[0];
      if (row) {
        await ctx.blobs.delete(row.imageBlobKey);
        await db
          .delete(schema.runs)
          .where(and(eq(schema.runs.id, row.id), eq(schema.runs.userId, user.id)));
        ctx.invalidateQueries();
      }
      return { ok: true };
    },
  }),
} satisfies ActionsModule;
