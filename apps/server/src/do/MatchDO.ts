import { DurableObject } from "cloudflare:workers";

type MatchEnv = {
  DB: D1Database;
};

type MatchState = {
  turn: number;
  updatedAt: string;
  lastMove: unknown | null;
  stateVersion: number;
  status: "active" | "ended";
  endedAt?: string;
  winnerAgentId?: string;
  loserAgentId?: string;
  players: string[];
};

type MoveResult =
  | { ok: true; state: MatchState }
  | { ok: false; error: string };

type MovePayload = {
  moveId: string;
  expectedVersion: number;
  move: unknown;
};

type MoveResponse =
  | { ok: true; state: MatchState }
  | { ok: false; error: string; stateVersion?: number };

type FinishPayload = {
  reason?: "forfeit";
};

type FinishResponse = { ok: true; state: MatchState } | { ok: false; error: string };

type IdempotencyEntry = {
  status: number;
  body: MoveResponse;
};

const IDEMPOTENCY_PREFIX = "move:";
const ELO_K = 32;
const ELO_START = 1000;

export class MatchDO extends DurableObject<MatchEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/move") {
      const body = await request.json().catch(() => null);
      if (!isMovePayload(body)) {
        return Response.json(
          { ok: false, error: "Move payload must include moveId, expectedVersion, and move." },
          { status: 400 },
        );
      }

      const agentId = request.headers.get("x-agent-id");
      if (!agentId) {
        return Response.json({ ok: false, error: "Agent id is required." }, { status: 400 });
      }

      const idempotencyKey = `${IDEMPOTENCY_PREFIX}${body.moveId}`;
      const cached = await this.ctx.storage.get<IdempotencyEntry>(idempotencyKey);
      if (cached) {
        return Response.json(cached.body, { status: cached.status });
      }

      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();

      if (state.status === "ended") {
        const response = {
          ok: false,
          error: "Match has ended.",
          stateVersion: state.stateVersion,
        } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 409, body: response });
        return Response.json(response, { status: 409 });
      }

      if (body.expectedVersion !== state.stateVersion) {
        const response = {
          ok: false,
          error: "Version mismatch.",
          stateVersion: state.stateVersion,
        } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 409, body: response });
        return Response.json(response, { status: 409 });
      }

      const result = applyMove(state, body.move, agentId);

      if (!result.ok) {
        const response = { ok: false, error: result.error } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 400, body: response });
        return Response.json(response, { status: 400 });
      }

      await this.ctx.storage.put("state", result.state);

      const response = { ok: true, state: result.state } satisfies MoveResponse;
      await this.ctx.storage.put(idempotencyKey, { status: 200, body: response });
      return Response.json(response);
    }

    if (request.method === "POST" && url.pathname === "/finish") {
      const body = await request.json().catch(() => null);
      if (!isFinishPayload(body)) {
        return Response.json({ ok: false, error: "Finish payload must be empty or include reason." }, { status: 400 });
      }

      const agentId = request.headers.get("x-agent-id");
      if (!agentId) {
        return Response.json({ ok: false, error: "Agent id is required." }, { status: 400 });
      }

      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      const players = Array.isArray(state.players) ? state.players : [];

      if (state.status === "ended") {
        const response: FinishResponse = { ok: true, state };
        return Response.json(response);
      }

      if (players.length > 0 && !players.includes(agentId)) {
        return Response.json({ ok: false, error: "Agent not part of match." }, { status: 403 });
      }

      const loserAgentId = agentId;
      const winnerAgentId = players.find((player) => player !== agentId);

      const endedAt = new Date().toISOString();
      const nextState: MatchState = {
        ...state,
        players,
        status: "ended",
        endedAt,
        updatedAt: endedAt,
        stateVersion: state.stateVersion + 1,
        winnerAgentId: winnerAgentId ?? undefined,
        loserAgentId,
      };

      await this.ctx.storage.put("state", nextState);
      await this.persistFinalization(nextState);

      const response: FinishResponse = { ok: true, state: nextState };
      return Response.json(response);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      return Response.json({ state });
    }

    return new Response("Not found", { status: 404 });
  }

  private async persistFinalization(state: MatchState) {
    const matchId = this.ctx.id.name;
    if (!matchId) {
      console.warn("Match id unavailable for finalization");
      return;
    }

    const updateMatch = this.env.DB.prepare(
      "UPDATE matches SET status='ended', ended_at=?, winner_agent_id=? WHERE id=? AND ended_at IS NULL",
    ).bind(state.endedAt ?? null, state.winnerAgentId ?? null, matchId);

    if (!state.winnerAgentId || !state.loserAgentId) {
      await this.env.DB.batch([updateMatch]);
      return;
    }

    await this.env.DB.batch([
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses) VALUES (?, ?, 0, 0)",
      ).bind(state.winnerAgentId, ELO_START),
      this.env.DB.prepare(
        "INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses) VALUES (?, ?, 0, 0)",
      ).bind(state.loserAgentId, ELO_START),
    ]);

    const winnerRow = await this.env.DB.prepare(
      "SELECT rating FROM leaderboard WHERE agent_id = ?",
    )
      .bind(state.winnerAgentId)
      .first<{ rating: number }>();

    const loserRow = await this.env.DB.prepare(
      "SELECT rating FROM leaderboard WHERE agent_id = ?",
    )
      .bind(state.loserAgentId)
      .first<{ rating: number }>();

    const winnerRating = typeof winnerRow?.rating === "number" ? winnerRow.rating : ELO_START;
    const loserRating = typeof loserRow?.rating === "number" ? loserRow.rating : ELO_START;

    const { winnerNext, loserNext } = calculateElo(winnerRating, loserRating);

    await this.env.DB.batch([
      updateMatch,
      this.env.DB.prepare(
        "UPDATE leaderboard SET rating=?, wins=wins+1, updated_at=datetime('now') WHERE agent_id=?",
      ).bind(winnerNext, state.winnerAgentId),
      this.env.DB.prepare(
        "UPDATE leaderboard SET rating=?, losses=losses+1, updated_at=datetime('now') WHERE agent_id=?",
      ).bind(loserNext, state.loserAgentId),
    ]);
  }
}

const createInitialState = (): MatchState => ({
  turn: 0,
  updatedAt: new Date().toISOString(),
  lastMove: null,
  stateVersion: 0,
  status: "active",
  players: [],
});

const applyMove = (state: MatchState, move: unknown, agentId: string): MoveResult => {
  const players = Array.isArray(state.players) ? [...state.players] : [];
  if (!players.includes(agentId)) {
    if (players.length >= 2) {
      return { ok: false, error: "Match already has two agents." };
    }
    players.push(agentId);
  }

  return {
    ok: true,
    state: {
      ...state,
      status: state.status ?? "active",
      turn: state.turn + 1,
      updatedAt: new Date().toISOString(),
      stateVersion: state.stateVersion + 1,
      lastMove: move,
      players,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isMovePayload = (value: unknown): value is MovePayload => {
  if (!isRecord(value)) return false;
  const moveId = value.moveId;
  const expectedVersion = value.expectedVersion;
  const hasMove = Object.prototype.hasOwnProperty.call(value, "move");
  return (
    typeof moveId === "string" &&
    moveId.length > 0 &&
    typeof expectedVersion === "number" &&
    Number.isInteger(expectedVersion) &&
    hasMove
  );
};

const isFinishPayload = (value: unknown): value is FinishPayload => {
  if (!isRecord(value)) return false;
  const reason = value.reason;
  return reason === undefined || reason === "forfeit";
};

const calculateElo = (winnerRating: number, loserRating: number) => {
  const expectedWinner = 1 / (1 + 10 ** ((loserRating - winnerRating) / 400));
  const expectedLoser = 1 / (1 + 10 ** ((winnerRating - loserRating) / 400));
  const winnerNext = Math.round(winnerRating + ELO_K * (1 - expectedWinner));
  const loserNext = Math.round(loserRating + ELO_K * (0 - expectedLoser));
  return { winnerNext, loserNext };
};
