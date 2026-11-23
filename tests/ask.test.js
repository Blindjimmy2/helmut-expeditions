// Per-run Q&A tests: tier gate, ownership, grounding, no-image rule,
// not-established verdict, and dig-deeper searches.
// Isolated temp database — never app.db.
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { rmSync } from "node:fs";

const dbPath = join(dirname(fileURLToPath(import.meta.url)), `.ask-test-${Date.now()}.db`);
process.env.APP_DB_PATH = dbPath;
process.env.AUTH_PEPPER = "test-pepper";

const { sqlite } = await import("../server/local/ctx.ts");
const { localPlatform } = await import("../server/local/platform.ts");
const { askRunQuestion, NOT_ESTABLISHED } = await import("../server/shared/ask.ts");
const { Actions } = await import("../server/src/actions.ts");
const P = localPlatform();

const now = Date.now();
const BLOB_KEY = "plates/NEVERREAD.jpg";
const TRANSCRIPTION = JSON.stringify({
  language: "Coptic",
  summary: "A favour ritual with three figures.",
  printedCaptions: ["55"],
  lines: [{ text: "nterousotm", legibility: "partial" }],
  uncertainReadings: ["line 1 verb"],
  searchAnchors: ["55", "favour"],
  translation: "",
});
const RESEARCH = JSON.stringify({
  verdict: "no_published_version_found",
  verdictSummary: "Nothing matching this plate was found.",
  agreements: [],
  discrepancies: [],
  queries: ["55 favour ritual"],
  sources: [{ title: "KYP M492", url: "https://example.test/kyp", source: "KYP", snippet: "Ritual for favour" }],
});

for (const [id, email] of [["u_paid", "paid@x.com"], ["u_beta", "beta@x.com"], ["u_free", "free@x.com"], ["u_stranger", "stranger@x.com"]]) {
  sqlite.prepare("INSERT INTO users (id, email, created_at, updated_at) VALUES (?,?,?,?)").run(id, email, now, now);
}
sqlite.prepare("INSERT INTO user_billing (user_id, subscription_status, paid_until) VALUES (?,?,?)").run("u_paid", "active", Math.floor(Date.now() / 1000) + 3600);
sqlite.prepare("INSERT INTO user_billing (user_id, beta_access) VALUES (?,?)").run("u_beta", 1);

function addRun(userId, research) {
  return Number(
    sqlite
      .prepare(
        "INSERT INTO runs (user_id, note, provenance_tier, provenance_text, provenance_verdict, image_blob_key, image_mime, status, transcription, research, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
      )
      .run(userId, "Kraus catalog, plate 55", "claimed", "Yale", "review", BLOB_KEY, "image/jpeg", "complete", TRANSCRIPTION, research, now).lastInsertRowid,
  );
}
const rPaid = addRun("u_paid", RESEARCH);
const rBeta = addRun("u_beta", RESEARCH);
const rFree = addRun("u_free", RESEARCH);
const rBare = addRun("u_paid", null);
const rStranger = addRun("u_stranger", RESEARCH);

function mockIO({ completes = [], searches = {} } = {}) {
  const calls = { completes: [], searches: [] };
  let n = 0;
  return {
    calls,
    io: {
      complete: async (prompt, opts) => {
        calls.completes.push({ prompt, opts });
        return completes[n++];
      },
      search: async (q) => {
        calls.searches.push(q);
        return searches[q] ?? { results: [], unavailable: false };
      },
    },
  };
}

async function failsWith(promise, re, status) {
  try {
    await promise;
  } catch (err) {
    assert.match(err.message, re);
    if (status !== undefined) assert.equal(err.status, status);
    return;
  }
  assert.fail("expected rejection");
}

after(() => {
  sqlite.close();
  rmSync(dbPath, { force: true });
});

describe("tier gate", () => {
  it("demo tier is blocked with a plan message and 402", async () => {
    const { io } = mockIO();
    await failsWith(askRunQuestion(P, "u_free", rFree, "what script?", io), /Researcher and Institution/, 402);
  });
  it("paid plans get answers", async () => {
    const { io } = mockIO({ completes: [{ mode: "answer", answer: "Coptic.", queries: [] }] });
    const r = await askRunQuestion(P, "u_paid", rPaid, "what script?", io);
    assert.equal(r.answer, "Coptic.");
    assert.equal(r.searched, false);
  });
  it("beta access gets answers", async () => {
    const { io } = mockIO({ completes: [{ mode: "answer", answer: "Coptic.", queries: [] }] });
    const r = await askRunQuestion(P, "u_beta", rBeta, "what script?", io);
    assert.equal(r.answer, "Coptic.");
  });
});

describe("ownership", () => {
  it("strangers cannot ask about your runs", async () => {
    const { io } = mockIO();
    await failsWith(askRunQuestion(P, "u_paid", rStranger, "hi?", io), /no longer exists/);
  });
  it("missing runs fail the same way", async () => {
    const { io } = mockIO();
    await failsWith(askRunQuestion(P, "u_paid", 999999, "hi?", io), /no longer exists/);
  });
});

describe("grounding", () => {
  it("prompts carry the run outputs and answers pass through verbatim", async () => {
    const { calls, io } = mockIO({ completes: [{ mode: "answer", answer: "From the run.", queries: [] }] });
    const r = await askRunQuestion(P, "u_paid", rPaid, "summarize?", io);
    assert.equal(r.answer, "From the run.");
    const prompt = calls.completes[0].prompt;
    assert.ok(prompt.includes("A favour ritual with three figures."));
    assert.ok(prompt.includes("nterousotm"));
    assert.ok(prompt.includes("Nothing matching this plate was found."));
    assert.ok(prompt.includes("KYP M492"));
  });
  it("unresearched runs still answer from the transcription", async () => {
    const { calls, io } = mockIO({ completes: [{ mode: "answer", answer: "Coptic.", queries: [] }] });
    const r = await askRunQuestion(P, "u_paid", rBare, "what script?", io);
    assert.equal(r.answer, "Coptic.");
    assert.ok(calls.completes[0].prompt.includes("nterousotm"));
    assert.ok(calls.completes[0].prompt.includes("not run yet"));
  });
});

describe("never re-reads the image", () => {
  it("no inference call takes images or image references", async () => {
    const { calls, io } = mockIO({
      completes: [
        { mode: "search", answer: "", queries: ["similar stamp"] },
        { answer: "None found." },
      ],
      searches: { "similar stamp": { results: [], unavailable: false } },
    });
    await askRunQuestion(P, "u_paid", rPaid, "similar elsewhere?", io);
    assert.equal(calls.completes.length, 2);
    for (const c of calls.completes) {
      assert.ok(!("images" in c.opts), "inference opts must not carry images");
      const blob = JSON.stringify({ prompt: c.prompt, opts: c.opts });
      for (const needle of [BLOB_KEY, "dataBase64", "image/jpeg", "image/png", "/blobs/", "image_mime"]) {
        assert.ok(!blob.includes(needle), `model input must not reference the image (${needle})`);
      }
    }
  });
});

describe("not established", () => {
  it("beyond-evidence answers return the exact sentence and never search", async () => {
    const { calls, io } = mockIO({
      completes: [{ mode: "answer", answer: NOT_ESTABLISHED, queries: [] }],
    });
    const r = await askRunQuestion(P, "u_paid", rPaid, "who owned this in 1800?", io);
    assert.equal(r.answer, "not established in this run");
    assert.equal(calls.searches.length, 0);
  });
  it("the phase-A prompt carries the rule", async () => {
    const { calls, io } = mockIO({ completes: [{ mode: "answer", answer: "x", queries: [] }] });
    await askRunQuestion(P, "u_paid", rPaid, "anything?", io);
    const prompt = calls.completes[0].prompt;
    assert.ok(prompt.includes("not established in this run"));
    assert.ok(prompt.includes("Never invent"));
    assert.ok(prompt.includes("not available to you"));
  });
});

describe("dig deeper", () => {
  it("search mode runs the queries and attaches deduped sources", async () => {
    const { calls, io } = mockIO({
      completes: [
        { mode: "search", answer: "", queries: ["coptic favour amulet", "three figures ritual"] },
        { answer: "One parallel: [1]." },
      ],
      searches: {
        "coptic favour amulet": {
          results: [{ title: "Amulet A", url: "https://example.test/a", source: "KYP", snippet: "favour" }],
          unavailable: false,
        },
        "three figures ritual": {
          results: [
            { title: "Amulet A", url: "https://example.test/a", source: "KYP", snippet: "favour" },
            { title: "Amulet B", url: null, source: null, snippet: null },
          ],
          unavailable: false,
        },
      },
    });
    const r = await askRunQuestion(P, "u_paid", rPaid, "anything similar elsewhere?", io);
    assert.deepEqual(calls.searches, ["coptic favour amulet", "three figures ritual"]);
    assert.equal(r.searched, true);
    assert.deepEqual(r.queries, ["coptic favour amulet", "three figures ritual"]);
    assert.equal(r.sources.length, 2);
    assert.equal(r.sources[0].url, "https://example.test/a");
    assert.equal(r.answer, "One parallel: [1].");
    assert.ok(calls.completes[1].prompt.includes("[1] Amulet A"));
  });
  it("empty results reach phase B, which reports plainly", async () => {
    const { calls, io } = mockIO({
      completes: [
        { mode: "search", answer: "", queries: ["q"] },
        { answer: "No comparable material was found." },
      ],
      searches: {},
    });
    const r = await askRunQuestion(P, "u_paid", rPaid, "similar?", io);
    assert.equal(r.searched, true);
    assert.deepEqual(r.sources, []);
    assert.equal(r.answer, "No comparable material was found.");
    assert.ok(calls.completes[1].prompt.includes("(no results)"));
    assert.ok(calls.completes[1].prompt.includes("Never invent a comparable"));
  });
  it("unavailable search is surfaced, not hidden", async () => {
    const { calls, io } = mockIO({
      completes: [
        { mode: "search", answer: "", queries: ["q"] },
        { answer: "Search is not configured." },
      ],
      searches: { q: { results: [], unavailable: true } },
    });
    const r = await askRunQuestion(P, "u_paid", rPaid, "similar?", io);
    assert.equal(r.searched, true);
    assert.ok(calls.completes[1].prompt.includes("not configured"));
  });
});

describe("action wiring", () => {
  it("passes usage action 'ask' with the run id, and search meta", async () => {
    const captured = { opts: null, meta: null };
    const calls = [];
    const fake = {
      user: { id: "u_paid", email: "paid@x.com" },
      platform: P,
      inference: {
        complete: async (prompt, opts) => {
          captured.opts = opts;
          calls.push(prompt);
          return { mode: "answer", answer: "ok", queries: [] };
        },
      },
      tool: { web_search: async () => ({ content: { results: [], unavailable: false } }) },
      blobs: {},
      db: () => null,
      req: { ip: "", userAgent: "", cookie: "" },
      invalidateQueries: () => {},
    };
    const def = Actions.askRunQuestion;
    const r = await def.handler(fake, { runId: rPaid, question: "hi?" });
    assert.equal(r.answer, "ok");
    assert.equal(r.searched, false);
    assert.deepEqual(r.queries, []);
    assert.deepEqual(r.sources, []);
    assert.equal(captured.opts.usage.action, "ask");
    assert.equal(captured.opts.usage.runId, rPaid);
    assert.equal(captured.opts.usage.userId, "u_paid");
    assert.ok(!("images" in captured.opts));
  });
  it("requires sign-in", async () => {
    const def = Actions.askRunQuestion;
    const fake = { user: null, platform: P };
    await failsWith(def.handler(fake, { runId: rPaid, question: "hi?" }), /Sign in required/, 401);
  });
});
