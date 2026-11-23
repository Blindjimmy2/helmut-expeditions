// Review queue tests: submit gate, admin gate, transitions, publish rule.
// Isolated temp database — never app.db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const dbPath = join(dirname(fileURLToPath(import.meta.url)), `.rev-test-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.AUTH_PEPPER = "test-pepper";
process.env.ADMIN_EMAILS = "boss@x.com";

const { sqlite } = await import("../server/local/ctx.ts");
const { localPlatform } = await import("../server/local/platform.ts");
const { isAdmin, reviewQueue, reviewRun, submitForReview } = await import("../server/shared/review.ts");
const P = localPlatform();

const now = Date.now();
sqlite.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?,?,?,?)").run("u_boss", "boss@x.com", now, now);
sqlite.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?,?,?,?)").run("u_pleb", "pleb@x.com", now, now);
function addRun(userId, tier, verdict, research) {
  return sqlite
    .prepare(
      "INSERT INTO runs (user_id, note, provenance_tier, provenance_text, provenance_verdict, image_blob_key, image_mime, status, transcription, research, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
    )
    .run(userId, "", tier, tier === "unknown" ? "" : "Somewhere", verdict, "k", "image/jpeg", "complete", "{}", research, now).lastInsertRowid;
}
const rPass = Number(addRun("u_pleb", "verified", "pass", JSON.stringify({ verdict: "no_published_version_found" })));
const rQuar = Number(addRun("u_pleb", "unknown", "quarantine", null));

after(() => {
  sqlite.close();
  rmSync(dbPath, { force: true });
});

describe("admin", () => {
  it("recognizes admins case-insensitively", () => {
    assert.equal(isAdmin(P, "boss@x.com"), true);
    assert.equal(isAdmin(P, "Boss@X.com"), true);
    assert.equal(isAdmin(P, "pleb@x.com"), false);
    assert.equal(isAdmin(P, null), false);
  });
  it("non-admins cannot list or decide", async () => {
    await assert.rejects(() => reviewQueue(P, "pleb@x.com"), /Not authorized/);
    await assert.rejects(() => reviewRun(P, "pleb@x.com", rPass, "approve", "x"), /Not authorized/);
  });
});

describe("submit gate", () => {
  it("queue starts empty: nothing auto-submits", async () => {
    assert.equal((await reviewQueue(P, "boss@x.com")).length, 0);
  });
  it("owner submits an eligible run", async () => {
    const s = await submitForReview(P, "u_pleb", rPass);
    assert.equal(s.checklistState, "submitted");
    const q = await reviewQueue(P, "boss@x.com");
    assert.equal(q.length, 1);
    assert.equal(q[0].researchVerdict, "no_published_version_found");
  });
  it("quarantined runs cannot submit", async () => {
    await assert.rejects(() => submitForReview(P, "u_pleb", rQuar), /holding information/);
  });
  it("strangers cannot submit your runs", async () => {
    const r = Number(addRun("u_boss", "claimed", "review", null));
    await assert.rejects(() => submitForReview(P, "u_pleb", r), /no longer exists/);
  });
  it("double submit is rejected", async () => {
    await assert.rejects(() => submitForReview(P, "u_pleb", rPass), /already in the verification track/);
  });
});

describe("decisions", () => {
  it("approve/reject/publish transitions with reasons", async () => {
    const a = await reviewRun(P, "boss@x.com", rPass, "approve", "looks right");
    assert.equal(a.checklistState, "approved");
    const q = await reviewQueue(P, "boss@x.com");
    assert.ok(!q.some((i) => i.runId === rPass));
    await assert.rejects(() => reviewRun(P, "boss@x.com", 999999, "approve", "x"), /no longer exists/);
    await assert.rejects(() => reviewRun(P, "boss@x.com", rPass, "approve", "   "), /reason is required/);
    const p = await reviewRun(P, "boss@x.com", rPass, "publish", "shipped");
    assert.equal(p.checklistState, "published");
  });
  it("decisions require a submitted run; publish requires approval", async () => {
    const r2 = Number(addRun("u_pleb", "claimed", "review", null));
    await assert.rejects(() => reviewRun(P, "boss@x.com", r2, "approve", "x"), /Only submitted/);
    await assert.rejects(() => reviewRun(P, "boss@x.com", r2, "publish", "skip"), /Only approved/);
    await submitForReview(P, "u_pleb", r2);
    await reviewRun(P, "boss@x.com", r2, "reject", "nah");
    const row = sqlite.prepare("SELECT checklist_state, checklist_by FROM runs WHERE id = ?").get(r2);
    assert.equal(row.checklist_state, "rejected");
    assert.equal(row.checklist_by, "boss@x.com");
  });
  it("rejected runs can be resubmitted", async () => {
    const r3 = Number(addRun("u_pleb", "claimed", "review", null));
    await submitForReview(P, "u_pleb", r3);
    await reviewRun(P, "boss@x.com", r3, "reject", "not yet");
    const s = await submitForReview(P, "u_pleb", r3);
    assert.equal(s.checklistState, "submitted");
  });
});

describe("hold", () => {
  it("holds park runs out of the queue without deciding them", async () => {
    const { sqlite: db } = await import("../server/local/ctx.ts");
    const r = Number(
      db
        .prepare("INSERT INTO runs (user_id, note, provenance_tier, provenance_text, provenance_verdict, image_blob_key, image_mime, status, transcription, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run("u_pleb", "", "verified", "Somewhere", "pass", "k", "image/jpeg", "complete", "{}", Date.now()).lastInsertRowid,
    );
    const { submitForReview, reviewRun, reviewQueue } = await import("../server/shared/review.ts");
    const P2 = (await import("../server/local/platform.ts")).localPlatform();
    await submitForReview(P2, "u_pleb", r);
    assert.equal((await reviewQueue(P2, "boss@x.com")).some((i) => i.runId === r), true);
    const h = await reviewRun(P2, "boss@x.com", r, "hold", "wait for editor");
    assert.equal(h.checklistState, "hold");
    assert.equal((await reviewQueue(P2, "boss@x.com")).some((i) => i.runId === r), false);
    await assert.rejects(() => reviewRun(P2, "boss@x.com", r, "publish", "skip"), /Only approved/);
    await reviewRun(P2, "boss@x.com", r, "approve", "released");
    const row = db.prepare("SELECT checklist_state FROM runs WHERE id = ?").get(r);
    assert.equal(row.checklist_state, "approved");
  });
});
