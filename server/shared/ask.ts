// Per-run Q&A ("dig deeper"): answers questions from a run's SAVED outputs
// only — the blind transcription, the cross-reference research, and the
// sources. The plate image is never loaded, never passed, never referenced:
// the inference calls below take text prompts only, so re-reading the image
// is structurally impossible, not just forbidden by prompt.
//
// Two phases. Phase A answers from the run, or routes outward: questions
// asking for external/comparable material get web searches, whose results
// feed Phase B. Anything past the run's evidence that isn't a search task
// gets exactly "not established in this run". No quota enforcement here -
// caps are a later product decision.
import { z } from "zod";
import { billingError, billingRow, isPaid } from "./billing.ts";
import type { Platform } from "./platform";
import type { WebResult } from "./types";

export const NOT_ESTABLISHED = "not established in this run";

export interface AskIO {
  complete(prompt: string, opts: { schema: z.ZodTypeAny; system?: string }): Promise<unknown>;
  search(query: string): Promise<{ results: WebResult[]; unavailable: boolean }>;
}

export interface AskSource {
  title: string;
  url: string | null;
  source: string | null;
  snippet: string | null;
}

export interface AskResult {
  answer: string;
  searched: boolean;
  queries: string[];
  sources: AskSource[];
}

const phaseASchema = z.object({
  mode: z.enum(["answer", "search"]),
  answer: z.string(),
  queries: z.array(z.string()).max(3),
});

const phaseBSchema = z.object({ answer: z.string() });

const PLAIN_TONE =
  "Tone: plain information on demand. No greeting, no persona, no chatbot framing — just the answer.";

interface SavedTranscription {
  language?: unknown;
  summary?: unknown;
  printedCaptions?: unknown;
  lines?: unknown;
  uncertainReadings?: unknown;
  translation?: unknown;
}

interface SavedResearch {
  verdict?: unknown;
  verdictSummary?: unknown;
  agreements?: unknown;
  discrepancies?: unknown;
  sources?: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function buildContext(note: string, t: SavedTranscription, r: SavedResearch | null): string {
  const lines = Array.isArray(t.lines) ? t.lines : [];
  const out = [
    `USER NOTE: ${note || "(none)"}`,
    `SCRIPT/LANGUAGE: ${str(t.language) || "?"}`,
    `SUMMARY: ${str(t.summary) || "?"}`,
    `PRINTED CAPTIONS: ${strList(t.printedCaptions).join("; ") || "(none)"}`,
    "TRANSCRIPT LINES:",
    ...lines.map((l, i) => {
      const o = (l ?? {}) as { text?: unknown; legibility?: unknown };
      return `${i + 1}. (${str(o.legibility) || "?"}) ${str(o.text)}`;
    }),
    `UNCERTAIN READINGS: ${strList(t.uncertainReadings).join("; ") || "(none)"}`,
    `TRANSLATION: ${str(t.translation) || "(none)"}`,
  ];
  if (!r) {
    out.push("RESEARCH: not run yet for this run.");
    return out.join("\n");
  }
  const sources = Array.isArray(r.sources) ? r.sources : [];
  out.push(
    `RESEARCH VERDICT: ${str(r.verdict) || "?"} — ${str(r.verdictSummary)}`,
    `AGREEMENTS: ${strList(r.agreements).join("; ") || "(none)"}`,
    `DISCREPANCIES: ${strList(r.discrepancies).join("; ") || "(none)"}`,
    `SOURCES CHECKED: ${
      sources
        .map((s) => {
          const o = (s ?? {}) as { title?: unknown; url?: unknown; source?: unknown };
          return `${str(o.title) || "(untitled)"}${str(o.source) ? ` (${str(o.source)})` : ""}${str(o.url) ? ` <${str(o.url)}>` : ""}`;
        })
        .join("; ") || "(none)"
    }`,
  );
  return out.join("\n");
}

function buildShortSummary(t: SavedTranscription, r: SavedResearch | null): string {
  const base = `${str(t.language) || "Unknown script"}: ${str(t.summary) || "(no summary)"}`;
  if (!r) return `${base} Research has not run yet.`;
  return `${base} Research verdict: ${str(r.verdict) || "?"} — ${str(r.verdictSummary)}`;
}

export async function askRunQuestion(
  p: Platform,
  userId: string,
  runId: number,
  question: string,
  io: AskIO,
): Promise<AskResult> {
  const q = question.trim();
  if (!q) throw Object.assign(new Error("Ask a question first."), { status: 400 });

  const billing = await billingRow(p, userId);
  if (!billing.beta_access && !isPaid(billing)) {
    throw billingError("Question answering is available on Researcher and Institution plans.", 402);
  }

  // NOTE: image columns are deliberately not selected. Nothing below this
  // line can reach the plate photo even by accident.
  const row = (await p.raw
    .prepare("SELECT id, note, transcription, research FROM runs WHERE id = ? AND user_id = ?")
    .get(runId, userId)) as
    | { id: number; note: string; transcription: string; research: string | null }
    | undefined;
  if (!row) throw new Error("That run no longer exists.");

  let transcription: SavedTranscription;
  try {
    transcription = JSON.parse(row.transcription) as SavedTranscription;
  } catch {
    throw new Error("That run's saved transcription can't be read.");
  }
  let research: SavedResearch | null = null;
  if (row.research) {
    try {
      research = JSON.parse(row.research) as SavedResearch;
    } catch {
      research = null;
    }
  }

  const context = buildContext(row.note, transcription, research);
  const phaseA = phaseASchema.parse(
    await io.complete(
      `You answer questions about ONE plate-transcription run. You have ONLY the run's saved outputs below. The plate image itself is not available to you — never claim to look at it, re-read it, or see anything beyond these outputs.\n\nRUN OUTPUTS:\n${context}\n\nQUESTION:\n${q}\n\nDecide:\n- If the question is answered by the run outputs above, set mode to "answer" and answer ONLY from them.\n- If the question asks for external or comparable material (similar items elsewhere, other libraries or collections, published parallels beyond what the run found), set mode to "search" and give up to 3 web search queries. Leave "answer" empty.\n- If the question goes past what the run established AND does not ask for external material, set mode to "answer" and make the answer exactly this sentence, nothing else: ${NOT_ESTABLISHED}\n- Never invent readings, sources, shelfmarks, comparables, or holdings.`,
      { schema: phaseASchema, system: `You answer questions about one completed run. ${PLAIN_TONE}` },
    ),
  );

  if (phaseA.mode === "answer") {
    return { answer: phaseA.answer, searched: false, queries: [], sources: [] };
  }

  const queries = phaseA.queries.map((s) => s.trim()).filter(Boolean).slice(0, 3);
  const byKey = new Map<string, AskSource>();
  let unavailable = false;
  for (const query of queries) {
    const res = await io.search(query);
    if (res.unavailable) unavailable = true;
    for (const r of res.results) {
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
  const sourcesText = unavailable
    ? "(Web search is not configured on this server.)"
    : sources.length === 0
      ? "(no results)"
      : sources
          .map(
            (s, i) =>
              `[${i + 1}] ${s.title} (${s.source ?? "unknown source"})\n${s.snippet ?? "(no excerpt available)"}`,
          )
          .join("\n\n");

  const phaseB = phaseBSchema.parse(
    await io.complete(
      `A user asked a follow-up question about a plate-transcription run, requesting external or comparable material.\n\nQUESTION:\n${q}\n\nRUN SUMMARY (what this run established):\n${buildShortSummary(transcription, research)}\n\nWEB RESULTS (numbered):\n${sourcesText}\n\nReport the comparable material found in the results above, citing [n] numbers: what each item is, where it is held or published, and how it compares to this run's item. If the results contain no comparable material, say plainly that none was found. If search is unconfigured, say so plainly. Never invent a comparable, a holding, or a source. Never claim anything is unpublished, undiscovered, or a first reading.`,
      { schema: phaseBSchema, system: `You report comparable material from web results. ${PLAIN_TONE}` },
    ),
  );

  return { answer: phaseB.answer, searched: true, queries, sources };
}
