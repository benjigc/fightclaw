CREATE INDEX IF NOT EXISTS idx_leaderboard_rating ON leaderboard(rating DESC);
CREATE INDEX IF NOT EXISTS idx_leaderboard_updated_at ON leaderboard(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_matches_ended_at ON matches(ended_at DESC);
