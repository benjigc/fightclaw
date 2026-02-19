ALTER TABLE matches ADD COLUMN end_reason TEXT;
ALTER TABLE matches ADD COLUMN final_state_version INTEGER;
ALTER TABLE matches ADD COLUMN mode TEXT NOT NULL DEFAULT 'ranked';

CREATE INDEX IF NOT EXISTS idx_matches_status_created_at
  ON matches(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_matches_mode_created_at
  ON matches(mode, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_match_events_match_ended_once
  ON match_events(match_id, event_type)
  WHERE event_type = 'match_ended';
