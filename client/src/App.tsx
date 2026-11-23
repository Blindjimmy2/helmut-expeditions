// Helmut — a chat-style blind-test bench.
//
// Drop a photo of a catalog plate and the run unfolds in the thread:
//   1. Blind transcription — the model reads ONLY the photo. No references.
//   2. Cross-reference research — starts automatically once the transcription
//      is saved, and compares it against published versions.
//
// The phase order is the whole point, so the UI shows it as a two-step rail
// on every run.
//
// Sign-in (same setup as Bottom Drawer): email first, then the 6-digit
// code from the email. Runs belong to the signed-in user.

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
} from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { SafeAreaTopScrim, fileToBase64 } from "./local";
import { api, type ApiResponse } from "./api";

type Run = ApiResponse<typeof api, "listRuns">["runs"][number];
type Transcription = Run["transcription"];
type Research = NonNullable<Run["research"]>;
type Usage = ApiResponse<typeof api, "usageSummary">;
type Billing = ApiResponse<typeof api, "billingStatus">;

/** Downscale a dropped photo to ≤1600px and re-encode as JPEG for scanning. */
async function prepareImage(
  file: File,
): Promise<{ dataBase64: string; mimeType: string }> {
  try {
    const bitmap = await createImageBitmap(file);
    const maxEdge = 1600;
    const scale = Math.min(
      1,
      maxEdge / Math.max(bitmap.width, bitmap.height),
    );
    if (scale >= 1 && (file.type === "image/jpeg" || file.type === "image/png")) {
      return await fileToBase64(file);
    }
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) return await fileToBase64(file);
    ctx2d.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.87);
    const dataBase64 = dataUrl.split(",")[1] ?? "";
    if (!dataBase64) return await fileToBase64(file);
    return { dataBase64, mimeType: "image/jpeg" };
  } catch {
    return await fileToBase64(file);
  }
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function LoginScreen({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function sendCode(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestSignInCode({ email: email.trim() });
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send the code.");
    } finally {
      setBusy(false);
    }
  }

  async function verify(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.verifySignInCode({ email: email.trim(), code: code.trim() });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code didn't work.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-6 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-5">
      <p className="font-display text-lg text-[var(--text)]">Sign in</p>
      {!sent ? (
        <form onSubmit={sendCode} className="mt-3">
          <label htmlFor="login-email" className="text-sm text-[var(--dim)]">
            Email address
          </label>
          <input
            id="login-email"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@university.edu"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526] disabled:opacity-50"
          >
            {busy ? "Sending…" : "Email me a sign-in code"}
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="mt-3">
          <p className="text-sm text-[var(--dim)]">
            Code sent to <span className="font-medium text-[var(--text)]">{email.trim()}</span>{" "}
            <button
              type="button"
              className="underline underline-offset-2"
              onClick={() => {
                setSent(false);
                setCode("");
                setError(null);
              }}
            >
              change
            </button>
          </p>
          <label htmlFor="login-code" className="mt-3 block text-sm text-[var(--dim)]">
            6-digit code
          </label>
          <input
            id="login-code"
            name="code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            required
            value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="000000"
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-center font-transcript text-lg tracking-[0.3em] text-[var(--text)] placeholder:text-[var(--dim)]"
          />
          <button
            type="submit"
            disabled={busy}
            className="mt-3 w-full rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526] disabled:opacity-50"
          >
            {busy ? "Checking…" : "Sign in"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={(e) => void sendCode(e as unknown as FormEvent)}
            className="mt-2 w-full text-sm text-[var(--dim)] underline underline-offset-2 disabled:opacity-50"
          >
            Resend code
          </button>
        </form>
      )}
      {error && (
        <p role="alert" className="mt-3 text-sm font-medium text-[var(--accent)]">
          {error}
        </p>
      )}
    </div>
  );
}

const LEGIBILITY_STYLE: Record<Transcription["lines"][number]["legibility"], string> = {
  clear: "bg-emerald-600",
  partial: "bg-amber-500",
  faint: "bg-orange-400",
  illegible: "bg-red-500",
};

function PhaseBadge({ n, label }: { n: number; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] font-display text-sm font-bold text-[#0b1526]">
        {n}
      </span>
      <span className="font-display text-base font-semibold tracking-wide text-[var(--text)]">
        {label}
      </span>
    </div>
  );
}

function TranscriptionView({ t }: { t: Transcription }) {
  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-sm">
        <span className="text-[var(--dim)]">Script / language</span>
        <span className="font-medium text-[var(--text)]">{t.language}</span>
        {t.printedCaptions.length > 0 && (
          <>
            <span className="text-[var(--dim)]">Printed on plate</span>
            <span className="font-transcript text-[var(--text)]">
              {t.printedCaptions.join(" · ")}
            </span>
          </>
        )}
      </div>

      <p className="mt-2 text-sm leading-relaxed text-[var(--text)]">
        {t.summary}
      </p>

      {/* The transcript itself: ruled lines, typewriter type. */}
      <div className="mt-3 border-y border-[var(--border)]">
        {t.lines.length === 0 && (
          <p className="py-3 font-transcript text-sm text-[var(--dim)]">
            No legible text lines could be read from this photo.
          </p>
        )}
        {t.lines.map((line, i) => (
          <div
            key={i}
            className="flex items-baseline gap-2 border-b border-[var(--border)] py-1.5 last:border-b-0"
          >
            <span className="w-6 shrink-0 text-right font-transcript text-xs text-[var(--dim)]">
              {i + 1}
            </span>
            <span
              aria-hidden
              className={`h-2 w-2 shrink-0 translate-y-[-1px] rounded-full ${LEGIBILITY_STYLE[line.legibility]}`}
            />
            <span className="font-transcript text-sm leading-relaxed text-[var(--text)]">
              {line.text}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-1.5 text-xs text-[var(--dim)]">
        Dot = legibility of that line: green clear · amber partial · orange
        faint · red illegible. [?] marks characters that could not be read.
      </p>
      {t.translation && (
        <div className="mt-3 rounded-lg border border-[var(--border)] p-3">
          <p className="text-sm font-medium text-[var(--text)]">Blind translation</p>
          <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">{t.translation}</p>
          <p className="mt-1.5 text-xs text-[var(--dim)]">Translated from the blind draft above - gaps and hedges carry through.</p>
        </div>
      )}

      <div className="mt-3 space-y-2 text-sm leading-relaxed">
        <p>
          <span className="font-medium text-[var(--text)]">The object: </span>
          <span className="text-[var(--text)]">{t.materialDescription}</span>
        </p>
        <p>
          <span className="font-medium text-[var(--text)]">Figures: </span>
          <span className="text-[var(--text)]">{t.figureDescription}</span>
        </p>
        {t.uncertainReadings.length > 0 && (
          <div>
            <p className="font-medium text-[var(--text)]">Uncertain readings</p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5 text-[var(--text)]">
              {t.uncertainReadings.map((u, i) => (
                <li key={i}>{u}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

const VERDICT_LABEL: Record<Research["verdict"], string> = {
  match_found: "Published version found",
  partial: "Partially identified",
  no_published_version_found: "Inconclusive findings",
};

function ResearchView({ r, run, onSubmit, submitting }: { r: Research; run: Run; onSubmit: (runId: number) => void; submitting: boolean }) {
  return (
    <div className="mt-3">
      <p className="font-display text-lg font-semibold text-[var(--text)]">
        {VERDICT_LABEL[r.verdict]}
      </p>
      <p className="mt-1 text-sm leading-relaxed text-[var(--text)]">
        {r.verdictSummary}
      </p>
      {r.verdict === "no_published_version_found" && (run.checklistState === "none" || run.checklistState === "rejected") && (
        run.provenanceVerdict !== "quarantine" ? (
          <div className="mt-3 rounded-lg border border-[var(--accent)] p-3">
            <p className="text-sm text-[var(--text)]">No match found anywhere searched. This may be worth human verification.</p>
            <button type="button" disabled={submitting} onClick={() => onSubmit(run.id)} className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526] disabled:opacity-50">
              {submitting ? "Submitting..." : "Submit for human verification"}
            </button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-[var(--dim)]">Stays in your library. State where it is held (above) to unlock the verification track.</p>
        )
      )}

      {r.agreements.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-[var(--text)]">
            Where the blind read agrees
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-[var(--text)]">
            {r.agreements.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </div>
      )}

      {r.discrepancies.length > 0 && (
        <div className="mt-3">
          <p className="text-sm font-medium text-[var(--accent)]">
            Discrepancies against the blind read
          </p>
          <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm leading-relaxed text-[var(--text)]">
            {r.discrepancies.map((d, i) => (
              <li key={i}>{d}</li>
            ))}
          </ul>
        </div>
      )}

      {r.sources.length > 0 && (
        <div className="mt-4 border-t border-[var(--border)] pt-3">
          <p className="text-sm font-medium text-[var(--text)]">Sources checked</p>
          <ul className="mt-1.5 space-y-2">
            {r.sources.map((s, i) => (
              <li key={i} className="text-sm">
                {s.url ? (
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-[var(--accent)] underline decoration-dotted underline-offset-2"
                  >
                    {s.title}
                  </a>
                ) : (
                  <span className="font-medium text-[var(--text)]">{s.title}</span>
                )}
                {s.source && (
                  <span className="text-[var(--dim)]"> — {s.source}</span>
                )}
                {s.snippet && (
                  <span className="block text-xs leading-relaxed text-[var(--dim)]">
                    {s.snippet.length > 220
                      ? `${s.snippet.slice(0, 220)}…`
                      : s.snippet}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p className="mt-3 text-xs text-[var(--dim)]">
        Searched for: {r.queries.join(" · ")}
      </p>
    </div>
  );
}

function fmtInt(n: number): string {
  return n.toLocaleString("en-US");
}

function useStoredNumber(key: string, fallback: string): [string, (v: string) => void] {
  const [val, setVal] = useState(() => {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  });
  return [
    val,
    (v: string) => {
      setVal(v);
      try {
        window.localStorage.setItem(key, v);
      } catch {
        /* storage unavailable */
      }
    },
  ];
}

function UsageSection() {
  const usageQuery = useQuery({
    queryKey: ["usage"],
    queryFn: () => api.usageSummary({ days: 30 }),
  });
  const [priceIn, setPriceIn] = useStoredNumber("plate-price-in", "");
  const [priceOut, setPriceOut] = useStoredNumber("plate-price-out", "");
  const inRate = Number(priceIn) || 0;
  const outRate = Number(priceOut) || 0;
  const cost = (i: number, o: number) => (i / 1e6) * inRate + (o / 1e6) * outRate;
  const money = (v: number) => (inRate > 0 || outRate > 0 ? `$${v.toFixed(4)}` : "—");
  const u: Usage | undefined = usageQuery.data;
  const tIn = (u?.totals.transcribe.inputTokens ?? 0) + (u?.totals.compare.inputTokens ?? 0) + (u?.totals.ask.inputTokens ?? 0);
  const tOut =
    (u?.totals.transcribe.outputTokens ?? 0) +
    (u?.totals.transcribe.reasoningTokens ?? 0) +
    (u?.totals.compare.outputTokens ?? 0) +
    (u?.totals.compare.reasoningTokens ?? 0) +
    (u?.totals.ask.outputTokens ?? 0) +
    (u?.totals.ask.reasoningTokens ?? 0);
  return (
    <section aria-label="Usage and cost" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="font-display text-base font-semibold text-[var(--text)]">
        Usage &amp; cost basis <span className="text-sm font-normal text-[var(--dim)]">(30 days)</span>
      </p>
      <div className="mt-2 flex flex-wrap items-end gap-3 text-sm">
        <label className="text-[var(--dim)]">
          $/M input tokens{" "}
          <input
            value={priceIn}
            onChange={(e) => setPriceIn(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="ml-1 w-20 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <label className="text-[var(--dim)]">
          $/M output tokens{" "}
          <input
            value={priceOut}
            onChange={(e) => setPriceOut(e.target.value)}
            inputMode="decimal"
            placeholder="0.00"
            className="ml-1 w-20 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-sm text-[var(--text)]"
          />
        </label>
        <span className="text-xs text-[var(--dim)]">Reasoning tokens billed as output.</span>
      </div>
      {usageQuery.isPending && <p className="mt-2 text-sm text-[var(--dim)]">Loading usage…</p>}
      {u && (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[var(--border)] text-xs text-[var(--dim)]">
                <th className="py-1 pr-3 font-medium">Phase</th>
                <th className="py-1 pr-3 font-medium">Calls</th>
                <th className="py-1 pr-3 font-medium">In</th>
                <th className="py-1 pr-3 font-medium">Out+reason</th>
                <th className="py-1 pr-3 font-medium">Avg ms</th>
                <th className="py-1 font-medium">Est.</th>
              </tr>
            </thead>
            <tbody className="text-[var(--text)]">
              {(["transcribe", "compare", "ask"] as const).map((k) => {
                const r = u.totals[k];
                const out = r.outputTokens + r.reasoningTokens;
                return (
                  <tr key={k} className="border-b border-[var(--border)] last:border-b-0">
                    <td className="py-1 pr-3">{k === "transcribe" ? "Phase 1" : k === "compare" ? "Phase 2 compare" : "Q&A"}</td>
                    <td className="py-1 pr-3">{fmtInt(r.calls)}</td>
                    <td className="py-1 pr-3">{fmtInt(r.inputTokens)}</td>
                    <td className="py-1 pr-3">{fmtInt(out)}</td>
                    <td className="py-1 pr-3">{fmtInt(r.avgLatencyMs)}</td>
                    <td className="py-1">{money(cost(r.inputTokens, out))}</td>
                  </tr>
                );
              })}
              <tr className="border-b border-[var(--border)] last:border-b-0">
                <td className="py-1 pr-3">Searches</td>
                <td className="py-1 pr-3">{fmtInt(u.totals.search.calls)}</td>
                <td className="py-1 pr-3" colSpan={4}>
                  flat per-request (see Brave plan)
                </td>
              </tr>
              <tr className="font-medium">
                <td className="py-1 pr-3">Total</td>
                <td className="py-1 pr-3">{fmtInt(u.totals.transcribe.calls + u.totals.compare.calls)}</td>
                <td className="py-1 pr-3">{fmtInt(tIn)}</td>
                <td className="py-1 pr-3">{fmtInt(tOut)}</td>
                <td className="py-1 pr-3">—</td>
                <td className="py-1">{money(cost(tIn, tOut))}</td>
              </tr>
            </tbody>
          </table>
          <details className="mt-3 text-sm">
            <summary className="cursor-pointer text-[var(--dim)]">Per-run breakdown</summary>
            <table className="mt-1 w-full text-left text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] text-xs text-[var(--dim)]">
                  <th className="py-1 pr-3 font-medium">Run</th>
                  <th className="py-1 pr-3 font-medium">P1 in/out</th>
                  <th className="py-1 pr-3 font-medium">P2 in/out</th>
                  <th className="py-1 pr-3 font-medium">Search</th>
                  <th className="py-1 font-medium">Est.</th>
                </tr>
              </thead>
              <tbody className="text-[var(--text)]">
                {u.byRun.map((r) => {
                  const ri = (r.transcribe?.inputTokens ?? 0) + (r.compare?.inputTokens ?? 0);
                  const ro =
                    (r.transcribe?.outputTokens ?? 0) +
                    (r.transcribe?.reasoningTokens ?? 0) +
                    (r.compare?.outputTokens ?? 0) +
                    (r.compare?.reasoningTokens ?? 0);
                  return (
                    <tr key={r.runId} className="border-b border-[var(--border)] last:border-b-0">
                      <td className="py-1 pr-3">#{r.runId}{r.note ? ` ${r.note.slice(0, 24)}` : ""}</td>
                      <td className="py-1 pr-3">
                        {r.transcribe ? `${fmtInt(r.transcribe.inputTokens)}/${fmtInt(r.transcribe.outputTokens + r.transcribe.reasoningTokens)}` : "—"}
                      </td>
                      <td className="py-1 pr-3">
                        {r.compare ? `${fmtInt(r.compare.inputTokens)}/${fmtInt(r.compare.outputTokens + r.compare.reasoningTokens)}` : "—"}
                      </td>
                      <td className="py-1 pr-3">{r.searches}</td>
                      <td className="py-1">{money(cost(ri, ro))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </details>
        </div>
      )}
    </section>
  );
}

function BillingSection() {
  const billingQuery = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.billingStatus({}),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  async function go(tag: string, fn: () => Promise<{ url: string | null }>) {
    setBusy(tag);
    setError(null);
    try {
      const r = await fn();
      if (r.url) window.location.href = r.url;
      else setError("Checkout did not return a payment link.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Billing failed.");
    } finally {
      setBusy(null);
    }
  }
  async function sync() {
    setBusy("sync");
    setError(null);
    try {
      await api.syncBilling({});
      await billingQuery.refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sync failed.");
    } finally {
      setBusy(null);
    }
  }
  const b: Billing | undefined = billingQuery.data;
  return (
    <section aria-label="Billing" className="mt-4 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="font-display text-base font-semibold text-[var(--text)]">Plan &amp; billing</p>
      {billingQuery.isPending && <p className="mt-2 text-sm text-[var(--dim)]">Loading plan…</p>}
      {b && (
        <div className="mt-2 text-sm">
          {b.paid ? (
            <p className="text-[var(--text)]">
              <span className="font-medium capitalize">{b.plan}</span> active
              {b.paidUntil > 0 ? ` until ${formatTime(new Date(b.paidUntil * 1000).toISOString())}` : ""}
              {b.cancelAtPeriodEnd ? " (cancels at period end)" : ""}
            </p>
          ) : (
            <p className="text-[var(--text)]">
              Free plan — <span className="font-medium">{b.freeRuns} free runs left</span>
              {b.betaAccess ? " (beta access: unlimited)" : ""}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {!b.paid && (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void go("researcher", () => api.startCheckout({ plan: "researcher" }))}
                  className="rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526] disabled:opacity-50"
                >
                  {busy === "researcher" ? "Working…" : "Researcher — $20/mo"}
                </button>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void go("institution", () => api.startCheckout({ plan: "institution" }))}
                  className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
                >
                  {busy === "institution" ? "Working…" : "Institution — $100/mo"}
                </button>
              </>
            )}
            {b.canManage && (
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => void go("portal", () => api.billingPortal({}))}
                className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--text)] disabled:opacity-50"
              >
                {busy === "portal" ? "Working…" : "Manage billing"}
              </button>
            )}
            <button
              type="button"
              disabled={busy !== null}
              onClick={() => void sync()}
              className="rounded-lg border border-[var(--border)] px-4 py-2 text-sm text-[var(--dim)] disabled:opacity-50"
            >
              {busy === "sync" ? "Checking…" : "Refresh status"}
            </button>
          </div>
          {!b.configured && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              Billing keys are not configured on this server yet — checkout will fail until they are.
            </p>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--accent)]">
          {error}
        </p>
      )}
    </section>
  );
}

function ReviewSection({ onOpen }: { onOpen: (id: number) => void }) {
  const queryClient = useQueryClient();
  const queueQuery = useQuery({ queryKey: ["review-queue"], queryFn: () => api.reviewQueue({}) });
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  async function decide(runId: number, decision: "approve" | "reject" | "publish" | "hold") {
    const reason = (reasons[runId] ?? "").trim();
    if (!reason) {
      setError("A reason is required for every verdict.");
      return;
    }
    setBusyId(runId);
    setError(null);
    try {
      await api.reviewRun({ runId, decision, reason });
      setReasons((r) => ({ ...r, [runId]: "" }));
      await queueQuery.refetch();
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Verdict failed.");
    } finally {
      setBusyId(null);
    }
  }
  const items = queueQuery.data?.items ?? [];
  return (
    <section aria-label="Review queue" className="mt-4 rounded-[var(--radius)] border border-[var(--accent)] bg-[var(--surface)] p-4">
      <p className="font-display text-base font-semibold text-[var(--text)]">
        Review queue <span className="text-sm font-normal text-[var(--dim)]">({items.length} awaiting - admin only)</span>
      </p>
      {queueQuery.isPending && <p className="mt-2 text-sm text-[var(--dim)]">Loading queue...</p>}
      {!queueQuery.isPending && items.length === 0 && (
        <p className="mt-2 text-sm text-[var(--dim)]">Queue is clear. Nothing awaiting a human verdict.</p>
      )}
      <div className="mt-3 space-y-3">
        {items.map((i) => (
          <div key={i.runId} className="rounded-lg border border-[var(--border)] p-3">
            <p className="text-sm text-[var(--text)]">
              <span className="font-medium">Run #{i.runId}</span> by {i.userEmail}
              {i.note ? ` - ${i.note}` : ""}
            </p>
            <p className="mt-0.5 text-xs text-[var(--dim)]">
              {i.provenanceTier} | {i.provenanceText || "no holding"} | research: {i.researchVerdict ?? "pending"} | {formatTime(i.createdAt)}
            </p>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                value={reasons[i.runId] ?? ""}
                onChange={(e) => setReasons((r) => ({ ...r, [i.runId]: e.target.value }))}
                placeholder="Reason (required, logged forever)"
                maxLength={500}
                className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1.5 text-sm text-[var(--text)]"
              />
            </div>
            <div className="mt-2 flex flex-wrap gap-2">
              {(["approve", "reject", "publish", "hold"] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  disabled={busyId !== null}
                  onClick={() => void decide(i.runId, d)}
                  className="rounded-lg border border-[var(--border)] px-3 py-1 text-sm text-[var(--text)] disabled:opacity-50"
                >
                  {busyId === i.runId ? "Working..." : d.charAt(0).toUpperCase() + d.slice(1)}
                </button>
              ))}
              <button
                type="button"
                onClick={() => onOpen(i.runId)}
                className="rounded-lg px-3 py-1 text-sm text-[var(--dim)] underline underline-offset-2"
              >
                Open run
              </button>
            </div>
          </div>
        ))}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--accent)]">
          {error}
        </p>
      )}
    </section>
  );
}

function LibraryPanel({ runs, onSelect, onClose }: { runs: Run[]; onSelect: (id: number) => void; onClose: () => void }) {
  const items = [...runs].reverse();
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-end bg-black/40" onClick={onClose} role="dialog" aria-label="Your library">
      <div className="w-full max-w-sm overflow-y-auto bg-[var(--bg)] p-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <p className="font-display text-lg text-[var(--text)]">Your library</p>
          <button type="button" onClick={onClose} className="text-sm text-[var(--dim)] underline underline-offset-2">
            Close
          </button>
        </div>
        <p className="mt-1 text-sm text-[var(--dim)]">
          {runs.length} plate{runs.length === 1 ? "" : "s"} - newest first.
        </p>
        <div className="mt-3 space-y-2">
          {items.map((r) => (
            <button
              key={r.id}
              type="button"
              onClick={() => onSelect(r.id)}
              className="flex w-full items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-2 text-left"
            >
              <img src={r.imageUrl} alt="" className="h-14 w-14 shrink-0 rounded object-cover" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-[var(--text)]">
                  #{r.id}{r.note ? ` - ${r.note}` : ""}
                </span>
                <span className="block text-xs text-[var(--dim)]">
                  {formatTime(r.createdAt)} | {r.research ? VERDICT_LABEL[r.research.verdict] : "Transcribed"}{r.checklistState !== "none" ? ` | ${r.checklistState}` : ""}
                </span>
              </span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ProvenanceLine({ run }: { run: Run }) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(run.provenanceText);
  const [busy, setBusy] = useState(false);
  const editable = run.checklistState === "none" || run.checklistState === "rejected";
  async function save() {
    setBusy(true);
    try {
      await api.setRunProvenance({ runId: run.id, provenance: text.trim() });
      setEditing(false);
      queryClient.invalidateQueries({ queryKey: ["runs"] });
    } finally {
      setBusy(false);
    }
  }
  if (!editing) {
    return (
      <p className="mt-0.5 text-right text-xs text-[var(--dim)]">
        {run.provenanceText ? `${run.provenanceText} - ${run.provenanceTier}` : `Provenance ${run.provenanceTier}`}
        {run.provenanceVerdict === "quarantine" ? " - not on verification track" : ""}
        {editable && (
          <>
            {" "}
            <button type="button" className="underline underline-offset-2" onClick={() => { setText(run.provenanceText); setEditing(true); }}>
              {run.provenanceText ? "Change" : "Add holding"}
            </button>
          </>
        )}
      </p>
    );
  }
  return (
    <div className="mt-1 flex items-center justify-end gap-2">
      <input value={text} onChange={(e) => setText(e.target.value)} maxLength={300} placeholder="Held at, e.g. Yale Beinecke"
        className="w-64 max-w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-2 py-1 text-xs text-[var(--text)]" />
      <button type="button" disabled={busy} onClick={() => void save()} className="text-xs font-medium text-[var(--accent)] disabled:opacity-50">Save</button>
      <button type="button" onClick={() => setEditing(false)} className="text-xs text-[var(--dim)]">Cancel</button>
    </div>
  );
}
type AskResult = ApiResponse<typeof api, "askRunQuestion">;

function AskBox({ runId }: { runId: number }) {
  const billingQuery = useQuery({
    queryKey: ["billing"],
    queryFn: () => api.billingStatus({}),
  });
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const canAsk = billingQuery.data?.paid === true || billingQuery.data?.betaAccess === true;
  const decided = !billingQuery.isPending;

  async function ask() {
    const q = question.trim();
    if (!q || busy) return;
    setBusy(true);
    setError(null);
    try {
      setResult(await api.askRunQuestion({ runId, question: q }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "The question failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
      <p className="text-sm font-medium text-[var(--text)]">Ask about this run</p>
      <div className="mt-2 flex gap-2">
        <label htmlFor={`ask-${runId}`} className="sr-only">
          Ask a question about this run
        </label>
        <input
          id={`ask-${runId}`}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void ask();
          }}
          placeholder={decided && !canAsk ? "Available on Researcher and Institution plans." : "Ask a question about this run"}
          disabled={busy || !canAsk}
          maxLength={1000}
          className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2 text-sm text-[var(--text)] placeholder:text-[var(--dim)] disabled:opacity-50"
        />
        <button
          type="button"
          disabled={busy || !canAsk || !question.trim()}
          onClick={() => void ask()}
          className="shrink-0 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526] disabled:opacity-50"
        >
          {busy ? "Asking…" : "Ask"}
        </button>
      </div>
      {decided && !canAsk && (
        <p className="mt-2 text-xs text-[var(--dim)]">
          Question answering is available on Researcher and Institution plans.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-sm font-medium text-[var(--accent)]">
          {error}
        </p>
      )}
      {result && (
        <div className="mt-3 border-t border-[var(--border)] pt-3">
          <p className="whitespace-pre-wrap text-sm leading-relaxed text-[var(--text)]">
            {result.answer}
          </p>
          {result.searched && result.sources.length > 0 && (
            <ul className="mt-2 space-y-1.5">
              {result.sources.map((s, i) => (
                <li key={i} className="text-sm">
                  {s.url ? (
                    <a
                      href={s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="font-medium text-[var(--accent)] underline decoration-dotted underline-offset-2"
                    >
                      [{i + 1}] {s.title}
                    </a>
                  ) : (
                    <span className="font-medium text-[var(--text)]">
                      [{i + 1}] {s.title}
                    </span>
                  )}
                  {s.snippet && (
                    <span className="block text-xs leading-relaxed text-[var(--dim)]">
                      {s.snippet.length > 220 ? `${s.snippet.slice(0, 220)}…` : s.snippet}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
          {result.searched && (
            <p className="mt-2 text-xs text-[var(--dim)]">
              Searched for: {result.queries.join(" · ") || "—"}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

function RunThread({
  run,
  researching,
  highlight,
  submitting,
  onResearch,
  onDelete,
  onSubmit,
}: {
  run: Run;
  researching: boolean;
  highlight: boolean;
  submitting: boolean;
  onResearch: (runId: number) => void;
  onDelete: (runId: number) => void;
  onSubmit: (runId: number) => void;
}) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  return (
    <section id={`run-${run.id}`} aria-label={`Plate run ${run.id}`} className={highlight ? "space-y-3 rounded-[var(--radius)] outline outline-2 outline-[var(--accent)]" : "space-y-3"}>
      {/* The user's message: the dropped photo. */}
      <div className="flex justify-end">
        <div className="max-w-[85%] sm:max-w-[60%]">
          <img
            src={run.imageUrl}
            alt={run.note ? `Plate photo — ${run.note}` : "Plate photo"}
            className="max-h-72 w-auto rounded-lg border border-[var(--border)] object-contain"
          />
          {run.note && (
            <p className="mt-1 text-right text-sm text-[var(--text)]">
              {run.note}
            </p>
          )}
          <ProvenanceLine run={run} />
          {run.checklistState !== "none" && (
            <p className="mt-0.5 text-right text-xs text-[var(--dim)]">
              Verification: {run.checklistState}
            </p>
          )}
          <p className="mt-0.5 text-right text-xs text-[var(--dim)]">
            {formatTime(run.createdAt)}
          </p>
        </div>
      </div>

      {/* Phase 1 card */}
      <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <div className="flex items-start justify-between gap-3">
          <PhaseBadge n={1} label="Blind transcription" />
          <span className="shrink-0 rounded-full border border-[var(--border)] px-2 py-0.5 text-xs text-[var(--dim)]">
            No references consulted
          </span>
        </div>
        <TranscriptionView t={run.transcription} />
      </article>

      {/* Phase 2 card */}
      <article className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface)] p-4">
        <PhaseBadge n={2} label="Cross-reference research" />
        {run.research ? (
          <>
            <ResearchView r={run.research} run={run} onSubmit={onSubmit} submitting={submitting} />
            <p className="mt-3 text-xs text-[var(--dim)]">
              Researched {run.researchedAt ? formatTime(run.researchedAt) : ""}
              {" · "}
              <button
                type="button"
                className="underline underline-offset-2"
                disabled={researching}
                onClick={() => onResearch(run.id)}
              >
                {researching ? "Researching…" : "Re-run research"}
              </button>
            </p>
          </>
        ) : researching ? (
          <p className="mt-3 text-sm text-[var(--dim)]" role="status">
            Searching for published versions to compare against the blind
            transcription…
          </p>
        ) : (
          <div className="mt-3">
            <p className="text-sm text-[var(--dim)]">
              Research hasn't run for this plate yet.
            </p>
            <button
              type="button"
              className="mt-2 rounded-lg bg-[var(--accent)] px-4 py-2 text-sm font-medium text-[#0b1526]"
              onClick={() => onResearch(run.id)}
            >
              Research cross-references
            </button>
          </div>
        )}
      </article>

      <AskBox runId={run.id} />

      <div className="flex justify-end">
      {run.research && (run.checklistState === "none" || run.checklistState === "rejected") && run.provenanceVerdict !== "quarantine" && (
        <div className="flex justify-end">
          <button
            type="button"
            disabled={submitting}
            onClick={() => onSubmit(run.id)}
            className="rounded-lg border border-[var(--accent)] px-4 py-2 text-sm font-medium text-[var(--accent)] disabled:opacity-50"
          >
            {submitting ? "Submitting..." : "Submit for human verification"}
          </button>
        </div>
      )}
      {run.research && run.provenanceVerdict === "quarantine" && (run.checklistState === "none" || run.checklistState === "rejected") && (
        <p className="text-right text-xs text-[var(--dim)]">
          Stays in your library. Add holding information to unlock the verification track.
        </p>
      )}

        {confirmingDelete ? (
          <span className="flex items-center gap-3 text-sm">
            <span className="text-[var(--dim)]">Delete this run?</span>
            <button
              type="button"
              className="font-medium text-[var(--accent)]"
              onClick={() => onDelete(run.id)}
            >
              Delete
            </button>
            <button
              type="button"
              className="text-[var(--dim)]"
              onClick={() => setConfirmingDelete(false)}
            >
              Keep
            </button>
          </span>
        ) : (
          <button
            type="button"
            aria-label={`Delete run ${run.id}`}
            className="px-2 text-xs text-[var(--dim)] underline-offset-2 hover:underline"
            onClick={() => setConfirmingDelete(true)}
          >
            Delete run
          </button>
        )}
      </div>
    </section>
  );
}

export function App() {
  const queryClient = useQueryClient();
  const [note, setNote] = useState("");
  const [prov, setProv] = useState("");
  const [dragging, setDragging] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [researchingId, setResearchingId] = useState<number | null>(null);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [highlightId, setHighlightId] = useState<number | null>(null);
  const [submittingId, setSubmittingId] = useState<number | null>(null);
  const [pendingScrollId, setPendingScrollId] = useState<number | null>(null);
  const jumpedRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);

  const meQuery = useQuery({
    queryKey: ["me"],
    queryFn: () => api.currentUser({}),
    retry: false,
  });
  const me = meQuery.data?.user ?? null;

  const runsQuery = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns({ limit: 50 }),
    enabled: me != null,
  });
  const runs = runsQuery.data?.runs ?? [];

  // A dead session surfaces as a runs failure — re-check who we are so a
  // signed-out user falls back to the login screen instead of an error.
  useEffect(() => {
    if (runsQuery.error) void meQuery.refetch();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runsQuery.error]);

  const logoutMutation = useMutation({
    mutationFn: async () => await api.logout({}),
    onSettled: () => {
      queryClient.setQueryData(["me"], { user: null });
      queryClient.setQueryData(["runs"], { runs: [] });
    },
  });

  const researchMutation = useMutation({
    mutationFn: async (runId: number) => await api.researchRun({ runId }),
    onMutate: (runId) => setResearchingId(runId),
    onSettled: () => setResearchingId(null),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });

  const transcribeMutation = useMutation({
    mutationFn: async (input: {
      image: { dataBase64: string; mimeType: string };
      note: string;
      provenance: string;
    }) => await api.transcribePlate(input),
    onSuccess: (data) => {
      setNote("");
      setPreviewUrl(null);
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["usage"] });
      // Phase 2 starts only now — after the blind transcription is saved.
      setPendingScrollId(data.run.id);
      researchMutation.mutate(data.run.id);
    },
    onError: () => setPreviewUrl(null),
  });

  const submitMutation = useMutation({
    mutationFn: async (runId: number) => await api.submitForReview({ runId }),
    onMutate: (runId) => setSubmittingId(runId),
    onSettled: () => setSubmittingId(null),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["review-queue"] });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (runId: number) => await api.deleteRun({ runId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["runs"] }),
  });

  const busy = transcribeMutation.isPending;
  const stage = transcribeMutation.isPending
    ? "Phase 1 · Blind transcription — reading only your photo, no references…"
    : researchingId != null
      ? "Phase 2 · Researching cross-references…"
      : null;

  async function handleFile(file: File) {
    if (busy) return;
    if (!file.type.startsWith("image/")) return;
    setPreviewUrl(URL.createObjectURL(file));
    const image = await prepareImage(file);
    transcribeMutation.mutate({ image, note: note.trim(), provenance: prov.trim() });
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (!me) return;
    const file = e.dataTransfer.files?.[0];
    if (file) void handleFile(file);
  }

  function onPick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) void handleFile(file);
  }

  // After a Stripe checkout redirect, poll for the new subscription state.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("billing") === "success") {
      window.history.replaceState({}, "", window.location.pathname);
      api
        .syncBilling({})
        .then(() => {
          queryClient.invalidateQueries({ queryKey: ["billing"] });
          queryClient.invalidateQueries({ queryKey: ["runs"] });
        })
        .catch(() => {});
    } else if (params.get("billing")) {
      window.history.replaceState({}, "", window.location.pathname);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function selectRun(id: number) {
    setLibraryOpen(false);
    setHighlightId(id);
    requestAnimationFrame(() => {
      document.getElementById(`run-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    window.setTimeout(() => setHighlightId((cur) => (cur === id ? null : cur)), 2500);
  }

  useEffect(() => {
    if (jumpedRef.current || runs.length === 0) return;
    const id = Number(new URLSearchParams(window.location.search).get("run"));
    if (id > 0) {
      jumpedRef.current = true;
      selectRun(id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs.length]);

  // After a drop, scroll to the new run card itself once it renders,
  // then highlight it briefly so it is unmissable.
  useEffect(() => {
    if (pendingScrollId == null) return;
    if (!runs.some((r) => r.id === pendingScrollId)) return;
    document.getElementById(`run-${pendingScrollId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setHighlightId(pendingScrollId);
    setPendingScrollId(null);
    window.setTimeout(() => setHighlightId((cur) => (cur === pendingScrollId ? null : cur)), 2500);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runs, pendingScrollId]);

  return (
    <div
      className="flex min-h-screen flex-col bg-[var(--bg)]"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <SafeAreaTopScrim backgroundColor="var(--bg)" />

      {/* Composer / drop target */}
      {me && (
        <div
          className={`sticky top-0 z-10 border-b border-[var(--border)] bg-[var(--surface)] px-4 pt-3 ${
            dragging ? "outline outline-2 outline-[var(--accent)]" : ""
          }`}
        >
          <div className={`mx-auto w-full max-w-2xl ${libraryOpen ? "lg:mr-96" : ""}`}>
            {stage && (
              <p role="status" className="pb-2 text-sm font-medium text-[var(--accent)]">
                {stage}
              </p>
            )}
            {(transcribeMutation.error ?? researchMutation.error ?? submitMutation.error) && (
              <p role="alert" className="pb-2 text-sm font-medium text-[var(--accent)]">
                {(transcribeMutation.error ?? researchMutation.error ?? submitMutation.error) instanceof Error
                  ? ((transcribeMutation.error ?? researchMutation.error ?? submitMutation.error) as Error).message
                  : "Something failed."}
              </p>
            )}
            <div className="flex items-center gap-2 pb-3">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                aria-label="Choose a plate photo"
                onChange={onPick}
              />
              <button
                type="button"
                aria-label="Add a plate photo"
                disabled={busy}
                onClick={() => fileInputRef.current?.click()}
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-2xl leading-none text-[#0b1526] disabled:opacity-50"
              >
                +
              </button>
              <div className="min-w-0 flex-1">
                <label htmlFor="plate-note" className="sr-only">
                  Note about this plate (optional)
                </label>
                <input
                  id="plate-note"
                  name="note" maxLength={300}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Note for the research phase — e.g. “Kraus catalog, plate 55”. The transcriber never sees it."
                  className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
                />
                <label htmlFor="plate-prov" className="sr-only">
              Holding collection or library (optional)
            </label>
            <input
              id="plate-prov"
              name="provenance" maxLength={300}
              value={prov}
              onChange={(e) => setProv(e.target.value)}
              placeholder="Held at — e.g. “Yale Beinecke”. Needed for the verification track."
              className="mt-2 w-full rounded-lg border border-[var(--border)] bg-[var(--bg)] px-3 py-2.5 text-sm text-[var(--text)] placeholder:text-[var(--dim)]"
            />
            <p className="pt-1.5 text-xs text-[var(--dim)]">
                  {dragging
                    ? "Let go to start the blind transcription."
                    : "Drag & drop a plate photo anywhere on this page, or tap + to pick one."}
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      <div ref={threadRef} className="flex-1 overflow-y-auto">
        <main className={`mx-auto w-full max-w-2xl px-4 pb-6 ${libraryOpen ? "lg:mr-96" : ""}`}>
          {/* Lead: the method, stated once, briefly. */}
          <header className="pb-2 pt-6">
            <img src="./logo.jpg" alt="HelmutReads" className="h-14 w-auto" />
            <p className="font-display text-xl leading-snug text-[var(--text)] mt-3">
              Drop a photo of a plate. It gets transcribed blind — from the
              photo alone — and only then checked against what's published.
            </p>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm text-[var(--dim)]">
              <span>
                <span className="font-semibold text-[var(--accent)]">1</span>{" "}
                Blind transcription
              </span>
              <span aria-hidden>→</span>
              <span>
                <span className="font-semibold text-[var(--accent)]">2</span>{" "}
                Cross-reference research
              </span>
            </div>
            <p className="mt-2 text-sm text-[var(--dim)]">
              Named for Hellmut Lehmann-Haupt, designer of the H.P. Kraus
              catalogues.
            </p>
            {me && (
              <div className="mt-3 flex items-center gap-3 text-sm text-[var(--dim)]">
                <span>
                  Signed in as{" "}
                  <span className="font-medium text-[var(--text)]">{me.email}</span>
                </span>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => logoutMutation.mutate()}
                >
                  Sign out
                </button>
                <button
                  type="button"
                  className="underline underline-offset-2"
                  onClick={() => setLibraryOpen(true)}
                >
                  Library ({runs.length})
                </button>
              </div>
            )}
          </header>

          {meQuery.data?.isAdmin === true && <ReviewSection onOpen={selectRun} />}

          
          {me && <BillingSection />}

          {libraryOpen && me && (
            <LibraryPanel runs={runs} onSelect={selectRun} onClose={() => setLibraryOpen(false)} />
          )}

          {meQuery.isPending && (
            <p className="py-10 text-center text-sm text-[var(--dim)]">
              Loading…
            </p>
          )}

          {meQuery.data && !me && (
            <LoginScreen
              onDone={() => {
                queryClient.invalidateQueries({ queryKey: ["me"] });
                queryClient.invalidateQueries({ queryKey: ["runs"] });
      queryClient.invalidateQueries({ queryKey: ["usage"] });
              }}
            />
          )}

          {me && (
            <>
              {runsQuery.isPending && (
                <p className="py-10 text-center text-sm text-[var(--dim)]">
                  Loading…
                </p>
              )}
              {runsQuery.error && (
                <p className="py-10 text-center text-sm text-[var(--accent)]">
                  Couldn't load past runs. Pull to retry, or drop a plate to start.
                </p>
              )}

              {runsQuery.data && runs.length === 0 && !busy && (
                <div className="mt-6 rounded-[var(--radius)] border-2 border-dashed border-[var(--border)] bg-[var(--surface)] px-5 py-10 text-center">
                  <p className="font-display text-lg text-[var(--text)]">
                    No plates yet
                  </p>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-relaxed text-[var(--dim)]">
                    Photograph a catalog plate — a page from one of the Kraus
                    catalogs, say — and drop the photo here, or tap the button
                    below. The transcription happens before any reference is
                    consulted, so a match (or an empty search) actually means
                    something.
                  </p>
                </div>
              )}

              <div className="mt-4 space-y-10">
                {busy && previewUrl && (
                  <div className="flex justify-end">
                    <div className="max-w-[85%] sm:max-w-[60%]">
                      <img
                        src={previewUrl}
                        alt="Plate photo being transcribed"
                        className="max-h-72 w-auto rounded-lg border border-[var(--border)] object-contain opacity-70"
                      />
                      <p className="mt-1 text-right text-xs text-[var(--dim)]">
                        Scanning…
                      </p>
                    </div>
                  </div>
                )}
                {[...runs].reverse().map((run) => (
                  <RunThread
                    key={run.id}
                    run={run}
                    researching={researchingId === run.id}
                    highlight={highlightId === run.id}
                    submitting={submittingId === run.id}
                    onResearch={(id) => researchMutation.mutate(id)}
                    onDelete={(id) => deleteMutation.mutate(id)}
                    onSubmit={(id) => submitMutation.mutate(id)}
                  />
                ))}

              </div>
            </>
          )}
          {meQuery.data?.isAdmin === true && <UsageSection />}
        </main>
      </div>


    </div>
  );
}