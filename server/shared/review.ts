// Review queue (checklist gates 4-6): admin-only human verdicts.
// A run becomes reviewable when it has a usable provenance standing
// (pass/review) and no human decision yet. Decisions are append-only
// history: state + reason + who + when, never silently overwritten.
import type { Platform } from "./platform";

export type ChecklistState = "none" | "submitted" | "approved" | "rejected" | "published" | "hold";
export type ReviewDecision = "approve" | "reject" | "publish" | "hold";

export function adminEmails(p: Platform): string[] {
  return p
    .env.get("ADMIN_EMAILS")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

export function isAdmin(p: Platform, email: string | null | undefined): boolean {
  if (!email) return false;
  return adminEmails(p).includes(email.trim().toLowerCase());
}

export function reviewError(message: string, status = 400): Error {
  return Object.assign(new Error(message), { status });
}

export interface QueueItem {
  runId: number;
  userId: string;
  userEmail: string;
  note: string;
  provenanceTier: string;
  provenanceText: string;
  provenanceVerdict: string;
  checklistState: string;
  status: string;
  createdAt: number;
  researchVerdict: string | null;
}

export async function reviewQueue(p: Platform, adminEmail: string): Promise<QueueItem[]> {
  if (!isAdmin(p, adminEmail)) throw reviewError("Not authorized.", 403);
  const rows = (await p.raw
    .prepare(
      `SELECT r.id AS runId, r.user_id AS userId, u.email AS userEmail, r.note AS note,
      r.provenance_tier AS provenanceTier, r.provenance_text AS provenanceText,
      r.provenance_verdict AS provenanceVerdict, r.checklist_state AS checklistState,
      r.status AS status, r.created_at AS createdAt, r.research AS research
      FROM runs r JOIN users u ON u.id = r.user_id
      WHERE r.provenance_verdict IN ('pass','review') AND r.checklist_state = 'submitted'
      ORDER BY r.id DESC LIMIT 100`,
    )
    .all()) as unknown as (Omit<QueueItem, "researchVerdict"> & { research: string | null })[];
  return rows.map((r) => {
    let researchVerdict: string | null = null;
    try {
      researchVerdict = r.research ? (JSON.parse(r.research) as { verdict?: string }).verdict ?? null : null;
    } catch {
      researchVerdict = null;
    }
    const { research: _drop, ...rest } = r;
    void _drop;
    return { ...rest, researchVerdict };
  });
}

const TRANSITIONS: Record<ReviewDecision, ChecklistState> = {
  approve: "approved",
  reject: "rejected",
  publish: "published",
  hold: "hold",
};

export async function submitForReview(
  p: Platform,
  userId: string,
  runId: number,
): Promise<{ runId: number; checklistState: ChecklistState }> {
  const row = (await p.raw
    .prepare("SELECT id, user_id, provenance_verdict, checklist_state FROM runs WHERE id = ?")
    .get(runId)) as unknown as
    | { id: number; user_id: string; provenance_verdict: string; checklist_state: string }
    | undefined;
  if (!row || row.user_id !== userId) throw reviewError("That run no longer exists.", 404);
  if (row.provenance_verdict === "quarantine") {
    throw reviewError("Add holding information before submitting for verification.", 400);
  }
  if (row.checklist_state !== "none" && row.checklist_state !== "rejected") {
    throw reviewError("This run is already in the verification track.", 400);
  }
  await p.raw.prepare("UPDATE runs SET checklist_state = 'submitted' WHERE id = ?").run(runId);
  return { runId, checklistState: "submitted" };
}

export async function reviewRun(
  p: Platform,
  adminEmail: string,
  runId: number,
  decision: ReviewDecision,
  reason: string,
): Promise<{ runId: number; checklistState: ChecklistState }> {
  if (!isAdmin(p, adminEmail)) throw reviewError("Not authorized.", 403);
  const cleanReason = reason.trim().slice(0, 500);
  if (!cleanReason) throw reviewError("A reason is required.", 400);
  const row = (await p.raw.prepare("SELECT id, checklist_state FROM runs WHERE id = ?").get(runId)) as unknown as
    | { id: number; checklist_state: string }
    | undefined;
  if (!row) throw reviewError("That run no longer exists.", 404);
  if ((decision === "approve" || decision === "reject" || decision === "hold") && row.checklist_state !== "submitted" && !(decision === "approve" && row.checklist_state === "hold")) {
    throw reviewError("Only submitted runs can be decided.", 400);
  }
  if (decision === "publish" && row.checklist_state !== "approved") {
    throw reviewError("Only approved runs can be published.", 400);
  }
  const next = TRANSITIONS[decision];
  await p.raw
    .prepare("UPDATE runs SET checklist_state = ?, checklist_reason = ?, checklist_at = ?, checklist_by = ? WHERE id = ?")
    .run(next, cleanReason, Date.now(), adminEmail.trim().toLowerCase(), runId);
  return { runId, checklistState: next };
}
