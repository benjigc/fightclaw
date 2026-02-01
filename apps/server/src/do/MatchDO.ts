import { DurableObject } from "cloudflare:workers";

type MatchState = {
  turn: number;
  updatedAt: string;
  lastMove: Record<string, unknown> | null;
};

type MoveResult =
  | { ok: true; state: MatchState }
  | { ok: false; error: string };

export class MatchDO extends DurableObject {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/move") {
      const body = await request.json().catch(() => null);
      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      const result = applyMove(state, body);

      if (!result.ok) {
        return Response.json({ ok: false, error: result.error }, { status: 400 });
      }

      await this.ctx.storage.put("state", result.state);
      return Response.json({ ok: true, state: result.state });
    }

    if (request.method === "GET" && url.pathname === "/state") {
      const state =
        (await this.ctx.storage.get<MatchState>("state")) ?? createInitialState();
      return Response.json({ state });
    }

    return new Response("Not found", { status: 404 });
  }
}

const createInitialState = (): MatchState => ({
  turn: 0,
  updatedAt: new Date().toISOString(),
  lastMove: null,
});

const applyMove = (state: MatchState, move: unknown): MoveResult => {
  if (!isRecord(move)) {
    return { ok: false, error: "Move payload must be an object." };
  }

  return {
    ok: true,
    state: {
      ...state,
      turn: state.turn + 1,
      updatedAt: new Date().toISOString(),
      lastMove: move,
    },
  };
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
