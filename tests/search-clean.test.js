// cleanSearchText: Brave result hygiene — strip match-highlight markup,
// decode entities, collapse whitespace. Pure function, no fixtures.
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { cleanSearchText } = await import("../server/shared/providers.ts");

describe("cleanSearchText", () => {
  it("strips Brave <strong> match highlights", () => {
    assert.equal(
      cleanSearchText("Il canto <strong>primo</strong> <strong>del</strong> Paradiso"),
      "Il canto primo del Paradiso"
    );
  });

  it("decodes hex, decimal, and named entities", () => {
    assert.equal(
      cleanSearchText("l&#x27;auttore &amp; l&#39;opera &quot;X&quot;"),
      "l'auttore & l'opera \"X\""
    );
  });

  it("decodes double-escaped entities", () => {
    assert.equal(cleanSearchText("a &amp;lt; b"), "a < b");
  });

  it("leaves unknown entities and plain text alone", () => {
    assert.equal(cleanSearchText("a &bogus; b"), "a &bogus; b");
    assert.equal(cleanSearchText("Schließlich verfügt"), "Schließlich verfügt");
  });

  it("collapses whitespace", () => {
    assert.equal(cleanSearchText("  a   b\nc "), "a b c");
  });
});
