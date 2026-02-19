CREATE TABLE IF NOT EXISTS runner_agent_ownership (
  runner_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  revoked_at TEXT,
  PRIMARY KEY (runner_id, agent_id),
  FOREIGN KEY(agent_id) REFERENCES agents(id)
);

CREATE INDEX IF NOT EXISTS idx_runner_agent_ownership_agent
  ON runner_agent_ownership(agent_id);

CREATE INDEX IF NOT EXISTS idx_runner_agent_ownership_runner_active
  ON runner_agent_ownership(runner_id, revoked_at);
