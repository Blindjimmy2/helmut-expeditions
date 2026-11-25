// liveMeter: public aggregate Ember usage for the expedition cost meter.
// No auth, no user data — totals only. Temp DB, never app.db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const dbPath = join(dirname(fileURLToPath(import.meta.url)), `.meter-test-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.AUTH_PEPPER = "test-pepper";

const { sqlite, createCtx } = await import("../server/local/ctx.ts");
const { Actions, METER_EVENT_START_MS, METER_MODEL } = await import("../server/src/actions.ts");

after(() => {
  sqlite.close();
  rmSync(dbPath, { force: true });
});

const IN = METER_EVENT_START_MS + 2 * 3600 * 1000;
const OUT = METER_EVENT_START_MS - 3600 * 1000;

async function seed() {
  const run = sqlite.prepare(
    "INSERT INTO runs (user_id, note, image_blob_key, image_mime, status, transcription, created_at) VALUES (?, '', 'k', 'image/jpeg', ?, '{}', ?)",
  );
  const use = sqlite.prepare(
    "INSERT INTO usage_events (user_id, run_id, action, provider, model, input_tokens, output_tokens, reasoning_tokens, latency_ms, created_at) VALUES (?, ?, ?, 'openai-compatible', ?, ?, ?, ?, 0, ?)",
  );
  const a = Number(run.run("u", "complete", IN).lastInsertRowid);
  const b = Number(run.run("u", "complete", OUT).lastInsertRowid);
  const c = Number(run.run("u", "transcribed", IN).lastInsertRowid);
  use.run("u", a, "transcribe", METER_MODEL, 1000, 200, 3000, IN);
  use.run("u", a, "compare", METER_MODEL, 500, 100, 800, IN);
  use.run("u", b, "transcribe", METER_MODEL, 2000, 400, 100, OUT);
  use.run("u", c, "transcribe", METER_MODEL, 10, 10, 10, IN);
  use.run("u", a, "ask", METER_MODEL, 999, 999, 999, IN);
  use.run("u", a, "search", "", 0, 0, 0, IN);
  use.run("u", a, "search", "", 0, 0, 0, IN);
}

describe("liveMeter", () => {
  it("aggregates completed-plate Ember usage anonymously, ask excluded", async () => {
    await seed();
    const ctx = createCtx(null);
    const { meter } = await Actions.liveMeter.handler(ctx, {});
    assert.equal(meter.plates, 2);
    assert.equal(meter.inputTokens, 3500);
    assert.equal(meter.outputTokens, 700);
    assert.equal(meter.reasoningTokens, 3900);
    assert.equal(meter.searches, 2);
  });

  it("event window counts in-window completed plates and usage only", async () => {
    const ctx = createCtx(null);
    const { meter } = await Actions.liveMeter.handler(ctx, {});
    assert.equal(meter.event.plates, 1);
    assert.equal(meter.event.inputTokens, 1500);
    assert.equal(meter.event.outputTokens, 300);
    assert.equal(meter.event.reasoningTokens, 3800);
    assert.equal(meter.event.searches, 2);
  });

  it("returns zeros on an empty database", async () => {
    sqlite.exec("DELETE FROM usage_events; DELETE FROM runs;");
    const ctx = createCtx(null);
    const { meter } = await Actions.liveMeter.handler(ctx, {});
    assert.equal(meter.plates, 0);
    assert.equal(meter.inputTokens, 0);
    assert.equal(meter.event.plates, 0);
    assert.equal(meter.event.searches, 0);
  });
});
