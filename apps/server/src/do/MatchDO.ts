import { DurableObject } from "cloudflare:workers";
import { z } from "zod";
import {
  MoveSchema,
  applyMove,
  currentPlayer,
  initialState,
  isTerminal,
  listLegalMoves,
  winner,
  type GameState,
  type Move,
} from "@fightclaw/engine";

type MatchEnv = {
  DB: D1Database;
};

type MatchState = {
  stateVersion: number;
  status: "active" | "ended";
  updatedAt: string;
  createdAt: string;
  players: string[];
  game: GameState;
  lastMove: Move | null;
  endedAt?: string;
  winnerAgentId?: string;
  loserAgentId?: string;
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

type StreamWriter = WritableStreamDefaultWriter<Uint8Array>;

const IDEMPOTENCY_PREFIX = "move:";
const ELO_K = 32;
const ELO_START = 1000;

const initPayloadSchema = z
  .object({
    players: z.array(z.string()).length(2),
    seed: z.number().int().optional(),
  })
  .strict();

export class MatchDO extends DurableObject<MatchEnv> {
  private readonly encoder = new TextEncoder();
  private spectators = new Set<StreamWriter>();
  private agentStreams = new Map<string, Set<StreamWriter>>();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/init") {
      const body = await request.json().catch(() => null);
      const parsed = initPayloadSchema.safeParse(body);
      if (!parsed.success) {
        return Response.json({ ok: false, error: "Init payload must include two players." }, { status: 400 });
      }

      const existing = await this.ctx.storage.get<MatchState>("state");
      if (existing) {
        return Response.json({ ok: true, state: existing });
      }

      const seed = parsed.data.seed ?? Math.floor(Math.random() * 1_000_000);
      const nextState = createInitialState(parsed.data.players, seed);
      await this.ctx.storage.put("state", nextState);
      await this.broadcastState(nextState);
      this.broadcastYourTurn(nextState);
      return Response.json({ ok: true, state: nextState });
    }

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

      const state = await this.ctx.storage.get<MatchState>("state");
      if (!state) {
        const response = { ok: false, error: "Match not initialized." } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 409, body: response });
        return Response.json(response, { status: 409 });
      }

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

      const moveParse = MoveSchema.safeParse(body.move);
      if (!moveParse.success) {
        const response = { ok: false, error: "Invalid move schema." } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 400, body: response });
        return Response.json(response, { status: 400 });
      }

      if (!state.players.includes(agentId)) {
        const response = { ok: false, error: "Agent not part of match." } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 403, body: response });
        return Response.json(response, { status: 403 });
      }

      const active = currentPlayer(state.game);
      if (active !== agentId) {
        const response = { ok: false, error: "Not your turn." } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 409, body: response });
        return Response.json(response, { status: 409 });
      }

      const legalMoves = listLegalMoves(state.game);
      const isLegal = legalMoves.some((m) => m.type === moveParse.data.type);
      if (!isLegal) {
        const response = { ok: false, error: "Illegal move." } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 400, body: response });
        return Response.json(response, { status: 400 });
      }

      const result = applyMoveToState(state, moveParse.data);

      if (!result.ok) {
        const response = { ok: false, error: result.error } satisfies MoveResponse;
        await this.ctx.storage.put(idempotencyKey, { status: 400, body: response });
        return Response.json(response, { status: 400 });
      }

      await this.ctx.storage.put("state", result.state);

      const response = { ok: true, state: result.state } satisfies MoveResponse;
      await this.ctx.storage.put(idempotencyKey, { status: 200, body: response });

      if (result.state.status === "ended") {
        await this.persistFinalization(result.state);
      }

      await this.broadcastState(result.state);
      this.broadcastYourTurn(result.state);
      if (result.state.status === "ended") {
        this.broadcastGameEnd(result.state);
      }

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

      const state = await this.ctx.storage.get<MatchState>("state");
      if (!state) {
        return Response.json({ ok: false, error: "Match not initialized." }, { status: 409 });
      }

      if (state.status === "ended") {
        const response: FinishResponse = { ok: true, state };
        return Response.json(response);
      }

      if (!state.players.includes(agentId)) {
        return Response.json({ ok: false, error: "Agent not part of match." }, { status: 403 });
      }

      const loserAgentId = agentId;
      const winnerAgentId = state.players.find((player) => player !== agentId);

      const endedAt = new Date().toISOString();
      const nextState: MatchState = {
        ...state,
        game: { ...state.game, status: "ended" },
        status: "ended",
        endedAt,
        updatedAt: endedAt,
        stateVersion: state.stateVersion + 1,
        winnerAgentId: winnerAgentId ?? undefined,
        loserAgentId,
      };

      await this.ctx.storage.put("state", nextState);
      await this.persistFinalization(nextState);

      await this.broadcastState(nextState);
      this.broadcastGameEnd(nextState);

      const response: FinishResponse = { ok: true, state: nextState };
      return Response.json(response);
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const state = await this.ctx.storage.get<MatchState>("state");
      return Response.json({ state: state ?? null });
    }

    if (request.method === "GET" && url.pathname === "/stream") {
      const agentId = request.headers.get("x-agent-id");
      if (!agentId) {
        return new Response("Agent id is required.", { status: 400 });
      }
      const state = await this.ctx.storage.get<MatchState>("state");
      if (state && !state.players.includes(agentId)) {
        return new Response("Agent not part of match.", { status: 403 });
      }

      const { readable, writer, close } = this.createStream();
      this.registerAgentStream(agentId, writer);
      this.handleAbort(request, () => {
        this.unregisterAgentStream(agentId, writer);
        void close();
      });

      if (state) {
        await this.sendEvent(writer, "state", { state });
        this.sendYourTurnIfActive(state, agentId, writer);
      }

      return this.streamResponse(readable);
    }

    if (request.method === "GET" && url.pathname === "/spectate") {
      const state = await this.ctx.storage.get<MatchState>("state");
      const { readable, writer, close } = this.createStream();
      this.spectators.add(writer);
      this.handleAbort(request, () => {
        this.spectators.delete(writer);
        void close();
      });

      if (state) {
        await this.sendEvent(writer, "state", { state });
      }

      return this.streamResponse(readable);
    }

    return new Response("Not found", { status: 404 });
  }

  private createStream() {
    const stream = new TransformStream<Uint8Array, Uint8Array>();
    const writer = stream.writable.getWriter();
    return {
      readable: stream.readable,
      writer,
      close: async () => {
        try {
          await writer.close();
        } catch {
          // ignore
        }
      },
    };
  }

  private handleAbort(request: Request, onAbort: () => void) {
    if (request.signal.aborted) {
      onAbort();
      return;
    }
    request.signal.addEventListener("abort", onAbort, { once: true });
  }

  private streamResponse(readable: ReadableStream<Uint8Array>) {
    return new Response(readable, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
  }

  private registerAgentStream(agentId: string, writer: StreamWriter) {
    const existing = this.agentStreams.get(agentId) ?? new Set<StreamWriter>();
    existing.add(writer);
    this.agentStreams.set(agentId, existing);
  }

  private unregisterAgentStream(agentId: string, writer: StreamWriter) {
    const set = this.agentStreams.get(agentId);
    if (!set) return;
    set.delete(writer);
    if (set.size === 0) this.agentStreams.delete(agentId);
  }

  private async sendEvent(writer: StreamWriter, event: string, data: unknown) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    await writer.write(this.encoder.encode(payload));
  }

  private async broadcastState(state: MatchState) {
    await this.broadcast([...this.spectators, ...this.allAgentWriters()], "state", { state });
  }

  private broadcastYourTurn(state: MatchState) {
    if (state.status !== "active") return;
    const active = currentPlayer(state.game);
    const writers = this.agentStreams.get(active);
    if (!writers) return;
    const payload = { matchId: this.ctx.id.name, agentId: active };
    for (const writer of writers) {
      void this.sendEvent(writer, "your_turn", payload).catch(() => {
        writers.delete(writer);
      });
    }
  }

  private sendYourTurnIfActive(state: MatchState, agentId: string, writer: StreamWriter) {
    if (state.status !== "active") return;
    const active = currentPlayer(state.game);
    if (active !== agentId) return;
    void this.sendEvent(writer, "your_turn", { matchId: this.ctx.id.name, agentId });
  }

  private broadcastGameEnd(state: MatchState) {
    const payload = { matchId: this.ctx.id.name, winnerAgentId: state.winnerAgentId ?? null };
    void this.broadcast([...this.spectators, ...this.allAgentWriters()], "game_end", payload);
  }

  private allAgentWriters(): StreamWriter[] {
    const writers: StreamWriter[] = [];
    for (const set of this.agentStreams.values()) {
      writers.push(...set);
    }
    return writers;
  }

  private async broadcast(writers: StreamWriter[], event: string, data: unknown) {
    for (const writer of writers) {
      try {
        await this.sendEvent(writer, event, data);
      } catch {
        this.spectators.delete(writer);
        for (const [agentId, set] of this.agentStreams.entries()) {
          if (set.delete(writer) && set.size === 0) {
            this.agentStreams.delete(agentId);
          }
        }
      }
    }
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

const createInitialState = (players: string[], seed: number): MatchState => {
  const now = new Date().toISOString();
  return {
    stateVersion: 0,
    status: "active",
    updatedAt: now,
    createdAt: now,
    players,
    game: initialState(seed, players),
    lastMove: null,
  };
};

const applyMoveToState = (state: MatchState, move: Move): MoveResult => {
  try {
    const nextGame = applyMove(state.game, move);
    const now = new Date().toISOString();

    let nextState: MatchState = {
      ...state,
      game: nextGame,
      lastMove: move,
      updatedAt: now,
      stateVersion: state.stateVersion + 1,
    };

    if (isTerminal(nextGame)) {
      const winnerAgentId = winner(nextGame) ?? undefined;
      const loserAgentId = winnerAgentId
        ? state.players.find((player) => player !== winnerAgentId)
        : undefined;

      nextState = {
        ...nextState,
        status: "ended",
        endedAt: now,
        winnerAgentId,
        loserAgentId,
      };
    }

    return { ok: true, state: nextState };
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }
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
