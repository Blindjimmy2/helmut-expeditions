// Drizzle schema for this space: one row per plate transcription run.
//
// A run is created by phase 1 (blind transcription) and only then can phase 2
// (cross-reference research) fill in the `research` JSON — the phase ordering
// is enforced by the actions, and the row shape mirrors it.

import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const runs = sqliteTable("runs", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  userId: text("user_id"),
  provenanceTier: text("provenance_tier"),
  provenanceText: text("provenance_text"),
  provenanceVerdict: text("provenance_verdict"),
  checklistState: text("checklist_state").default("none"),
  checklistReason: text("checklist_reason").default(""),
  /** Optional user note (e.g. which catalog the plate came from). Never shown to phase 1. */
  note: text("note").notNull().default(""),
  imageBlobKey: text("image_blob_key").notNull(),
  imageMime: text("image_mime").notNull(),
  status: text("status", { enum: ["transcribed", "complete"] })
    .notNull()
    .default("transcribed"),
  /** Phase 1 output, JSON-encoded transcription object. */
  transcription: text("transcription").notNull(),
  /** Phase 2 output, JSON-encoded research object; null until researched. */
  research: text("research"),
  createdAt: integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date()),
  researchedAt: integer("researched_at", { mode: "timestamp_ms" }),
});
