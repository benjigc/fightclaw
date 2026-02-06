-- Workstream A: agent onboarding + api keys + prompt versions
-- Workstream B: observability (model telemetry columns)

-- API keys (supports rotation/revocation)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  key_hash TEXT NOT NULL,
  key_prefix TEXT NOT NULL,
  label TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  last_used_at TEXT,
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_agent ON api_keys(agent_id);

-- Backfill legacy single-key agents into api_keys so existing keys continue to work.
-- Use agent_id as the api_keys.id for the legacy row.
INSERT OR IGNORE INTO api_keys (id, agent_id, key_hash, key_prefix, created_at)
SELECT
  id,
  id,
  api_key_hash,
  substr(api_key_hash, 1, 8),
  created_at
FROM agents;

-- Agent verification support.
ALTER TABLE agents ADD COLUMN verified_at TEXT;
ALTER TABLE agents ADD COLUMN claim_code_hash TEXT;

CREATE INDEX IF NOT EXISTS idx_agents_verified_at ON agents(verified_at);
CREATE INDEX IF NOT EXISTS idx_agents_claim_code_hash ON agents(claim_code_hash);

-- Mark existing agents verified so deploy doesn't break current matchmaking/timeouts.
UPDATE agents
SET verified_at = COALESCE(verified_at, created_at)
WHERE verified_at IS NULL;

-- Prompt versions (encrypted at rest).
CREATE TABLE IF NOT EXISTS prompt_versions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL,
  game_type TEXT NOT NULL,
  version INTEGER NOT NULL,
  public_persona TEXT,
  private_strategy_ciphertext TEXT NOT NULL,
  private_strategy_iv TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_prompt_versions_agent_game_version
  ON prompt_versions(agent_id, game_type, version);
CREATE INDEX IF NOT EXISTS idx_prompt_versions_agent_game
  ON prompt_versions(agent_id, game_type);

-- Active prompt pointer (one per agent + game_type).
CREATE TABLE IF NOT EXISTS agent_prompt_active (
  agent_id TEXT NOT NULL,
  game_type TEXT NOT NULL,
  prompt_version_id TEXT NOT NULL,
  activated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (agent_id, game_type),
  FOREIGN KEY(agent_id) REFERENCES agents(id),
  FOREIGN KEY(prompt_version_id) REFERENCES prompt_versions(id)
);

CREATE INDEX IF NOT EXISTS idx_agent_prompt_active_prompt_version
  ON agent_prompt_active(prompt_version_id);

-- Workstream B: model telemetry attached to match_players (nullable, best-effort).
ALTER TABLE match_players ADD COLUMN model_provider TEXT;
ALTER TABLE match_players ADD COLUMN model_id TEXT;

