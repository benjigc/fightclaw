import { describe, expect, test } from "bun:test";
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

const players = ["agent-a", "agent-b"] as const;

function applyMoves(seed: number, moves: Move[]) {
  let state = initialState(seed, [...players]);
  for (const move of moves) {
    state = applyMove(state, move);
  }
  return state;
}

describe("engine", () => {
  test("Move schema validates known moves", () => {
    expect(MoveSchema.safeParse({ type: "attack" }).success).toBe(true);
    expect(MoveSchema.safeParse({ type: "nope" }).success).toBe(false);
  });

  test("turn order enforcement via currentPlayer", () => {
    let state = initialState(1, [...players]);
    const first = currentPlayer(state);
    state = applyMove(state, { type: "endTurn" });
    const second = currentPlayer(state);
    expect(second).not.toBe(first);
  });

  test("action points and costs enforced", () => {
    const state = initialState(1, [...players]);
    const legal = listLegalMoves(state).map((m) => m.type);
    expect(legal).not.toContain("attack");

    const afterGather = applyMove(state, { type: "gather" });
    const legalAfterGather = listLegalMoves(afterGather).map((m) => m.type);
    expect(legalAfterGather).not.toContain("attack");

    const afterEndTurn = applyMove(afterGather, { type: "endTurn" });
    const legalNextTurn = listLegalMoves(afterEndTurn).map((m) => m.type);
    expect(legalNextTurn).toContain("attack");
  });

  test("combat outcomes including ties", () => {
    let state: GameState = initialState(1, [...players]);
    state = {
      ...state,
      players: [
        { ...state.players[0], hp: 3, energy: 2, ap: 2 },
        { ...state.players[1], hp: 3, energy: 2, ap: 2 },
      ],
    };
    const next = applyMove(state, { type: "blast" });
    expect(isTerminal(next)).toBe(true);
    expect(winner(next)).toBeNull();
  });

  test("resource production at end of turn", () => {
    let state = initialState(1, [...players]);
    const energyBefore = state.players[0].energy;
    state = applyMove(state, { type: "endTurn" });
    const energyAfter = state.players[0].energy;
    expect(energyAfter).toBeGreaterThanOrEqual(energyBefore + 1);
  });

  test("victory conditions", () => {
    let state: GameState = initialState(1, [...players]);
    state = {
      ...state,
      players: [
        { ...state.players[0], energy: 1, ap: 2 },
        { ...state.players[1], hp: 3, energy: 0, ap: 2 },
      ],
    };
    const next = applyMove(state, { type: "attack" });
    expect(isTerminal(next)).toBe(true);
    expect(winner(next)).toBe(players[0]);
  });

  test("determinism with same seed", () => {
    const moves: Move[] = [{ type: "gather" }, { type: "endTurn" }, { type: "attack" }];
    const a = applyMoves(42, moves);
    const b = applyMoves(42, moves);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});
