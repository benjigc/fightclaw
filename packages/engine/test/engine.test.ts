import { describe, expect, test } from "bun:test";
import {
	applyMove,
	createInitialState,
	type EngineEvent,
	isTerminal,
	type Move,
	type Unit,
} from "@fightclaw/engine";

const players = ["agent-a", "agent-b"] as const;
const [playerA] = players;

function indexFromCoord(coord: { q: number; r: number }) {
	return (coord.r + 3) * 7 + (coord.q + 3);
}

describe("hex conquest engine", () => {
	test("illegal move rejection reason is stable", () => {
		const state = createInitialState(0, undefined, [...players]);
		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			targetHex: { q: 0, r: 0 },
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("illegal_move");
		}
	});

	test("terminal detection via capital capture", () => {
		let state = createInitialState(0, undefined, [...players]);
		const unit = state.players.A.units[0] as Unit;
		const defender = state.players.B.units[0] as Unit;
		const from = unit.position;
		const to = { q: 3, r: 2 }; // F7, adjacent to G7
		const defenderFrom = defender.position;
		const defenderTo = { q: 2, r: 3 }; // move defender off capital
		state = {
			...state,
			players: {
				...state.players,
				A: { ...state.players.A, units: [{ ...unit, position: to }] },
				B: {
					...state.players.B,
					units: [{ ...defender, position: defenderTo }],
				},
			},
			board: [...state.board],
		};
		const fromIdx = indexFromCoord(from);
		const toIdx = indexFromCoord(to);
		const defenderFromIdx = indexFromCoord(defenderFrom);
		const defenderToIdx = indexFromCoord(defenderTo);
		const fromHex = state.board[fromIdx];
		const toHex = state.board[toIdx];
		const defenderFromHex = state.board[defenderFromIdx];
		const defenderToHex = state.board[defenderToIdx];
		if (!fromHex || !toHex || !defenderFromHex || !defenderToHex) {
			throw new Error("Missing board cell");
		}
		state.board[fromIdx] = { ...fromHex, unitId: null };
		state.board[toIdx] = { ...toHex, unitId: unit.id };
		state.board[defenderFromIdx] = { ...defenderFromHex, unitId: null };
		state.board[defenderToIdx] = { ...defenderToHex, unitId: defender.id };

		const result = applyMove(state, {
			action: "move",
			unitId: unit.id,
			targetHex: { q: 3, r: 3 }, // G7 capital
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const terminal = isTerminal(result.state);
		expect(terminal.ended).toBe(true);
		if (terminal.ended) {
			expect(terminal.winner).toBe(playerA);
		}
	});

	test("deterministic replay with same moves", () => {
		const moves: Move[] = [
			{ action: "pass" },
			{ action: "pass" },
			{ action: "pass" },
		];
		const run = () => {
			let state = createInitialState(1, undefined, [...players]);
			const events: EngineEvent[] = [];
			for (const move of moves) {
				const result = applyMove(state, move);
				if (!result.ok) throw new Error(result.error);
				state = result.state;
				events.push(...result.engineEvents);
			}
			return { state, events };
		};

		const a = run();
		const b = run();
		expect(JSON.stringify(a.state)).toBe(JSON.stringify(b.state));
		expect(JSON.stringify(a.events)).toBe(JSON.stringify(b.events));
	});

	test("attack tie removes both units and neutralizes hex", () => {
		let state = createInitialState(0, undefined, [...players]);
		const attacker = state.players.A.units[0] as Unit;
		const defender = state.players.B.units[0] as Unit;
		const attackerTo = { q: 0, r: 0 }; // D4 (tower), adjacent to D5
		const defenderTo = { q: 1, r: 0 }; // D5 (plains)

		state = {
			...state,
			players: {
				...state.players,
				A: {
					...state.players.A,
					units: [{ ...attacker, position: attackerTo, type: "infantry" }],
				},
				B: {
					...state.players.B,
					units: [{ ...defender, position: defenderTo, type: "cavalry" }],
				},
			},
			board: [...state.board],
		};

		const attackerFromIdx = indexFromCoord(attacker.position);
		const defenderFromIdx = indexFromCoord(defender.position);
		const attackerToIdx = indexFromCoord(attackerTo);
		const defenderToIdx = indexFromCoord(defenderTo);

		state.board[attackerFromIdx] = {
			...state.board[attackerFromIdx],
			unitId: null,
		};
		state.board[defenderFromIdx] = {
			...state.board[defenderFromIdx],
			unitId: null,
		};
		state.board[attackerToIdx] = {
			...state.board[attackerToIdx],
			unitId: attacker.id,
		};
		state.board[defenderToIdx] = {
			...state.board[defenderToIdx],
			unitId: defender.id,
			controlledBy: "B",
		};

		const result = applyMove(state, {
			action: "attack",
			unitId: attacker.id,
			targetHex: defenderTo,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const attackEvent = result.engineEvents.find(
			(event) => event.type === "attack",
		) as Extract<EngineEvent, { type: "attack" }> | undefined;
		expect(attackEvent).toBeTruthy();
		expect(attackEvent?.attackerId).toBe(attacker.id);
		expect(attackEvent?.defenderId).toBe(defender.id);
		expect(attackEvent?.attackerFrom).toEqual(attackerTo);
		expect(attackEvent?.targetHex).toEqual(defenderTo);
		expect(attackEvent?.distance).toBe(1);
		expect(attackEvent?.ranged).toBe(false);

		const defenderHex = result.state.board[defenderToIdx];
		expect(result.state.players.A.units.length).toBe(0);
		expect(result.state.players.B.units.length).toBe(0);
		expect(defenderHex?.unitId ?? null).toBe(null);
		expect(defenderHex?.controlledBy ?? null).toBe(null);
	});

	test("fortify event includes unit coord", () => {
		const state = createInitialState(0, undefined, [...players]);
		const unit = state.players.A.units[0] as Unit;

		const result = applyMove(state, {
			action: "fortify",
			unitId: unit.id,
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const fortifyEvent = result.engineEvents.find(
			(event) => event.type === "fortify",
		) as Extract<EngineEvent, { type: "fortify" }> | undefined;
		expect(fortifyEvent).toBeTruthy();
		expect(fortifyEvent?.unitId).toBe(unit.id);
		expect(fortifyEvent?.at).toEqual(unit.position);
	});
});
