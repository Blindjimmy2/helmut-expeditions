// Adversarial tests for the provenance gate (checklist gate 3).
// Runs against an isolated temp database — never app.db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const dbPath = join(dirname(fileURLToPath(import.meta.url)), `.prov-test-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.AUTH_PEPPER = "test-pepper";

const { sqlite } = await import("../server/local/ctx.ts");
const { assessProvenance, isTrustedSubmitter, provenanceGate, seedAllowlist } = await import(
  "../server/shared/provenance.ts"
);
const { localPlatform } = await import("../server/local/platform.ts");
const P = localPlatform();

const now = Math.floor(Date.now() / 1000);
sqlite
  .prepare("INSERT INTO users (id, email, created_at, updated_at, trusted_submitter) VALUES (?,?,?,?,?)")
  .run("u_trusted", "t@x.com", now, now, 1);
sqlite
  .prepare("INSERT INTO users (id, email, created_at, updated_at, trusted_submitter) VALUES (?,?,?,?,?)")
  .run("u_stranger", "s@x.com", now, now, 0);

after(() => {
  sqlite.close();
  rmSync(dbPath, { force: true });
});

describe("tiers", () => {
  it("empty holding is unknown", async () => {
    assert.equal(await assessProvenance(P.raw, ""), "unknown");
    assert.equal(await assessProvenance(P.raw, "   "), "unknown");
  });
  it("known collections verify", async () => {
    assert.equal(await assessProvenance(P.raw, "Yale Beinecke Library"), "verified");
    assert.equal(await assessProvenance(P.raw, "H. P. Kraus Catalogue 105, Helmut Lehmann-Haupt copy"), "verified");
    assert.equal(await assessProvenance(P.raw, "Austrian National Library, Vienna"), "verified");
  });
  it("anything else with text is claimed", async () => {
    assert.equal(await assessProvenance(P.raw, "my attic box"), "claimed");
    assert.equal(await assessProvenance(P.raw, "private collection, details on request"), "claimed");
  });
  it("allowlist seeding is idempotent", async () => {
    await seedAllowlist(P.raw);
    const n1 = sqlite.prepare("SELECT COUNT(*) AS n FROM provenance_allowlist").get().n;
    await seedAllowlist(P.raw);
    const n2 = sqlite.prepare("SELECT COUNT(*) AS n FROM provenance_allowlist").get().n;
    assert.equal(n1, n2);
    assert.ok(n1 > 20);
  });
});

describe("gate", () => {
  it("silence quarantines even for trusted submitters", async () => {
    assert.ok(await isTrustedSubmitter(P.raw, "u_trusted"));
    const g = await provenanceGate(P, "u_trusted", "");
    assert.equal(g.verdict, "quarantine");
    assert.equal(g.tier, "unknown");
  });
  it("trusted + verified passes", async () => {
    const g = await provenanceGate(P, "u_trusted", "Yale Beinecke, P.CtYBR inv. 1793");
    assert.equal(g.verdict, "pass");
    assert.equal(g.tier, "verified");
  });
  it("trusted + claimed passes attested", async () => {
    const g = await provenanceGate(P, "u_trusted", "family books, Helmut friend papers");
    assert.equal(g.verdict, "pass");
    assert.match(g.reason, /trust/);
  });
  it("stranger + verified goes to review, not pass", async () => {
    const g = await provenanceGate(P, "u_stranger", "Yale Beinecke Library");
    assert.equal(g.verdict, "review");
    assert.equal(g.tier, "verified");
  });
  it("stranger + claimed goes to review", async () => {
    const g = await provenanceGate(P, "u_stranger", "my attic box");
    assert.equal(g.verdict, "review");
    assert.equal(g.tier, "claimed");
  });
  it("stranger + silence quarantines", async () => {
    const g = await provenanceGate(P, "u_stranger", "");
    assert.equal(g.verdict, "quarantine");
  });
  it("unknown users are treated as untrusted", async () => {
    assert.equal(await isTrustedSubmitter(P.raw, "u_nonexistent"), false);
    assert.equal((await provenanceGate(P, "u_nonexistent", "Louvre E 12345")).verdict, "review");
  });
});
