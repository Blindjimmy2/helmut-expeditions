# Data Plan

## Context provenance
- `Im running a blind test to transcibe the plates with muse to check its outcome against published to cross so it get my raw copy and checks it transcribes it and then looks for discrepancies against what it found against published.` (prior user statement; defines the two-phase method: transcribe from the raw photo FIRST, cross-check against published versions SECOND — the phase ordering is the product's core integrity rule and is enforced server-side)
- `But i have the catalogs that have pre digital versions that is why we are using the catalogs as the first test. They are my raw pictures of the catologs` (prior user statement; inputs are the user's own phone photos of H. P. Kraus catalog plates — pre-digital reproductions, so no digital copy exists for the model to lean on)
- `The first plate we ran this morning is still at yale and hasnt been officially translated` / `Its never been published but a guy is working on it` (prior user statements; the cross-reference phase must honestly support a 'no published version found' verdict — an empty search result is a meaningful outcome, not an error)
- `Dude i could turn this into a webpage in about three minutes. Build the chat box that you can drag and drop an image into, it scans and does its thing before ever checking for references and after its done it starts researching for cross references` (verbatim build request; chat-style interface, drag-and-drop image input, automatic phase 1 → phase 2 sequence)

## Tested sources
### ctx.inference.complete with image input (blind transcription)
**Used by**: `transcribeRun` action — phase 1. Receives ONLY the uploaded image bytes; ctx.inference is model-only (no browsing, no tools), so the blind protocol is structural, not a prompt promise.
**Test command**: `bun /opt/muse/assets/spaces/ts-runtime/dist/probe-ctx.js < /tmp/probe-transcribe.ts` (probe read the user's real plate photo `workspace/user/files/50168DCB-...-photo-DC47A40D-....jpg`, 1290×1720 JPEG, base64-encoded it, and called ctx.inference.complete with a zod schema {transcription, description, languageGuess})
**Sample output**: transcription recovered printed captions `No. 55.` and `(Original size.)`, scattered legible glyphs, illegible characters honestly marked `[?]`; description identified a damaged papyrus fragment with three standing ink figures; languageGuess `Coptic (in Greek/Coptic script)`.
**Processing**: client downscales photos to ≤1600px long edge and re-encodes JPEG before upload; server stores original bytes in ctx.blobs, runs inference with a schema of line-by-line transcription (each line: text + legibility note), script/language identification, figure/iconography description, printed captions, and image-derived search anchors (plate numbers, captions, distinctive words) for phase 2. Transcription is saved to the run row before any research action can run.

### ctx.tool.web_search (cross-reference research)
**Used by**: `researchRun` action — phase 2. Runs only against a run whose transcription is already saved; the action rejects runs without one.
**Test command**: `bun /opt/muse/assets/spaces/ts-runtime/dist/probe-ctx.js < /tmp/probe-search.ts` with query `H. P. Kraus catalog Coptic magical papyrus plate No. 55 Yale`
**Sample output**: 9 structured results with title/url/source/snippet; top hits were Yale University Library catalog records for Coptic magical texts (collections.library.yale.edu, Beinecke / Yale Papyrus Collection, P.CtYBR) with full provenance and language metadata in snippets.
**Processing**: server builds 3–4 queries from the phase-1 search anchors (plate/catalog identifiers, language + genre terms, holding-institution terms), dedupes results by URL, then a comparison ctx.inference call (text-only, given the saved blind transcription + search snippets) produces agreements, discrepancies, an overall verdict (`match_found` / `partial` / `no_published_version_found`), and the source list with URLs copied verbatim from search results. Sources render as real outbound links.

## Long-term data behavior
- **Refresh policy**: none — runs are point-in-time analyses created only when the user drops an image. No scheduled refresh; research results are stored as run at that moment, with the run timestamp shown.
- **Growth**: one `runs` row per dropped plate (image in ctx.blobs under `plates/<runId>`, transcription + research stored as JSON text columns). History list grows newest-first; user can delete runs.
- **Ordering**: runs newest first; within a run, phases strictly ordered — transcription always precedes research, and the UI shows the phase stepper so the blind-first protocol is visible.
- **Time semantics**: `created_at` / `researched_at` are creation instants rendered viewer-local.

## Rejected approaches
- **Tried**: single combined action (transcribe + research in one call)
  **Why rejected**: the blind test's whole value is that transcription completes and is frozen before any reference is consulted; separate actions with a server-side status gate make that ordering enforceable and auditable, and let a failed research phase retry without re-transcribing.
- **Tried**: ctx.agent.spawnTask for deep page-reading research
  **Why rejected**: web_search snippets already carry the catalog metadata needed for comparison (proven in probe), and the synchronous search + comparison-inference path is faster and fully verifiable in the audit; spawnTask's async callback plumbing adds failure modes without changing the verdict quality for catalog-record lookups.
- **Tried**: seeding the artifact with the No. 55 plate run from the parent conversation
  **Why rejected**: runs are the user's own work product; the artifact starts empty and the user drops the plate photo himself. Nothing is pre-populated.
