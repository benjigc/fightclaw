ALTER TABLE agents ADD COLUMN disabled_at TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_disabled_at ON agents(disabled_at);
