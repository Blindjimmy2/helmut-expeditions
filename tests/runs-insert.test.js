// Insert-shape regression test: the exact drizzle insert transcribePlate
// performs must succeed (guards the null-vs-DEFAULT bug that broke saves).
// Isolated temp database — never app.db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const dbPath = join(dirname(fileURLToPath(import.meta.url)), `.ins-test-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.AUTH_PEPPER = "test-pepper";

const { sqlite } = await import("../server/local/ctx.ts");
const { createCtx } = await import("../server/local/ctx.ts");
const schema = await import("../server/src/schema.ts");

after(() => {
  sqlite.close();
  rmSync(dbPath, { force: true });
});

describe("runs insert shape", () => {
  it("transcribe-style insert succeeds and reads back", async () => {
    const ctx = createCtx({ id: "u", email: "u@x", sessionId: "s", expiresAt: 9999999999 });
    const db = ctx.db();
    const inserted = await db
      .insert(schema.runs)
      .values({
        userId: "u",
        note: "",
        provenanceTier: "unknown",
        provenanceText: "",
        provenanceVerdict: "quarantine",
        imageBlobKey: "k",
        imageMime: "image/jpeg",
        status: "transcribed",
        transcription: "{}",
      })
      .returning();
    assert.equal(inserted.length, 1);
    assert.equal(inserted[0].checklistState, "none");
    assert.equal(inserted[0].checklistReason, "");
  });
});
