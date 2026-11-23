-- Review queue state on runs.
ALTER TABLE runs ADD COLUMN checklist_state TEXT NOT NULL DEFAULT 'none';
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN checklist_reason TEXT NOT NULL DEFAULT '';
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN checklist_at INTEGER;
--> statement-breakpoint
ALTER TABLE runs ADD COLUMN checklist_by TEXT;
