import { describe, expect, test } from "bun:test";
import {
	applyMove,
	bindEngineConfig,
	createInitialState,
	DEFAULT_CONFIG,
	type EngineConfigInput,
	type EngineEvent,
	getEngineConfig,
	type HexId,
	listLegalMoves,
	type MatchState,
	type Move,
	neighborsOf,
	parseHexId,
	type Unit,
} from "@fightclaw/engine";

const players = ["agent-a", "agent-b"] as const;
const LEGACY_TEST_CONFIG: EngineConfigInput = {
	boardColumns: 21,
	actionsPerTurn: 5,
	turnLimit: 20,
};

function createLegacyState(
	seed: number,
	configInput?: EngineConfigInput,
): MatchState {
	return createInitialState(
		seed,
		{
			...LEGACY_TEST_CONFIG,
			...configInput,
		},
		[...players],
	);
}

function cloneWithConfig(state: MatchState): MatchState {
	return bindEngineConfig(structuredClone(state), getEngineConfig(state));
}

function hexIndex(
	id: HexId,
	boardContext: number | MatchState = LEGACY_TEST_CONFIG.boardColumns ?? 21,
): number {
	const { row, col } = parseHexId(id);
	const columns =
		typeof boardContext === "number"
			? boardContext
			: getEngineConfig(boardContext).boardColumns;
	return row * columns + col;
}

/** Remove all units from a state */
function clearUnits(state: MatchState): MatchState {
	const s = cloneWithConfig(state);
	s.players.A.units = [];
	s.players.B.units = [];
	for (let i = 0; i < s.board.length; i++) {
		// biome-ignore lint/style/noNonNullAssertion: loop bounded by array length
		s.board[i] = { ...s.board[i]!, unitIds: [] };
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
	const s = cloneWithConfig(state);
	const hp = DEFAULT_CONFIG.unitStats[type].hp;
	const unit: Unit = {
		id,
		type,
		owner,
		position,
		hp,
		maxHp: hp,
		isFortified: false,
		movedThisTurn: false,
		movedDistance: 0,
		attackedThisTurn: false,
		canActThisTurn: true,
		...opts,
	};
	s.players[owner].units.push(unit);
	const idx = hexIndex(position, s);
	const boardHex = s.board[idx];
	if (boardHex) {
		s.board[idx] = {
			...boardHex,
			unitIds: [...boardHex.unitIds, id],
		};
	}
	return s;
}

type AttackEvent = Extract<EngineEvent, { type: "attack" }>;

describe("v2 engine - War of Attrition", () => {
	// ---- Initial state correctness ----

	test("default config uses 17x9 board with 7 actions and 40 turn limit", () => {
		const state = createInitialState(0, undefined, [...players]);
		const config = getEngineConfig(state);
		expect(config.boardColumns).toBe(17);
		expect(config.actionsPerTurn).toBe(7);
		expect(config.turnLimit).toBe(40);
		expect(state.board.length).toBe(9 * 17);
		expect(state.actionsRemaining).toBe(7);
	});

	test("initial state has 189 hexes", () => {
		const state = createLegacyState(0);
		expect(state.board.length).toBe(189);
	});

	test("initial state has 12 units (6 per side)", () => {
		const state = createLegacyState(0);
		expect(state.players.A.units.length).toBe(6);
		expect(state.players.B.units.length).toBe(6);
	});

	test("initial state has correct unit placements", () => {
		const state = createLegacyState(0);
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
		const state = createLegacyState(0);
		const a1 = state.board[hexIndex("A1")];
		expect(a1?.controlledBy).toBe("A");
		expect(a1?.type).toBe("deploy_a");

		const a21 = state.board[hexIndex("A21")];
		expect(a21?.controlledBy).toBe("B");
		expect(a21?.type).toBe("deploy_b");

		const e11 = state.board[hexIndex("E11")];
		expect(e11?.controlledBy).toBe(null);
		expect(e11?.type).toBe("crown");
	});

	test("initial state has starting gold/wood plus Turn 1 stronghold income", () => {
		const state = createLegacyState(0);
		// startingGold=15 + 2 strongholds * 2 gold each = 15 + 4 = 19
		expect(state.players.A.gold).toBe(19);
		// startingWood=5 + no lumber camps controlled = 5
		expect(state.players.A.wood).toBe(5);
		expect(state.players.A.vp).toBe(0);

		// Player B has starting resources but no turn-1 tick yet
		expect(state.players.B.gold).toBe(15);
		expect(state.players.B.wood).toBe(5);
	});

	test("initial state has correct resource reserves on gold mines and lumber camps", () => {
		const state = createLegacyState(0);
		const b9 = state.board[hexIndex("B9")];
		expect(b9?.type).toBe("gold_mine");
		expect(b9?.reserve).toBe(20);

		const c8 = state.board[hexIndex("C8")];
		expect(c8?.type).toBe("lumber_camp");
		expect(c8?.reserve).toBe(15);
	});

	test("activePlayer is A and actionsRemaining is 5 (legacy config)", () => {
		const state = createLegacyState(0);
		expect(state.activePlayer).toBe("A");
		expect(state.actionsRemaining).toBe(5);
	});

	test("units have hp and maxHp", () => {
		const state = createLegacyState(0);
		const infantry = state.players.A.units.find((u) => u.type === "infantry");
		expect(infantry?.hp).toBe(3);
		expect(infantry?.maxHp).toBe(3);
		const cavalry = state.players.A.units.find((u) => u.type === "cavalry");
		expect(cavalry?.hp).toBe(2);
		expect(cavalry?.maxHp).toBe(2);
		const archer = state.players.A.units.find((u) => u.type === "archer");
		expect(archer?.hp).toBe(2);
		expect(archer?.maxHp).toBe(2);
	});

	test("board hexes use unitIds array", () => {
		const state = createLegacyState(0);
		const b2 = state.board[hexIndex("B2")];
		expect(Array.isArray(b2?.unitIds)).toBe(true);
		expect(b2?.unitIds.length).toBe(1);
		expect(b2?.unitIds[0]).toBe("A-1");

		const e11 = state.board[hexIndex("E11")];
		expect(e11?.unitIds.length).toBe(0);
	});

	// ---- Turn numbering ----

	test("turn increments only after Player B ends", () => {
		let state = createLegacyState(0);
		expect(state.turn).toBe(1);

		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		expect(state.activePlayer).toBe("B");
		expect(state.turn).toBe(1);

		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		expect(state.activePlayer).toBe("A");
		expect(state.turn).toBe(2);
	});

	// ---- end_turn vs pass equivalence ----

	test("end_turn and pass are equivalent", () => {
		const state1 = createLegacyState(0);
		const state2 = createLegacyState(0);

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
			let state = createLegacyState(1);
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

	test("engine config stays isolated per state across mixed matches", () => {
		const stateA = createInitialState(
			11,
			{ actionsPerTurn: 7, boardColumns: 17 },
			[...players],
		);
		const stateB = createInitialState(
			22,
			{ actionsPerTurn: 3, boardColumns: 21 },
			[...players],
		);

		const resultA = applyMove(stateA, { action: "end_turn" });
		expect(resultA.ok).toBe(true);
		if (!resultA.ok) return;

		const resultB = applyMove(stateB, { action: "end_turn" });
		expect(resultB.ok).toBe(true);
		if (!resultB.ok) return;

		expect(resultA.state.actionsRemaining).toBe(7);
		expect(resultB.state.actionsRemaining).toBe(3);
		expect(resultA.state.board.length).toBe(9 * 17);
		expect(resultB.state.board.length).toBe(9 * 21);
	});

	test("bindEngineConfig preserves replay config after state deserialization", () => {
		const configured = createInitialState(
			7,
			{ actionsPerTurn: 7, boardColumns: 17 },
			[...players],
		);
		const rebound = bindEngineConfig(
			structuredClone(configured),
			getEngineConfig(configured),
		);

		const result = applyMove(rebound, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.actionsRemaining).toBe(7);
		expect(result.state.board.length).toBe(9 * 17);
	});

	// ---- Move validation ----

	test("illegal move rejection reason is stable", () => {
		const state = createLegacyState(0);
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
		let state = createLegacyState(0);
		// A-1 is infantry at B2. Movement is now 2.
		// Find an empty neighbor to move to
		const boardColumns = getEngineConfig(state).boardColumns;
		const nbrs = neighborsOf("B2", boardColumns);
		let moveTo: HexId | null = null;
		for (const n of nbrs) {
			const hex = state.board[hexIndex(n)];
			if (hex && hex.unitIds.length === 0) {
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
		const nbrs2 = neighborsOf(moveTo, boardColumns);
		let moveTo2: HexId | null = null;
		for (const n of nbrs2) {
			const hex = state.board[hexIndex(n)];
			if (hex && hex.unitIds.length === 0) {
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
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Cavalry ATK 4 + attacker bonus 1 = 5 vs infantry DEF 4 + 0 terrain = 4
		// ATK > DEF → damage = 1, no counterattack
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
		let state = createLegacyState(0);
		state = cloneWithConfig(state);
		state.players.A.gold = 100;
		// Move A-1 off B2 so we can recruit there
		// biome-ignore lint/style/noNonNullAssertion: unit known to exist
		const a1 = state.players.A.units.find((u) => u.id === "A-1")!;
		const oldIdx = hexIndex(a1.position);
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[oldIdx] = { ...state.board[oldIdx]!, unitIds: [] };
		a1.position = "B4";
		const b4Idx = hexIndex("B4");
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[b4Idx] = { ...state.board[b4Idx]!, unitIds: ["A-1"] };

		const r1 = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "B2",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;
		state = r1.state;

		const newUnit = state.players.A.units.find(
			(u) => u.position === "B2" && u.id !== "A-1",
		);
		expect(newUnit).toBeTruthy();
		expect(newUnit?.canActThisTurn).toBe(false);
		expect(newUnit?.hp).toBeGreaterThan(0);

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
		let state = createLegacyState(0);
		state = cloneWithConfig(state);
		state.players.A.gold = 100;
		// Move A-1 off B2
		// biome-ignore lint/style/noNonNullAssertion: unit known to exist
		const a1 = state.players.A.units.find((u) => u.id === "A-1")!;
		const previousHex = state.board[hexIndex(a1.position)];
		if (!previousHex) throw new Error("Expected source hex to exist");
		state.board[hexIndex(a1.position)] = {
			...previousHex,
			unitIds: [],
		};
		a1.position = "B4";
		const nextHex = state.board[hexIndex("B4")];
		if (!nextHex) throw new Error("Expected destination hex to exist");
		state.board[hexIndex("B4")] = {
			...nextHex,
			unitIds: ["A-1"],
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
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.gold = 100;

		const result = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "A1",
		});
		expect(result.ok).toBe(false);
	});

	test("recruit at enemy stronghold fails", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.gold = 100;

		const result = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "B20",
		});
		expect(result.ok).toBe(false);
	});

	// ---- Fortify ----

	test("fortify costs 2 wood and grants fortified status", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.wood = 3;

		const result = applyMove(state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.players.A.wood).toBe(1);
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
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.wood = 0;

		const result = applyMove(state, {
			action: "fortify",
			unitId: "A-1",
		});
		expect(result.ok).toBe(false);
	});

	test("fortify after move fails", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.wood = 3;

		const boardColumns = getEngineConfig(state).boardColumns;
		const nbrs = neighborsOf("B2", boardColumns);
		let moveTo: HexId | null = null;
		for (const n of nbrs) {
			const hex = state.board[hexIndex(n)];
			if (hex && hex.unitIds.length === 0) {
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

	// ---- HP-based combat ----

	test("HP-based combat: attacker advantage deals damage without dying", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Cavalry ATK 4 + attacker bonus 2 = 6 vs infantry DEF 4 + 0 terrain (plains) = 4
		// ATK > DEF → damage to defenders = 1, damage to attackers = 0
		state = addUnitToState(state, "A-1", "cavalry", "A", "E5");
		state = addUnitToState(state, "B-1", "infantry", "B", "E6");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E6",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent).toBeTruthy();
		expect(atkEvent?.attackPower).toBe(6); // 4 base + 2 attacker bonus
		expect(atkEvent?.defensePower).toBe(4); // 4 base + 0 terrain
		expect(atkEvent?.outcome.damageDealt).toBe(2);
		expect(atkEvent?.outcome.damageTaken).toBe(0);
		// Infantry has 3 HP, takes 1 → survives
		expect(atkEvent?.outcome.defenderSurvivors.length).toBe(1);
		expect(atkEvent?.outcome.defenderCasualties.length).toBe(0);
		// Attacker survives
		expect(atkEvent?.outcome.attackerSurvivors.length).toBe(1);
		// No capture because defender alive
		expect(atkEvent?.outcome.captured).toBe(false);
	});

	test("HP-based combat: repeated attacks kill a unit", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Cavalry ATK 4 + 1 = 5 vs archer DEF 1 + 0 - 1 melee vuln = 0
		// ATK > DEF → damage = 5, archer HP = 2 → dies in one hit
		state = addUnitToState(state, "A-1", "cavalry", "A", "E10");
		state = addUnitToState(state, "B-1", "archer", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent?.outcome.defenderCasualties.length).toBe(1);
		// Melee capture: attacker moves in
		expect(atkEvent?.outcome.captured).toBe(true);
	});

	test("HP-based combat: weaker attacker still deals minimum 1 damage", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Infantry ATK 2 + 1 attacker = 3 vs infantry DEF 4 + 1 (hills) = 5
		// ATK < DEF → damage to defenders = 1, damage to attackers = 1 (melee counterattack)
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		// E7 is hills
		state = addUnitToState(state, "B-1", "infantry", "B", "E7");
		// Need them adjacent. Let's use a simpler setup.
		// E2 is plains, E3 is plains. Both on plains.
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "E2");
		// Place defender on hills (E7)
		expect(state.board[hexIndex("E7")]?.type).toBe("hills");
		state = addUnitToState(state, "B-1", "infantry", "B", "E7");

		// Move A-1 closer to E7 first - they're far apart
		// For simplicity, place them adjacent
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "E6");
		state = addUnitToState(state, "B-1", "infantry", "B", "E7");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E7",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent).toBeTruthy();
		// ATK = 2 + 2 = 4, DEF = 4 + 1 (hills) = 5
		expect(atkEvent?.attackPower).toBe(4);
		expect(atkEvent?.defensePower).toBe(5);
		// ATK < DEF: minimum 1 damage to defender, 1 counterattack to attacker
		expect(atkEvent?.outcome.damageDealt).toBe(1);
		expect(atkEvent?.outcome.damageTaken).toBe(1);
	});

	test("HP-based combat: equal ATK/DEF deals 1 damage to defender, 0 to attacker", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Need ATK == DEF.
		// Infantry ATK 2 + 2 attacker = 4, cavalry DEF 2 + 1 (hills) = 3
		state = addUnitToState(state, "A-1", "infantry", "A", "E6");
		expect(state.board[hexIndex("E7")]?.type).toBe("hills");
		state = addUnitToState(state, "B-1", "cavalry", "B", "E7");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E7",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent?.attackPower).toBe(4);
		expect(atkEvent?.defensePower).toBe(3);
		expect(atkEvent?.outcome.damageDealt).toBe(1);
		expect(atkEvent?.outcome.damageTaken).toBe(0);
	});

	test("ranged attack: no counterattack when ATK < DEF", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Archer ATK 3 + 1 attacker = 4 vs infantry DEF 4 + 1 (crown) = 5
		// ATK < DEF, ranged → damage to attackers = 0
		state = addUnitToState(state, "A-1", "archer", "A", "E9");
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent?.outcome.damageTaken).toBe(0); // ranged, no counterattack
		expect(atkEvent?.outcome.damageDealt).toBe(1); // minimum 1
		expect(atkEvent?.outcome.captured).toBe(false); // ranged never captures
	});

	// ---- VP for kills ----

	test("VP awarded for killing enemy units", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Cavalry ATK 4 + 1 = 5 vs archer DEF 1 + 0 - 1 = 0 → damage 5, archer HP 2 → dead
		state = addUnitToState(state, "A-1", "cavalry", "A", "E10");
		state = addUnitToState(state, "B-1", "archer", "B", "E11");
		state = addUnitToState(state, "B-2", "infantry", "B", "I21"); // keep B alive

		const startVp = state.players.A.vp;
		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.players.A.vp).toBe(startVp + 1); // +1 VP per kill
	});

	// ---- Cavalry Charge ----

	test("cavalry charge grants +2 ATK when moved >= 2 on forest-free path", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "cavalry", "A", "B4");
		state = addUnitToState(state, "B-1", "infantry", "B", "B7");

		expect(state.board[hexIndex("B5")]?.type).toBe("plains");

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

		const r2 = applyMove(r1.state, {
			action: "attack",
			unitId: "A-1",
			target: "B7",
		});
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		const attackEvent = r2.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(attackEvent).toBeTruthy();
		// Cavalry base ATK 4 + attacker bonus 2 + charge 2 = 8
		expect(attackEvent?.attackPower).toBe(8);
		expect(attackEvent?.abilities).toContain("cavalry_charge");
	});

	test("cavalry charge denied when path goes through forest", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "cavalry", "A", "E3");
		state = addUnitToState(state, "B-1", "infantry", "B", "E6");

		const e4 = state.board[hexIndex("E4")];
		expect(e4?.type).toBe("forest");

		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "E5",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		const movedUnit = r1.state.players.A.units.find((u) => u.id === "A-1");
		expect(movedUnit?.chargeEligible).toBeFalsy();
	});

	test("stacked cavalry uses initiating attacker charge eligibility", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Intentionally create stack order [A-2, A-1]
		state = addUnitToState(state, "A-2", "cavalry", "A", "B4");
		state = addUnitToState(state, "A-1", "cavalry", "A", "B4");
		state = addUnitToState(state, "B-1", "infantry", "B", "B7");

		const r1 = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "B6",
		});
		expect(r1.ok).toBe(true);
		if (!r1.ok) return;

		expect(r1.state.board[hexIndex("B6")]?.unitIds).toEqual(["A-2", "A-1"]);
		expect(
			r1.state.players.A.units.find((u) => u.id === "A-1")?.chargeEligible,
		).toBe(true);

		const r2 = applyMove(r1.state, {
			action: "attack",
			unitId: "A-1",
			target: "B7",
		});
		expect(r2.ok).toBe(true);
		if (!r2.ok) return;

		const attackEvent = r2.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(attackEvent).toBeTruthy();
		// base 4 + attacker bonus 2 + stack bonus 1 + charge 2
		expect(attackEvent?.attackPower).toBe(9);
		expect(attackEvent?.abilities).toContain("cavalry_charge");
	});

	// ---- Shield Wall ----

	test("shield wall +1 per adjacent hex with friendly infantry, max +1", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "B-1", "infantry", "B", "D10");
		const boardColumns = getEngineConfig(state).boardColumns;
		const d10Neighbors = neighborsOf("D10", boardColumns);
		// biome-ignore lint/style/noNonNullAssertion: hex always has neighbors
		const friendlyPos1 = d10Neighbors[0]!;
		// biome-ignore lint/style/noNonNullAssertion: hex always has neighbors
		const friendlyPos2 = d10Neighbors[1]!;
		state = addUnitToState(state, "B-2", "infantry", "B", friendlyPos1);
		state = addUnitToState(state, "B-3", "infantry", "B", friendlyPos2);

		let attackerPos: HexId | null = null;
		for (const n of d10Neighbors) {
			if (
				n !== friendlyPos1 &&
				n !== friendlyPos2 &&
				state.board[hexIndex(n)]?.unitIds.length === 0
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
			| AttackEvent
			| undefined;
		expect(atkEvent).toBeTruthy();
		// Infantry base DEF 4 + terrain 0 (plains) + shield wall +1 = 5
		expect(atkEvent?.defensePower).toBe(5);
		expect(atkEvent?.abilities).toContain("shield_wall_+1");
	});

	test("shield wall caps at +1 even with 3+ adjacent infantry hexes", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "B-1", "infantry", "B", "D10");
		const boardColumns = getEngineConfig(state).boardColumns;
		const d10Neighbors = neighborsOf("D10", boardColumns);
		// biome-ignore lint/style/noNonNullAssertion: hex always has neighbors
		state = addUnitToState(state, "B-2", "infantry", "B", d10Neighbors[0]!);
		// biome-ignore lint/style/noNonNullAssertion: hex always has neighbors
		state = addUnitToState(state, "B-3", "infantry", "B", d10Neighbors[1]!);
		// biome-ignore lint/style/noNonNullAssertion: hex always has neighbors
		state = addUnitToState(state, "B-4", "infantry", "B", d10Neighbors[2]!);

		let attackerPos: HexId | null = null;
		for (let i = 3; i < d10Neighbors.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: loop bounded by array length
			const n = d10Neighbors[i]!;
			if (state.board[hexIndex(n)]?.unitIds.length === 0) {
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
			| AttackEvent
			| undefined;
		// Still capped at +1
		expect(atkEvent?.defensePower).toBe(5);
	});

	// ---- Archer melee vulnerability ----

	test("archer melee vulnerability: -1 DEF at distance 1", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
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
			| AttackEvent
			| undefined;
		// Archer DEF 1 + 0 terrain - 1 melee vuln = 0
		expect(atkEvent?.defensePower).toBe(0);
		expect(atkEvent?.abilities).toContain("archer_melee_vulnerability");
		// ATK 2 + 1 = 3 > 0 → damage = 3, archer HP = 2 → dies
		expect(atkEvent?.outcome.defenderCasualties.length).toBe(1);
	});

	// ---- Archer LoS ----

	test("archer LoS blocked by forest on target hex", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "archer", "A", "C8");
		expect(state.board[hexIndex("C10")]?.type).toBe("forest");
		state = addUnitToState(state, "B-1", "infantry", "B", "C10");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "C10",
		});
		expect(result.ok).toBe(false);
	});

	test("archer LoS blocked by unit on mid hex (not on high ground)", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "archer", "A", "E9");
		state = addUnitToState(state, "A-2", "infantry", "A", "E10");
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(false);
	});

	test("archer LoS: high ground bypasses unit blocking", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		expect(state.board[hexIndex("D11")]?.type).toBe("high_ground");
		expect(state.board[hexIndex("E11")]?.type).toBe("crown");
		expect(state.board[hexIndex("F10")]?.type).toBe("plains");

		state = addUnitToState(state, "A-1", "archer", "A", "D11");
		state = addUnitToState(state, "A-2", "infantry", "A", "E11");
		state = addUnitToState(state, "B-1", "infantry", "B", "F10");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "F10",
		});
		expect(result.ok).toBe(true);
	});

	// ---- Resource node reserve depletion ----

	test("gold mine reserve depletes over turns", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		const b9Idx = hexIndex("B9");
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[b9Idx] = { ...state.board[b9Idx]!, controlledBy: "A" };

		const startingGold = state.players.A.gold;
		// biome-ignore lint/style/noNonNullAssertion: gold_mine always has reserve
		const startingReserve = state.board[b9Idx]!.reserve!;

		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;

		// A got income: gold mine min(3,20)=3 + 2 strongholds * 2 = 4
		expect(state.players.A.gold).toBe(startingGold + 4 + 3);
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		expect(state.board[b9Idx]!.reserve).toBe(startingReserve - 3);
	});

	test("lumber camp reserve depletes and yields wood", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		const c8Idx = hexIndex("C8");
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[c8Idx] = { ...state.board[c8Idx]!, controlledBy: "A" };

		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		result = applyMove(result.state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// startingWood=5 + lumber camp min(2,15)=2 = 7
		expect(result.state.players.A.wood).toBe(5 + 2);
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		expect(result.state.board[c8Idx]!.reserve).toBe(15 - 2);
	});

	// ---- Crown VP accumulation ----

	test("crown hex controlled yields VP", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		const e11Idx = hexIndex("E11");
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[e11Idx] = { ...state.board[e11Idx]!, controlledBy: "A" };

		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		result = applyMove(result.state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.players.A.vp).toBe(1);
	});

	// ---- Stronghold income ----

	test("stronghold gives +2 gold per controlled stronghold at start-of-turn", () => {
		const state = createLegacyState(0);
		// startingGold=15 + 2 strongholds * 2 = 19
		expect(state.players.A.gold).toBe(19);
	});

	// ---- Sticky control ----

	test("empty hex keeps control (sticky)", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		const e10Idx = hexIndex("E10");
		// biome-ignore lint/style/noNonNullAssertion: valid board index
		state.board[e10Idx] = { ...state.board[e10Idx]!, controlledBy: "A" };

		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.board[e10Idx]?.controlledBy).toBe("A");
	});

	// ---- Victory conditions ----

	test("ONE stronghold capture is enough to win", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Place A unit on just ONE of B's strongholds
		state = addUnitToState(state, "A-1", "infantry", "A", "B20");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

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
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Cavalry ATK 4+1=5 vs archer DEF 1+0-1=0, damage=5, hp=2 → dead
		state = addUnitToState(state, "A-1", "cavalry", "A", "E10");
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
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		state = cloneWithConfig(state);
		const config = getEngineConfig(state);
		state.turn = config.turnLimit;
		state.activePlayer = "B";
		state.actionsRemaining = config.actionsPerTurn;
		state.players.A.vp = 5;
		state.players.B.vp = 3;

		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.status).toBe("ended");
		const gameEnd = result.engineEvents.find((e) => e.type === "game_end") as
			| Extract<EngineEvent, { type: "game_end" }>
			| undefined;
		expect(gameEnd?.reason).toBe("turn_limit");
		expect(gameEnd?.winner).toBe("agent-a");
	});

	test("turn limit draw when all tiebreakers equal", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "A1");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		state = cloneWithConfig(state);
		const config = getEngineConfig(state);
		state.turn = config.turnLimit;
		state.activePlayer = "B";
		state.actionsRemaining = config.actionsPerTurn;
		state.players.A.vp = 0;
		state.players.B.vp = 0;
		for (let i = 0; i < state.board.length; i++) {
			// biome-ignore lint/style/noNonNullAssertion: loop bounded by array length
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
		let state = createLegacyState(0);
		state = clearUnits(state);
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
		expect(attacker?.position).toBe("E11");
	});

	test("ranged attack does not move attacker", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// Archer ATK 3+1=4 vs infantry DEF 4+1(crown)=5. ATK < DEF, ranged.
		state = addUnitToState(state, "A-1", "archer", "A", "E9");
		state = addUnitToState(state, "B-1", "infantry", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent?.outcome.captured).toBe(false);
		// Archer should stay at E9
		const archer = result.state.players.A.units.find((u) => u.id === "A-1");
		expect(archer?.position).toBe("E9");
	});

	// ---- listLegalMoves includes end_turn ----

	test("listLegalMoves always includes end_turn", () => {
		const state = createLegacyState(0);
		const moves = listLegalMoves(state);
		const endTurns = moves.filter((m) => m.action === "end_turn");
		expect(endTurns.length).toBe(1);
	});

	// ---- Fortify persists until start of owner's next turn ----

	test("fortify is cleared at start of player's next turn", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.wood = 5;

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

		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		expect(state.players.A.units.find((u) => u.id === "A-1")?.isFortified).toBe(
			true,
		);

		result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		state = result.state;
		expect(state.players.A.units.find((u) => u.id === "A-1")?.isFortified).toBe(
			false,
		);
	});

	// ---- Terrain defense bonus ----

	test("stronghold gives +1 defense bonus", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
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
			| AttackEvent
			| undefined;
		// Infantry DEF 4 + stronghold 1 = 5
		expect(atkEvent?.defensePower).toBe(5);
	});

	test("fortify bonus is configurable and stacks with terrain fortify bonuses", () => {
		let state = createLegacyState(0, {
			abilities: { fortifyBonus: 2 },
			fortifyDefenseBonusByTerrain: { hills: 2 },
		});
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "cavalry", "A", "E6");
		state = addUnitToState(state, "B-1", "infantry", "B", "E7", {
			isFortified: true,
		});

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E7",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		expect(atkEvent).toBeTruthy();
		expect(atkEvent?.defensePower).toBe(8);
		expect(atkEvent?.abilities).toContain("fortify");
	});

	test("controlling multiple economy nodes grants long-horizon macro income", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		const b9Idx = hexIndex("B9");
		const c8Idx = hexIndex("C8");
		const b9Hex = state.board[b9Idx];
		const c8Hex = state.board[c8Idx];
		if (!b9Hex || !c8Hex) throw new Error("Expected economy hexes to exist");
		state.board[b9Idx] = { ...b9Hex, controlledBy: "A" };
		state.board[c8Idx] = { ...c8Hex, controlledBy: "A" };

		const startingGold = state.players.A.gold;
		const startingWood = state.players.A.wood;

		let result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		result = applyMove(result.state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.state.players.A.gold).toBe(startingGold + 8);
		expect(result.state.players.A.wood).toBe(startingWood + 3);
	});

	test("comeback stipend applies when a player is behind on multiple axes", () => {
		let state = createLegacyState(0);
		state = structuredClone(state);
		state.players.A.vp = 5;
		state.players.B.vp = 0;

		const removed = state.players.B.units.splice(0, 2);
		for (const unit of removed) {
			const idx = hexIndex(unit.position);
			const hex = state.board[idx];
			if (!hex) throw new Error("Expected unit hex to exist");
			state.board[idx] = {
				...hex,
				unitIds: hex.unitIds.filter((id) => id !== unit.id),
			};
		}

		const result = applyMove(state, { action: "end_turn" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.state.activePlayer).toBe("B");
		expect(result.state.players.B.gold).toBe(21);
		expect(result.state.players.B.wood).toBe(6);
	});

	// ---- Unit Stacking ----

	test("same-type friendly units can stack on same hex", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		state = addUnitToState(state, "A-2", "infantry", "A", "E9");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21"); // avoid elimination

		// Move A-2 onto A-1's hex
		const result = applyMove(state, {
			action: "move",
			unitId: "A-2",
			to: "E10",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const hex = result.state.board[hexIndex("E10")];
		expect(hex?.unitIds.length).toBe(2);
	});

	test("different-type friendly units cannot stack", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		state = addUnitToState(state, "A-2", "cavalry", "A", "E9");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		const result = applyMove(state, {
			action: "move",
			unitId: "A-2",
			to: "E10",
		});
		expect(result.ok).toBe(false);
	});

	test("stack attack bonus increases ATK", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		// 2 infantry on same hex: ATK = 2 + 1 attacker + 1 stack = 4
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		state = addUnitToState(state, "A-2", "infantry", "A", "E10");
		state = addUnitToState(state, "B-1", "archer", "B", "E11");

		const result = applyMove(state, {
			action: "attack",
			unitId: "A-1",
			target: "E11",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const atkEvent = result.engineEvents.find((e) => e.type === "attack") as
			| AttackEvent
			| undefined;
		// 2 infantry: base ATK 2 + 2 attacker bonus + 1 stack bonus = 5
		expect(atkEvent?.attackPower).toBe(5);
		expect(atkEvent?.abilities).toContain("stack_atk_+1");
	});

	test("moving a stacked unit moves entire stack", () => {
		let state = createLegacyState(0);
		state = clearUnits(state);
		state = addUnitToState(state, "A-1", "infantry", "A", "E10");
		state = addUnitToState(state, "A-2", "infantry", "A", "E10");
		state = addUnitToState(state, "B-1", "infantry", "B", "I21");

		const result = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "E9",
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		// Both units should be at E9
		const u1 = result.state.players.A.units.find((u) => u.id === "A-1");
		const u2 = result.state.players.A.units.find((u) => u.id === "A-2");
		expect(u1?.position).toBe("E9");
		expect(u2?.position).toBe("E9");

		const srcHex = result.state.board[hexIndex("E10")];
		expect(srcHex?.unitIds.length).toBe(0);
		const dstHex = result.state.board[hexIndex("E9")];
		expect(dstHex?.unitIds.length).toBe(2);
	});

	test("recruit requires empty stronghold (no stacking into stronghold)", () => {
		const state = createLegacyState(0);
		// B2 has A-1 infantry on it already
		const result = applyMove(state, {
			action: "recruit",
			unitType: "infantry",
			at: "B2",
		});
		expect(result.ok).toBe(false);
	});

	test("listLegalMoves includes upgrade for eligible base units", () => {
		const state = createLegacyState(0);
		const legalMoves = listLegalMoves(state);
		expect(
			legalMoves.some((m) => m.action === "upgrade" && m.unitId === "A-1"),
		).toBe(true);
	});

	test("upgrade converts base unit into tier 2 unit and spends resources", () => {
		const state = createLegacyState(0);
		const beforeGold = state.players.A.gold;
		const beforeWood = state.players.A.wood;
		const result = applyMove(state, { action: "upgrade", unitId: "A-1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		const upgraded = result.state.players.A.units.find((u) => u.id === "A-1");
		expect(upgraded?.type).toBe("swordsman");
		expect(result.state.players.A.gold).toBe(
			beforeGold - DEFAULT_CONFIG.upgradeCosts.infantry.gold,
		);
		expect(result.state.players.A.wood).toBe(
			beforeWood - DEFAULT_CONFIG.upgradeCosts.infantry.wood,
		);
		expect(result.state.actionsRemaining).toBe(4);
		const upgradeEvent = result.engineEvents.find((e) => e.type === "upgrade");
		expect(upgradeEvent).toBeTruthy();
	});

	test("cannot upgrade a tier 2 unit again", () => {
		let state = createLegacyState(0);
		const first = applyMove(state, { action: "upgrade", unitId: "A-1" });
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		state = first.state;
		const second = applyMove(state, { action: "upgrade", unitId: "A-1" });
		expect(second.ok).toBe(false);
	});

	test("recruit does not allow tier 2 unit types", () => {
		let state = createLegacyState(0);
		const moveOff = applyMove(state, {
			action: "move",
			unitId: "A-1",
			to: "A1",
		});
		expect(moveOff.ok).toBe(true);
		if (!moveOff.ok) return;
		state = moveOff.state;
		const result = applyMove(state, {
			action: "recruit",
			unitType: "swordsman" as never,
			at: "B2",
		});
		expect(result.ok).toBe(false);
	});
});
