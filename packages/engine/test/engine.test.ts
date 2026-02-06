import { describe, expect, test } from "bun:test";
import {
	applyMove,
	createInitialState,
	type EngineEvent,
	type HexId,
	listLegalMoves,
	type MatchState,
	type Move,
	neighborsOf,
	parseHexId,
	type Unit,
} from "@fightclaw/engine";

const players = ["agent-a", "agent-b"] as const;

function hexIndex(id: HexId): number {
	const { row, col } = parseHexId(id);
	return row * 21 + col;
}

/** Remove all units from a state */
function clearUnits(state: MatchState): MatchState {
	const s = structuredClone(state);
	s.players.A.units = [];
	s.players.B.units = [];
	for (let i = 0; i < s.board.length; i++) {
		if (s.board[i]?.unitId) {
			s.board[i] = { ...s.board[i]!, unitId: null };
		}
	}
	return s;
}

/** Add a unit to the state */
function addUnitToState(
	state: MatchState,
	id: string,
	type: Unit["type"],
	owner: Unit["owner"],
	position: HexId,
	opts?: Partial<Unit>,
): MatchState {
	const s = structuredClone(state);
	const unit: Unit = {
		id,
		type,
		owner,
		position,
		isFortified: false,
		movedThisTurn: false,
		movedDistance: 0,
		attackedThisTurn: false,
		canActThisTurn: true,
		...opts,
	};
	s.players[owner].units.push(unit);
	const idx = hexIndex(position);
	if (s.board[idx]) {
		s.board[idx] = { ...s.board[idx]!, unitId: id };
	}
	return s;
}

describe("v2 engine - War of Attrition", () => {
	// ---- Initial state correctness ----

	test("initial state has 189 hexes", () => {
		const state = createInitialState(0, undefined, [...players]);
		expect(state.board.length).toBe(189);
	});

	test("initial state has 12 units (6 per side)", () => {
		const state = createInitialState(0, undefined, [...players]);
		expect(state.players.A.units.length).toBe(6);
		expect(state.players.B.units.length).toBe(6);
	});

	test("initial state has correct unit placements", () => {
		const state = createInitialState(0, undefined, [...players]);
		const aUnits = new Map(state.players.A.units.map((u) => [u.id, u]));
		expect(aUnits.get("A-1")?.position).toBe("B2");
		expect(aUnits.get("A-1")?.type).toBe("infantry");
		expect(aUnits.get("A-4")?.position).toBe("B3");
		expect(aUnits.get("A-4")?.type).toBe("cavalry");
		expect(aUnits.get("A-6")?.position).toBe("C2");
		expect(aUnits.get("A-6")?.type).toBe("archer");

		const bUnits = new Map(state.players.B.units.map((u) => [u.id, u]));
		expect(bUnits.get("B-1")?.position).toBe("B20");
		expect(bUnits.get("B-4")?.position).toBe("B19");
		expect(bUnits.get("B-6")?.position).toBe("C20");
	});

	test("initial state has correct starting control", () => {
		const state = createInitialState(0, undefined, [...players]);
		// deploy_a hexes should be controlled by A
		const a1 = state.board[hexIndex("A1")];
		expect(a1?.controlledBy).toBe("A");
		expect(a1?.type).toBe("deploy_a");

		// deploy_b hexes should be controlled by B
		const a21 = state.board[hexIndex("A21")];
		expect(a21?.controlledBy).toBe("B");
		expect(a21?.type).toBe("deploy_b");

		// Neutral hexes
		const e11 = state.board[hexIndex("E11")];
		expect(e11?.controlledBy).toBe(null);
		expect(e11?.type).toBe("crown");
	});

	test("initial state has Turn 1 income applied (stronghold gold)", () => {
		const state = createInitialState(0, undefined, [...players]);
		// Player A controls 2 strongholds (B2, H2) → +4 gold
		expect(state.players.A.gold).toBe(4);
		expect(state.players.A.wood).toBe(0);
		expect(state.players.A.vp).toBe(0);

		// Player B should have 0 (not active yet)
		expect(state.players.B.gold).toBe(0);
	});

	test("initial state has correct resource reserves on gold mines and lumber camps", () => {
		const state = createInitialState(0, undefined, [...players]);
		const b9 = state.board[hexIndex("B9")];
		expect(b9?.type).toBe("gold_mine");
		expect(b9?.reserve).toBe(20);

		const c8 = state.board[hexIndex("C8")];
		expect(c8?.type).toBe("lumber_camp");
		expect(c8?.reserve).toBe(15);
	});

	test("activePlayer is A and actionsRemaining is 3", () => {
		const state = createInitialState(0, undefined, [...players]);
		expect(state.activePlayer).toBe("A");
		expect(state.actionsRemaining).toBe(3);
	});

	// ---- Turn numbering ----

	test("turn increments only after Player B ends", () => {
		let state = createInitialState(0, undefined, [...players]);
		expect(state.turn).toBe(1);

		// Player A passes all actions
		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		// Now it's B's turn, turn is still 1
		expect(state.activePlayer).toBe("B");
		expect(state.turn).toBe(1);

		// Player B passes
		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		// Now turn should be 2, active A
		expect(state.activePlayer).toBe("A");
		expect(state.turn).toBe(2);
	});

	// ---- end_turn vs pass equivalence ----

	test("end_turn and pass are equivalent", () => {
		const state1 = createInitialState(0, undefined, [...players]);
		const state2 = createInitialState(0, undefined, [...players]);

		const r1 = applyMove(state1, { action: "end_turn" });
		const r2 = applyMove(state2, { action: "pass" });

		expect(r1.ok).toBe(true);
		expect(r2.ok).toBe(true);
		if (!r1.ok || !r2.ok) return;

		expect(r1.state.activePlayer).toBe(r2.state.activePlayer);
		expect(r1.state.turn).toBe(r2.state.turn);
		expect(r1.state.actionsRemaining).toBe(r2.state.actionsRemaining);
	});

	// ---- Deterministic replay ----

	test("deterministic replay with same moves", () => {
		const moves: Move[] = [
			{ action: "end_turn" },
			{ action: "end_turn" },
			{ action: "end_turn" },
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

	// ---- Move validation ----

	test("illegal move rejection reason is stable", () => {
		const state = createInitialState(0, undefined, [...players]);
		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.reason).toBe("illegal_move");
		}
	});

	test("unit cannot move twice in same turn", () => {
		let state = createInitialState(0, undefined, [...players]);
		// Move A-1 (infantry at B2, movement 1)
		// B2 is at row 1, col 1. Check neighbors for valid move.
		const nbrs = neighborsOf("B2");
		// Find a valid empty neighbor
		let moveTo: HexId | null = null;
		for (const n of nbrs) {
			const hex = state.board[hexIndex(n)];
			if (hex && !hex.unitId) {
				moveTo = n;
				break;
			}
		}
		expect(moveTo).not.toBe(null);
		if (!moveTo) return;

		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: moveTo,
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		state = r1.state;

		// Try to move same unit again
		const nbrs2 = neighborsOf(moveTo);
		let moveTo2: HexId | null = null;
		for (const n of nbrs2) {
			const hex = state.board[hexIndex(n)];
			if (hex && !hex.unitId) {
				moveTo2 = n;
				break;
			}
		}
		if (!moveTo2) return;

		const r2 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: moveTo2,
		});
		expect(r2.ok).toBe(false);
		if (!r2.ok) {
			expect(r2.reason).toBe("illegal_move");
		}
	});

	test("unit cannot attack twice in same turn", () => {
		// Setup: place attacker and two enemies adjacent
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "cavalry", "A", "E10");
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");
		state = addUnitToState(state, "B-2", "infantry", "B", "E9");

		const r1 = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		state = r1.state;

		// If attacker survived, try attacking again
		const attacker = state.players.A.units.find((u) => u.id === "A-1");
		if (attacker) {
			const r2 = applyMove(state, {
				action: "attack",
				unitId: "A-1",
				target: "E9",
			});
			expect(r2.ok).toBe(false);
		}
	});

	test("recruited units cannot act same turn", () => {
		let state = createInitialState(0, undefined, [...players]);
		// Give player A lots of gold
		state = structuredClone(state);
		state.players.A.gold = 100;
		// Clear the stronghold B2 so we can recruit there
		// Move A-1 off B2
		const a1 = state.players.A.units.find((u) => u.id === "A-1")!;
		const oldIdx = hexIndex(a1.position);
		state.board[oldIdx] = { ...state.board[oldIdx]!, unitId: null };
		// Move A-1 to B4 (plains, should be empty)
		a1.position = "B4";
		const b4Idx = hexIndex("B4");
		state.board[b4Idx] = { ...state.board[b4Idx]!, unitId: "A-1" };

		// Recruit at B2
		const r1 = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "B2",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		state = r1.state;

		// The new unit should exist
		const newUnit = state.players.A.units.find(
			(u) => u.position === "B2" && u.id !== "A-1",
		);
		expect(newUnit).toBeTruthy();
		expect(newUnit?.canActThisTurn).toBe(false);

		// Try moving the recruited unit
		if (newUnit) {
			const r2 = applyMove(state, {
				action: "move",
				unitId: newUnit.id,
				to: "B1",
			});
			expect(r2.ok).toBe(false);
		}
	});

	// ---- Recruit validation ----

	test("recruit at stronghold (valid)", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.gold = 100;
		// Clear B2 of the infantry
		const a1 = state.players.A.units.find((u) => u.id === "A-1")!;
		state.board[hexIndex(a1.position)] = {
			...state.board[hexIndex(a1.position)]!,
			unitId: null,
		};
		a1.position = "B4";
		state.board[hexIndex("B4")] = {
			...state.board[hexIndex("B4")]!,
			unitId: "A-1",
		};

		const result = applyMove(state, {
			action: "recruit",
			unitType: "cavalry",
			at: "B2",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const recruited = result.state.players.A.units.find(
			(u) => u.position === "B2" && u.type === "cavalry",
		);
		expect(recruited).toBeTruthy();
		expect(result.state.players.A.gold).toBe(100 - 18);
	});

	test("recruit at non-stronghold fails", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.gold = 100;

		const result = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "A1", // deploy_a, not stronghold
		});
		expect(result.ok).toBe(false);
	});

	test("recruit at enemy stronghold fails", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.gold = 100;

		const result = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "B20", // stronghold_b, controlled by B
		});
		expect(result.ok).toBe(false);
	});

	// ---- Fortify ----

	test("fortify costs 1 wood and grants +2 DEF", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.wood = 3;

		const result = applyMove(state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.players.A.wood).toBe(2);
		const unit = result.state.players.A.units.find((u) => u.id === "A-1");
		expect(unit?.isFortified).toBe(true);
		expect(unit?.canActThisTurn).toBe(false);

		const fortifyEvent = result.engineEvents.find(
			(e) => e.type === "fortify",
		) as Extract<EngineEvent, { type: "fortify" }> | undefined;
		expect(fortifyEvent).toBeTruthy();
		expect(fortifyEvent?.unitId).toBe("A-1");
	});

	test("fortify without wood fails", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.wood = 0;

		const result = applyMove(state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(result.ok).toBe(false);
	});

	test("fortify after move fails", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.wood = 3;

		// Move A-1 first
		const nbrs = neighborsOf("B2");
		let moveTo: HexId | null = null;
		for (const n of nbrs) {
			const hex = state.board[hexIndex(n)];
			if (hex && !hex.unitId) {
				moveTo = n;
				break;
			}
		}
		if (!moveTo) return;

		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: moveTo,
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const r2 = applyMove(r1.state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(r2.ok).toBe(false);
	});

	// ---- Combat: basic ----

	test("attack tie removes both units and neutralizes hex", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// infantry ATK 2 vs cavalry DEF 2 on plains (+0) = tie
		// E2 is plains, E3 is plains
		state = addUnitToState(state, "A-1", "infantry", "A", "E2");
		state = addUnitToState(state, "B-1", "cavalry", "B", "E3");
		state.board[hexIndex("E3")] = {
			...state.board[hexIndex("E3")]!,
			unitId: "B-1",
			controlledBy: "B",
		};

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E3",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const attackEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		expect(attackEvent).toBeTruthy();
		expect(attackEvent?.outcome.attacker).toBe("dies");
		expect(attackEvent?.outcome.defender).toBe("dies");

		// Both units dead
		expect(result.state.players.A.units.length).toBe(0);
		expect(result.state.players.B.units.length).toBe(0);

		// Hex neutralized
		const e3 = result.state.board[hexIndex("E3")];
		expect(e3?.controlledBy).toBe(null);
	});

	// ---- Cavalry Charge ----

	test("cavalry charge grants +2 ATK when moved >= 2 on forest-free path", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Use a path that is all plains/non-forest.
		// B4=plains, B5=plains, B6=hills — all non-forest.
		// Place cavalry at B4, move to B6 (distance 2), then attack enemy at B7.
		// B7=forest (defense +1), but that's the target hex, not intermediate.
		state = addUnitToState(state, "A-1", "cavalry", "A", "B4");
		state = addUnitToState(state, "B-1", "infantry", "B", "B7");

		// Verify B5 is not forest
		expect(state.board[hexIndex("B5")]?.type).toBe("plains");

		// Move cavalry to B6 (distance 2, through B5 which is plains)
		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "B6",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const movedUnit = r1.state.players.A.units.find((u) => u.id === "A-1");
		expect(movedUnit?.movedDistance).toBe(2);
		expect(movedUnit?.chargeEligible).toBe(true);

		// Attack from B6 to B7 (distance 1)
		const r2 = applyMove(r1.state, {
			action: "attack",
			unitId: "A-1",
			target: "B7",
		});
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		const attackEvent = r2.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		expect(attackEvent).toBeTruthy();
		// Cavalry base ATK 4 + charge 2 = 6
		expect(attackEvent?.attackPower).toBe(6);
		expect(attackEvent?.abilities).toContain("cavalry_charge");
	});

	test("cavalry charge denied when path goes through forest", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// E4 is forest. Path from E3 to E5 must go through E4 (forest).
		// So charge should be denied.
		state = addUnitToState(state, "A-1", "cavalry", "A", "E3");
		state = addUnitToState(state, "B-1", "infantry", "B", "E6");

		// E3 neighbors that lead to E5 in 2 steps — E4 is forest
		// Let's verify E4 is forest
		const e4 = state.board[hexIndex("E4")];
		expect(e4?.type).toBe("forest");

		// Try to move to E5 distance 2 through E4 forest
		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "E5",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const movedUnit = r1.state.players.A.units.find((u) => u.id === "A-1");
		// The move succeeds (cavalry can move through forest), but charge is denied
		expect(movedUnit?.chargeEligible).toBeFalsy();
	});

	// ---- Shield Wall ----

	test("shield wall +1 per adjacent friendly infantry, max +2", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Place defending infantry with 2 adjacent friendly infantry
		// D10 is plains. Neighbors include E10, D9, etc.
		state = addUnitToState(state, "B-1", "infantry", "B", "D10");
		// Place adjacent friendly infantry
		const d10Neighbors = neighborsOf("D10");
		const friendlyPos1 = d10Neighbors[0]!;
		const friendlyPos2 = d10Neighbors[1]!;
		state = addUnitToState(state, "B-2", "infantry", "B", friendlyPos1);
		state = addUnitToState(state, "B-3", "infantry", "B", friendlyPos2);

		// Place attacker adjacent to defender
		// Find a neighbor of D10 that's not occupied
		let attackerPos: HexId | null = null;
		for (const n of d10Neighbors) {
			if (
				n !== friendlyPos1 &&
				n !== friendlyPos2 &&
				!state.board[hexIndex(n)]?.unitId
			) {
				attackerPos = n;
				break;
			}
		}
		expect(attackerPos).not.toBe(null);
		if (!attackerPos) return;

		state = addUnitToState(state, "A-1", "cavalry", "A", attackerPos);

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "D10",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		expect(atkEvent).toBeTruthy();
		// Infantry base DEF 4 + terrain 0 (plains) + shield wall +2 = 6
		expect(atkEvent?.defensePower).toBe(6);
		expect(atkEvent?.abilities).toContain("shield_wall_+2");
	});

	test("shield wall caps at +2 even with 3+ adjacent infantry", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		state = addUnitToState(state, "B-1", "infantry", "B", "D10");
		const d10Neighbors = neighborsOf("D10");
		// Place 3 adjacent infantry
		state = addUnitToState(state, "B-2", "infantry", "B", d10Neighbors[0]!);
		state = addUnitToState(state, "B-3", "infantry", "B", d10Neighbors[1]!);
		state = addUnitToState(state, "B-4", "infantry", "B", d10Neighbors[2]!);

		let attackerPos: HexId | null = null;
		for (let i = 3; i < d10Neighbors.length; i++) {
			const n = d10Neighbors[i]!;
			if (!state.board[hexIndex(n)]?.unitId) {
				attackerPos = n;
				break;
			}
		}
		if (!attackerPos) return;

		state = addUnitToState(state, "A-1", "cavalry", "A", attackerPos);

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "D10",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		// Still capped at +2
		expect(atkEvent?.defensePower).toBe(6);
	});

	// ---- Archer melee vulnerability ----

	test("archer melee vulnerability: -1 DEF at distance 1", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Archer on plains: base DEF 1 + terrain 0 - melee vuln 1 = 0
		// E2=plains, E3=plains — both plains, adjacent
		state = addUnitToState(state, "A-1", "infantry", "A", "E2");
		state = addUnitToState(state, "B-1", "archer", "B", "E3");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E3",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		expect(atkEvent?.defensePower).toBe(0);
		expect(atkEvent?.abilities).toContain("archer_melee_vulnerability");
		// Infantry ATK 2 > 0 DEF → defender dies
		expect(atkEvent?.outcome.defender).toBe("dies");
	});

	// ---- Archer LoS ----

	test("archer LoS blocked by forest on target hex", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Place archer 2 hexes from an enemy on a forest hex
		// E4 is forest. Archer at E2 attacks target at E4 (distance 2?)
		// Wait, E4 is forest, so target is in forest → blocked
		// Need to find valid distance-2 where target is forest
		// C10 is forest. Let's place archer at A10? Check distance.
		// Actually, let's find a concrete case.
		// B7 is forest. Archer at B5, target at B7? Let's check distance.
		// B5 is plains, B6 is hills, B7 is forest
		// B5 and B7 are in row B (row 1, odd row)

		// Place target on a forest hex at distance 2 from archer
		state = addUnitToState(state, "A-1", "archer", "A", "A5");
		state = addUnitToState(state, "B-1", "infantry", "B", "A7");

		// A5 is forest, A7 is plains. That won't work for this test.
		// Let me use a different setup: target on forest.
		// C10 is forest. Need an archer at distance 2.
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "archer", "A", "C8");
		// C10 is forest
		expect(state.board[hexIndex("C10")]?.type).toBe("forest");
		state = addUnitToState(state, "B-1", "infantry", "B", "C10");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "C10",
		});
		// Should fail due to LoS
		expect(result.ok).toBe(false);
	});

	test("archer LoS blocked by unit on mid hex (not on high ground)", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);

		// Need archer at distance 2 from target with a unit on the mid hex
		// Place units in a row: archer at D8, blocker at D9, target at D10
		// D8 is plains, D9 is forest → that would block by terrain
		// Let's use E9, E10, E11: E9=plains, E10=gold_mine, E11=crown
		// gold_mine and crown are NOT forest, so mid hex is not forest-blocked
		state = addUnitToState(state, "A-1", "archer", "A", "E9");
		state = addUnitToState(state, "A-2", "infantry", "A", "E10"); // blocker on mid
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(false);
	});

	test("archer LoS: high ground bypasses unit blocking", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);

		// D11 is high_ground. Archer there.
		// D11 → E11 (crown, mid) → F10 (plains, target) — exactly 1 shared neighbor (E11)
		expect(state.board[hexIndex("D11")]?.type).toBe("high_ground");
		expect(state.board[hexIndex("E11")]?.type).toBe("crown"); // not forest
		expect(state.board[hexIndex("F10")]?.type).toBe("plains"); // not forest

		state = addUnitToState(state, "A-1", "archer", "A", "D11"); // high_ground
		state = addUnitToState(state, "A-2", "infantry", "A", "E11"); // mid hex blocker
		state = addUnitToState(state, "B-1", "infantry", "B", "F10"); // target

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "F10",
		});
		// High ground archer bypasses unit blocking on mid hex
		expect(result.ok).toBe(true);
	});

	// ---- Resource node reserve depletion ----

	test("gold mine reserve depletes over turns", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		// Give A control of a gold mine
		const b9Idx = hexIndex("B9");
		state.board[b9Idx] = {
			...state.board[b9Idx]!,
			controlledBy: "A",
		};

		const startingGold = state.players.A.gold;
		const startingReserve = state.board[b9Idx]!.reserve!;

		// Player A passes (turn ends → B's turn starts, no gold mine for B)
		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		// Player B passes → A's turn starts with income
		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		// A got income from the gold mine: min(3, 20) = 3
		// Plus strongholds: +4
		expect(state.players.A.gold).toBe(startingGold + 4 + 3);
		// Reserve decremented
		expect(state.board[b9Idx]!.reserve).toBe(startingReserve - 3);
	});

	test("lumber camp reserve depletes and yields wood", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		// Give A control of a lumber camp
		const c8Idx = hexIndex("C8");
		state.board[c8Idx] = {
			...state.board[c8Idx]!,
			controlledBy: "A",
		};

		// Pass both turns so A gets income again
		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		result = applyMove(result.state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// A got wood from lumber camp: min(2, 15) = 2
		expect(result.state.players.A.wood).toBe(2);
		expect(result.state.board[c8Idx]!.reserve).toBe(15 - 2);
	});

	// ---- Crown VP accumulation ----

	test("crown hex controlled yields VP", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		// Give A control of crown (E11)
		const e11Idx = hexIndex("E11");
		state.board[e11Idx] = {
			...state.board[e11Idx]!,
			controlledBy: "A",
		};

		// A already had start-of-turn tick. Let's pass both turns.
		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		result = applyMove(result.state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// A should have gotten +1 VP from crown
		expect(result.state.players.A.vp).toBe(1);
	});

	// ---- Stronghold income ----

	test("stronghold gives +2 gold per controlled stronghold at start-of-turn", () => {
		const state = createInitialState(0, undefined, [...players]);
		// Player A controls both B2 and H2 (stronghold_a), so +4 gold from initial tick
		expect(state.players.A.gold).toBe(4);
	});

	// ---- Sticky control ----

	test("empty hex keeps control (sticky)", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Need units on both sides to avoid elimination
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		// Set a hex to controlled by A
		const e10Idx = hexIndex("E10");
		state.board[e10Idx] = {
			...state.board[e10Idx]!,
			controlledBy: "A",
		};

		// End turn
		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Control should persist on unoccupied hex
		expect(result.state.board[e10Idx]?.controlledBy).toBe("A");
	});

	// ---- Victory conditions ----

	test("stronghold capture victory", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Place A units on both B strongholds + B unit somewhere to avoid elimination
		state = addUnitToState(state, "A-1", "infantry", "A", "B20");
		state = addUnitToState(state, "A-2", "infantry", "A", "H20");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		// End turn triggers control update → A captures both B strongholds
		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.status).toBe("ended");
		const gameEnd = result.engineEvents.find((e) => e.type === "game_end") as
			| Extract<EngineEvent, { type: "game_end" }>
			| undefined;
		expect(gameEnd).toBeTruthy();
		expect(gameEnd?.reason).toBe("stronghold_capture");
		expect(gameEnd?.winner).toBe("agent-a");
	});

	test("elimination victory", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// A has 1 unit, B has 1 unit. A attacks B and wins → B eliminated.
		// infantry (ATK 2) vs archer on plains (DEF 1 + 0 terrain - 1 melee vuln = 0)
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		state = addUnitToState(state, "B-1", "archer", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.status).toBe("ended");
		const gameEnd = result.engineEvents.find((e) => e.type === "game_end") as
			| Extract<EngineEvent, { type: "game_end" }>
			| undefined;
		expect(gameEnd?.reason).toBe("elimination");
		expect(gameEnd?.winner).toBe("agent-a");
	});

	test("turn limit victory with VP tiebreak", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		state = structuredClone(state);
		// Set to turn 30, Player B's turn
		state.turn = 30;
		state.activePlayer = "B";
		state.actionsRemaining = 3;
		state.players.A.vp = 5;
		state.players.B.vp = 3;

		// B ends turn → turn becomes 31 → timeout
		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.status).toBe("ended");
		const gameEnd = result.engineEvents.find((e) => e.type === "game_end") as
			| Extract<EngineEvent, { type: "game_end" }>
			| undefined;
		expect(gameEnd?.reason).toBe("turn_limit");
		expect(gameEnd?.winner).toBe("agent-a"); // higher VP
	});

	test("turn limit draw when all tiebreakers equal", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		state = structuredClone(state);
		state.turn = 30;
		state.activePlayer = "B";
		state.actionsRemaining = 3;
		state.players.A.vp = 0;
		state.players.B.vp = 0;
		// Clear all control so hex counts are equal
		for (let i = 0; i < state.board.length; i++) {
			state.board[i] = { ...state.board[i]!, controlledBy: null };
		}

		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.status).toBe("ended");
		const gameEnd = result.engineEvents.find((e) => e.type === "game_end") as
			| Extract<EngineEvent, { type: "game_end" }>
			| undefined;
		expect(gameEnd?.reason).toBe("draw");
		expect(gameEnd?.winner).toBe(null);
	});

	// ---- Melee capture (attacker moves in) ----

	test("melee attacker moves into defender hex on kill", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Cavalry ATK 4 vs archer DEF 1 + 0 (plains) - 1 (melee vuln) = 0
		state = addUnitToState(state, "A-1", "cavalry", "A", "E10");
		state = addUnitToState(state, "B-1", "archer", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const attacker = result.state.players.A.units.find((u) => u.id === "A-1");
		expect(attacker?.position).toBe("E11"); // moved into defender hex
	});

	test("ranged attack does not move attacker", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Archer at E9, target infantry at E11 (distance 2, crown hex +1 def)
		// Archer ATK 3 vs infantry DEF 4 + 1 (crown) = 5 → attacker dies
		state = addUnitToState(state, "A-1", "archer", "A", "E9");
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");

		// Check LoS: mid hex between E9 and E11
		// E9 row 4 (even): neighbors at (col+1,r+0)=E10, (col,r+1)=F9... etc
		// E11 row 4: neighbors include E10
		// shared neighbor should be E10 (gold_mine, not forest, no unit) → LoS clear

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		// Attacker dies (ATK 3 < DEF 5)
		expect(atkEvent?.outcome.attacker).toBe("dies");
		// Ranged → no capture
		expect(atkEvent?.outcome.captured).toBe(false);
	});

	// ---- listLegalMoves includes end_turn ----

	test("listLegalMoves always includes end_turn", () => {
		const state = createInitialState(0, undefined, [...players]);
		const moves = listLegalMoves(state);
		const endTurns = moves.filter((m) => m.action === "end_turn");
		expect(endTurns.length).toBe(1);
	});

	// ---- Fortify persists until start of owner's next turn ----

	test("fortify is cleared at start of player's next turn", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = structuredClone(state);
		state.players.A.wood = 5;

		// Fortify A-1
		let result = applyMove(state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		expect(state.players.A.units.find((u) => u.id === "A-1")?.isFortified).toBe(
			true,
		);

		// End A's turn
		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		// During B's turn, A-1 should still be fortified
		expect(state.players.A.units.find((u) => u.id === "A-1")?.isFortified).toBe(
			true,
		);

		// End B's turn → A's start-of-turn tick clears fortify
		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		expect(state.players.A.units.find((u) => u.id === "A-1")?.isFortified).toBe(
			false,
		);
	});

	// ---- Terrain defense bonus ----

	test("stronghold gives +3 defense bonus", () => {
		let state = createInitialState(0, undefined, [...players]);
		state = clearUnits(state);
		// Place defender on stronghold_a B2 and attacker adjacent
		state = addUnitToState(state, "B-1", "infantry", "B", "B2");
		state = addUnitToState(state, "A-1", "cavalry", "A", "B1");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "B2",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| Extract<EngineEvent, { type: "attack" }>
			| undefined;
		// Infantry DEF 4 + stronghold 3 = 7
		expect(atkEvent?.defensePower).toBe(7);
		// Cavalry ATK 4 < 7 → attacker dies
		expect(atkEvent?.outcome.attacker).toBe("dies");
	});
});
