// Provenance tiers + checklist gate 3. Host-agnostic (see shared/auth.ts
// header for the tier/routing contract).
import type { Platform, RawDb } from "./platform";

export type ProvenanceTier = "verified" | "claimed" | "unknown";
export type ProvenanceVerdict = "pass" | "review" | "quarantine";

const ALLOWLIST = [
  "beinecke", "yale", "p.ctybr", "p.ctyale", "new haven",
  "british museum", "british library", "or. 5000",
  "austrian national", "oesterreichische nationalbibliothek", "erzherzog rainer", "papyrussammlung", "vienna",
  "vatican", "borgia", "borgian",
  "strasbourg", "straßburg", "p. gr.", "p.gr.",
  "berlin", "staatsbibliothek", "staatliche museen",
  "louvre", "paris", "sorbonne", "bnf", "bibliotheque nationale",
  "cairo", "egyptian museum", "coptic museum",
  "morgan library", "pierpont morgan",
  "bodleian", "oxford", "sackler", "christ church",
  "cambridge", "heidelberg", "leiden", "leiden university",
  "turin", "museo egizio", "turin museum",
  "metropolitan museum", "met museum",
  "chester beatty", "john rylands", "manchester",
  "michigan", "columbia", "princeton", "harvard", "houghton", "yale babylonian",
  "upenn", "university of pennsylvania", "penn museum",
  "ucl", "petrie", "oslo", "copenhagen", "dublin",
  "wuerzburg", "würzburg", "koeln", "cologne", "leipzig", "jena", "hamburg", "trier",
  "geneva", "genf", "milan", "milano", "florence", "firenze", "naples", "napoli",
  "toronto", "sydney", "australian", "tokyo", "kyoto",
  "jerusalem", "israel museum", "sinai", "saint catherine",
  "kelsey", "duke", "cornell", "nyu", "brooklyn museum",
  "h. p. kraus", "h.p. kraus", "kraus", "helmut", "lehmann-haupt", "petersen",
  "coptic museum", "ifao", "dumbarton oaks",
];

export async function seedAllowlist(raw: RawDb): Promise<void> {
  await raw.exec(`CREATE TABLE IF NOT EXISTS provenance_allowlist (pattern TEXT PRIMARY KEY)`);
  for (const p of ALLOWLIST) {
    await raw.prepare("INSERT OR IGNORE INTO provenance_allowlist (pattern) VALUES (?)").run(p);
  }
}

export async function assessProvenance(raw: RawDb, text: string): Promise<ProvenanceTier> {
  const t = (text ?? "").trim().toLowerCase();
  if (!t) return "unknown";
  await seedAllowlist(raw);
  const rows = (await raw.prepare("SELECT pattern FROM provenance_allowlist").all()) as unknown as {
    pattern: string;
  }[];
  return rows.some((p) => t.includes(p.pattern)) ? "verified" : "claimed";
}

export async function isTrustedSubmitter(raw: RawDb, userId: string): Promise<boolean> {
  const row = (await raw.prepare("SELECT trusted_submitter FROM users WHERE id = ?").get(userId)) as unknown as
    | { trusted_submitter: number }
    | undefined;
  return !!row?.trusted_submitter;
}

export async function provenanceGate(
  p: Platform,
  userId: string,
  text: string,
): Promise<{ verdict: ProvenanceVerdict; tier: ProvenanceTier; reason: string }> {
  const tier = await assessProvenance(p.raw, text);
  if (tier === "unknown") {
    return { verdict: "quarantine", tier, reason: "No holding stated; checklist cannot start." };
  }
  if (!(await isTrustedSubmitter(p.raw, userId))) {
    return tier === "verified"
      ? { verdict: "review", tier, reason: "Confirm the holding at the named collection." }
      : { verdict: "review", tier, reason: "Unverified holding claim; human review required." };
  }
  return tier === "verified"
    ? { verdict: "pass", tier, reason: "Known collection, trusted submitter." }
    : { verdict: "pass", tier, reason: "Claim attested on submitter trust (logged)." };
}
