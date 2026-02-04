#!/usr/bin/env bash
set -euo pipefail

BASE_URL=${BASE_URL:-"https://api.fightclaw.com"}
D1_NAME=${D1_NAME:-"fightclaw-database-bgciv"}

if [[ -z "${API_KEY_PEPPER:-}" ]]; then
  echo "API_KEY_PEPPER is required in environment" >&2
  exit 1
fi

if [[ -z "${ADMIN_KEY:-}" ]]; then
  echo "ADMIN_KEY is required in environment" >&2
  exit 1
fi

AGENT_A_KEY=${AGENT_A_KEY:-$(openssl rand -hex 16)}
AGENT_B_KEY=${AGENT_B_KEY:-$(openssl rand -hex 16)}

SQL_A=$(bun --cwd apps/server ./scripts/create-agent.ts --name "agent-a" --key "$AGENT_A_KEY")
SQL_B=$(bun --cwd apps/server ./scripts/create-agent.ts --name "agent-b" --key "$AGENT_B_KEY")

bunx wrangler d1 execute "$D1_NAME" --remote --command "$SQL_A"
bunx wrangler d1 execute "$D1_NAME" --remote --command "$SQL_B"

QUEUE_RESP=$(curl -s -X POST "$BASE_URL/v1/matches/queue" \
  -H "Authorization: Bearer $AGENT_A_KEY")

MATCH_ID=$(echo "$QUEUE_RESP" | sed -E 's/.*"matchId":"([^"]+)".*/\1/')

if [[ -z "$MATCH_ID" || "$MATCH_ID" == "$QUEUE_RESP" ]]; then
  echo "Failed to parse matchId from: $QUEUE_RESP" >&2
  exit 1
fi

echo "matchId=$MATCH_ID"

curl -s -X POST "$BASE_URL/v1/matches/$MATCH_ID/move" \
  -H "Authorization: Bearer $AGENT_A_KEY" \
  -H "Content-Type: application/json" \
  -d '{"moveId":"m1","expectedVersion":0,"move":{"noop":true}}'

echo

curl -s -X POST "$BASE_URL/v1/matches/$MATCH_ID/move" \
  -H "Authorization: Bearer $AGENT_A_KEY" \
  -H "Content-Type: application/json" \
  -d '{"moveId":"m1","expectedVersion":0,"move":{"noop":true}}'

echo

curl -s -X POST "$BASE_URL/v1/matches/$MATCH_ID/move" \
  -H "Authorization: Bearer $AGENT_B_KEY" \
  -H "Content-Type: application/json" \
  -d '{"moveId":"m2","expectedVersion":1,"move":{"noop":true}}'

echo

curl -s -X POST "$BASE_URL/v1/matches/$MATCH_ID/move" \
  -H "Authorization: Bearer $AGENT_B_KEY" \
  -H "Content-Type: application/json" \
  -d '{"moveId":"m3","expectedVersion":1,"move":{"noop":true}}'

echo

curl -s -X POST "$BASE_URL/v1/matches/$MATCH_ID/finish" \
  -H "Authorization: Bearer $AGENT_A_KEY" \
  -H "x-admin-key: $ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"reason":"forfeit"}'

echo

curl -s "$BASE_URL/v1/leaderboard"

echo
