import { z } from "zod";

// War of Attrition v2 — 21x9 hex grid, HexId coords, resource reserves, abilities

export type AgentId = string;
export type PlayerSide = "A" | "B";
export type HexId = string; // "A1".."I21"
export type HexType =
	| "plains"
	| "forest"
	| "hills"
	| "high_ground"
	| "gold_mine"
	| "lumber_camp"
	| "crown"
	| "stronghold_a"
	| "stronghold_b"
	| "deploy_a"
	| "deploy_b";
export type UnitType = "infantry" | "cavalry" | "archer";

export type Move =
	| { action: "move"; unitId: string; to: HexId; reasoning?: string }
	| { action: "attack"; unitId: string; target: HexId; reasoning?: string }
	| {
			action: "recruit";
			unitType: UnitType;
			at: HexId;
			reasoning?: string;
	  }
	| { action: "fortify"; unitId: string; reasoning?: string }
	| { action: "end_turn"; reasoning?: string }
	| { action: "pass"; reasoning?: string };

export type Unit = {
	id: string;
	type: UnitType;
	owner: PlayerSide;
	position: HexId;
	isFortified: boolean;
	movedThisTurn: boolean;
	movedDistance: number;
	attackedThisTurn: boolean;
	canActThisTurn: boolean;
	chargeEligible?: boolean;
};

export type PlayerState = {
	id: AgentId;
	gold: number;
	wood: number;
	vp: number;
	units: Unit[];
};

export type HexState = {
	id: HexId;
	type: HexType;
	controlledBy: PlayerSide | null;
	unitId: string | null;
	reserve?: number;
};

export type MatchState = {
	seed: number;
	turn: number;
	activePlayer: PlayerSide;
	actionsRemaining: number;
	players: {
		A: PlayerState;
		B: PlayerState;
	};
	board: HexState[];
	status: "active" | "ended";
};

export type GameState = MatchState;

export type TerminalReason =
	| "stronghold_capture"
	| "elimination"
	| "turn_limit"
	| "draw";

export type TerminalState =
	| { ended: false }
	| { ended: true; winner: AgentId | null; reason: TerminalReason };

export type MoveRejectionReason =
	| "invalid_move_schema"
	| "illegal_move"
	| "invalid_move"
	| "terminal";

export type EngineEvent =
	| {
			type: "turn_start";
			turn: number;
			player: PlayerSide;
			actions: number;
			goldIncome: number;
			woodIncome: number;
			vpGained: number;
			goldAfter: number;
			woodAfter: number;
			vpAfter: number;
	  }
	| {
			type: "recruit";
			turn: number;
			player: PlayerSide;
			unitId: string;
			unitType: UnitType;
			at: HexId;
	  }
	| {
			type: "move_unit";
			turn: number;
			player: PlayerSide;
			unitId: string;
			from: HexId;
			to: HexId;
	  }
	| {
			type: "fortify";
			turn: number;
			player: PlayerSide;
			unitId: string;
			at: HexId;
	  }
	| {
			type: "attack";
			turn: number;
			player: PlayerSide;
			attackerId: string;
			attackerFrom: HexId;
			defenderId: string;
			targetHex: HexId;
			distance: number;
			ranged: boolean;
			attackPower: number;
			defensePower: number;
			abilities: string[];
			outcome: {
				attacker: "survives" | "dies";
				defender: "survives" | "dies";
				captured: boolean;
			};
	  }
	| {
			type: "control_update";
			turn: number;
			changes: {
				hex: HexId;
				from: PlayerSide | null;
				to: PlayerSide | null;
			}[];
	  }
	| { type: "turn_end"; turn: number; player: PlayerSide }
	| {
			type: "game_end";
			turn: number;
			winner: AgentId | null;
			reason: TerminalReason;
	  }
	| {
			type: "reject";
			turn: number;
			player: PlayerSide;
			move: Move;
			reason: MoveRejectionReason;
	  };

export type Event = EngineEvent;

export type ApplyMoveResult =
	| { ok: true; state: MatchState; engineEvents: EngineEvent[] }
	| {
			ok: false;
			state: MatchState;
			engineEvents: EngineEvent[];
			reason: MoveRejectionReason;
			error: string;
	  };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ROWS = 9;
const COLS = 21;
const ACTIONS_PER_TURN = 3;
const TURN_LIMIT = 30;
const PLAYER_SIDES: PlayerSide[] = ["A", "B"];

const ROW_LETTERS = "ABCDEFGHI";

// Stronghold positions per side
const STRONGHOLD_HEXES: Record<PlayerSide, [HexId, HexId]> = {
	A: ["B2", "H2"],
	B: ["B20", "H20"],
};

// ---------------------------------------------------------------------------
// HexId coordinate helpers
// ---------------------------------------------------------------------------

export function parseHexId(id: HexId): { row: number; col: number } {
	const rowChar = id[0]!;
	const colStr = id.slice(1);
	return {
		row: rowChar.charCodeAt(0) - 65,
		col: Number(colStr) - 1,
	};
}

export function toHexId(row: number, col: number): HexId {
	return `${ROW_LETTERS[row]}${col + 1}`;
}

function hexIdIndex(id: HexId): number {
	const { row, col } = parseHexId(id);
	return row * COLS + col;
}

function isValidHexId(s: string): boolean {
	if (s.length < 2 || s.length > 3) return false;
	const rowChar = s[0]!;
	const rowIdx = rowChar.charCodeAt(0) - 65;
	if (rowIdx < 0 || rowIdx >= ROWS) return false;
	const colNum = Number(s.slice(1));
	if (!Number.isInteger(colNum) || colNum < 1 || colNum > COLS) return false;
	return true;
}

export function neighborsOf(id: HexId): HexId[] {
	const { row, col } = parseHexId(id);
	return neighbors(row, col);
}

function neighbors(row: number, col: number): HexId[] {
	// odd-r offset, pointy-top
	const deltas: ReadonlyArray<readonly [number, number]> =
		row % 2 === 0
			? ([
					[+1, 0],
					[0, +1],
					[-1, +1],
					[-1, 0],
					[-1, -1],
					[0, -1],
				] as const)
			: ([
					[+1, 0],
					[+1, +1],
					[0, +1],
					[-1, 0],
					[0, -1],
					[+1, -1],
				] as const);
	const result: HexId[] = [];
	for (const [dc, dr] of deltas) {
		const nr = row + dr;
		const nc = col + dc;
		if (nr >= 0 && nr < ROWS && nc >= 0 && nc < COLS) {
			result.push(toHexId(nr, nc));
		}
	}
	return result;
}

function hexDistance(a: HexId, b: HexId): number | null {
	return bfsDistance(a, b, undefined);
}

function bfsDistance(
	start: HexId,
	target: HexId,
	blocked?: Set<HexId>,
): number | null {
	if (!isValidHexId(start) || !isValidHexId(target)) return null;
	if (start === target) return 0;

	const queue: Array<{ id: HexId; dist: number }> = [{ id: start, dist: 0 }];
	const seen = new Set<HexId>([start]);
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const n of neighborsOf(current.id)) {
			if (seen.has(n)) continue;
			if (blocked && blocked.has(n)) continue;
			if (n === target) return current.dist + 1;
			seen.add(n);
			queue.push({ id: n, dist: current.dist + 1 });
		}
	}
	return null;
}

function pathDistance(
	start: HexId,
	target: HexId,
	blocked: Set<HexId>,
): number | null {
	return bfsDistance(start, target, blocked);
}

function reachableHexes(
	start: HexId,
	range: number,
	blocked: Set<HexId>,
): HexId[] {
	const results: HexId[] = [];
	const queue: Array<{ id: HexId; dist: number }> = [{ id: start, dist: 0 }];
	const seen = new Set<HexId>([start]);
	while (queue.length > 0) {
		const current = queue.shift()!;
		for (const n of neighborsOf(current.id)) {
			if (seen.has(n)) continue;
			if (blocked.has(n)) continue;
			const nextDist = current.dist + 1;
			if (nextDist > range) continue;
			seen.add(n);
			queue.push({ id: n, dist: nextDist });
			results.push(n);
		}
	}
	return results;
}

// Check if ANY shortest path from start to target (of length pathLen)
// avoids forest hexes (intermediate only, not start/target).
function hasForestFreePath(
	start: HexId,
	target: HexId,
	pathLen: number,
	blocked: Set<HexId>,
	board: HexState[],
): boolean {
	if (pathLen <= 1) return true; // adjacent, no intermediate hexes

	// BFS tracking all shortest paths
	const queue: Array<{ id: HexId; dist: number; forestFree: boolean }> = [
		{ id: start, dist: 0, forestFree: true },
	];
	const bestDist = new Map<HexId, number>();
	bestDist.set(start, 0);

	while (queue.length > 0) {
		const current = queue.shift()!;
		if (current.dist >= pathLen) continue;

		for (const n of neighborsOf(current.id)) {
			if (blocked.has(n) && n !== target) continue;
			const nextDist = current.dist + 1;
			if (nextDist > pathLen) continue;

			if (n === target && nextDist === pathLen) {
				if (current.forestFree) return true;
				continue;
			}

			const prev = bestDist.get(n);
			if (prev !== undefined && prev < nextDist) continue;

			const hex = board[hexIdIndex(n)];
			const isForest = hex?.type === "forest";
			const ff = current.forestFree && !isForest;

			// Only enqueue if we haven't seen this hex at this distance,
			// or if we can bring a forest-free path
			if (prev === undefined || prev > nextDist || ff) {
				if (prev === undefined || prev > nextDist) {
					bestDist.set(n, nextDist);
				}
				queue.push({ id: n, dist: nextDist, forestFree: ff });
			}
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Zod Schemas
// ---------------------------------------------------------------------------

export const HexIdSchema = z
	.string()
	.regex(/^[A-I](1[0-9]|2[01]|[1-9])$/, "Invalid HexId");

export const UnitTypeSchema = z.enum(["infantry", "cavalry", "archer"]);

export const MoveSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("move"),
			unitId: z.string(),
			to: HexIdSchema,
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("attack"),
			unitId: z.string(),
			target: HexIdSchema,
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("recruit"),
			unitType: UnitTypeSchema,
			at: HexIdSchema,
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("fortify"),
			unitId: z.string(),
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("end_turn"),
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("pass"),
			reasoning: z.string().optional(),
		})
		.strict(),
]);

export const MatchStateSchema = z.object({
	seed: z.number().int(),
	turn: z.number().int(),
	activePlayer: z.enum(["A", "B"]),
	actionsRemaining: z.number().int(),
	players: z.object({
		A: z.object({
			id: z.string(),
			gold: z.number(),
			wood: z.number(),
			vp: z.number(),
			units: z.array(
				z.object({
					id: z.string(),
					type: UnitTypeSchema,
					owner: z.enum(["A", "B"]),
					position: HexIdSchema,
					isFortified: z.boolean(),
					movedThisTurn: z.boolean(),
					movedDistance: z.number(),
					attackedThisTurn: z.boolean(),
					canActThisTurn: z.boolean(),
				}),
			),
		}),
		B: z.object({
			id: z.string(),
			gold: z.number(),
			wood: z.number(),
			vp: z.number(),
			units: z.array(
				z.object({
					id: z.string(),
					type: UnitTypeSchema,
					owner: z.enum(["A", "B"]),
					position: HexIdSchema,
					isFortified: z.boolean(),
					movedThisTurn: z.boolean(),
					movedDistance: z.number(),
					attackedThisTurn: z.boolean(),
					canActThisTurn: z.boolean(),
				}),
			),
		}),
	}),
	board: z.array(
		z.object({
			id: HexIdSchema,
			type: z.enum([
				"plains",
				"forest",
				"hills",
				"high_ground",
				"gold_mine",
				"lumber_camp",
				"crown",
				"stronghold_a",
				"stronghold_b",
				"deploy_a",
				"deploy_b",
			]),
			controlledBy: z.enum(["A", "B"]).nullable(),
			unitId: z.string().nullable(),
			reserve: z.number().optional(),
		}),
	),
	status: z.enum(["active", "ended"]),
});

export const GameStateSchema = MatchStateSchema;

// ---------------------------------------------------------------------------
// Unit stats & terrain config
// ---------------------------------------------------------------------------

export type EngineConfig = {
	actionsPerTurn: number;
	turnLimit: number;
	unitStats: {
		infantry: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
		};
		cavalry: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
		};
		archer: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
		};
	};
	terrainDefenseBonus: Record<HexType, number>;
	abilities: {
		cavalryChargeBonus: number;
		infantryAdjacencyBonusCap: number;
		archerMeleeVulnerability: number;
		fortifyBonus: number;
	};
	resourceNodes: {
		goldMineReserve: number;
		goldMineTick: number;
		lumberCampReserve: number;
		lumberCampTick: number;
		strongholdGoldTick: number;
		crownVpTick: number;
	};
};

export type EngineConfigInput = Partial<EngineConfig>;

export const DEFAULT_CONFIG: EngineConfig = {
	actionsPerTurn: ACTIONS_PER_TURN,
	turnLimit: TURN_LIMIT,
	unitStats: {
		infantry: { cost: 10, attack: 2, defense: 4, movement: 1, range: 1 },
		cavalry: { cost: 18, attack: 4, defense: 2, movement: 3, range: 1 },
		archer: { cost: 14, attack: 3, defense: 1, movement: 2, range: 2 },
	},
	terrainDefenseBonus: {
		plains: 0,
		deploy_a: 0,
		deploy_b: 0,
		gold_mine: 0,
		lumber_camp: 0,
		hills: 1,
		forest: 1,
		crown: 1,
		high_ground: 2,
		stronghold_a: 3,
		stronghold_b: 3,
	},
	abilities: {
		cavalryChargeBonus: 2,
		infantryAdjacencyBonusCap: 2,
		archerMeleeVulnerability: 1,
		fortifyBonus: 2,
	},
	resourceNodes: {
		goldMineReserve: 20,
		goldMineTick: 3,
		lumberCampReserve: 15,
		lumberCampTick: 2,
		strongholdGoldTick: 2,
		crownVpTick: 1,
	},
};

function mergeConfig(input?: EngineConfigInput): EngineConfig {
	if (!input) return DEFAULT_CONFIG;
	return {
		...DEFAULT_CONFIG,
		...input,
		unitStats: { ...DEFAULT_CONFIG.unitStats, ...input.unitStats },
		terrainDefenseBonus: {
			...DEFAULT_CONFIG.terrainDefenseBonus,
			...input.terrainDefenseBonus,
		},
		abilities: { ...DEFAULT_CONFIG.abilities, ...input.abilities },
		resourceNodes: {
			...DEFAULT_CONFIG.resourceNodes,
			...input.resourceNodes,
		},
	};
}

// We store config outside of MatchState to avoid exposing it on the wire.
// Tests can override via createInitialState's configInput param.
let _activeConfig: EngineConfig = DEFAULT_CONFIG;

function resolveConfig(): EngineConfig {
	return _activeConfig;
}

// ---------------------------------------------------------------------------
// Canonical board layout (189 hexes)
// ---------------------------------------------------------------------------

type TerrainToken =
	| "PLAINS"
	| "FOREST"
	| "HILLS"
	| "HIGH_GROUND"
	| "GOLD_MINE"
	| "LUMBER"
	| "CROWN"
	| "STRONGHOLD_A"
	| "STRONGHOLD_B"
	| "DEPLOY_A"
	| "DEPLOY_B";

const TOKEN_TO_HEX_TYPE: Record<TerrainToken, HexType> = {
	PLAINS: "plains",
	FOREST: "forest",
	HILLS: "hills",
	HIGH_GROUND: "high_ground",
	GOLD_MINE: "gold_mine",
	LUMBER: "lumber_camp",
	CROWN: "crown",
	STRONGHOLD_A: "stronghold_a",
	STRONGHOLD_B: "stronghold_b",
	DEPLOY_A: "deploy_a",
	DEPLOY_B: "deploy_b",
};

// Canonical terrain per row, 21 entries each (cols 1-21)
const CANONICAL_TERRAIN: TerrainToken[][] = [
	// Row A
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"DEPLOY_A",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"DEPLOY_B",
		"DEPLOY_B",
		"DEPLOY_B",
	],
	// Row B
	[
		"DEPLOY_A",
		"STRONGHOLD_A",
		"DEPLOY_A",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"FOREST",
		"PLAINS",
		"GOLD_MINE",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"GOLD_MINE",
		"PLAINS",
		"FOREST",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"DEPLOY_B",
		"STRONGHOLD_B",
		"DEPLOY_B",
	],
	// Row C
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"DEPLOY_A",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"LUMBER",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"LUMBER",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"DEPLOY_B",
		"DEPLOY_B",
		"DEPLOY_B",
	],
	// Row D
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"GOLD_MINE",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"HIGH_GROUND",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"GOLD_MINE",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"DEPLOY_B",
		"DEPLOY_B",
	],
	// Row E
	[
		"LUMBER",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"FOREST",
		"PLAINS",
		"GOLD_MINE",
		"CROWN",
		"GOLD_MINE",
		"PLAINS",
		"FOREST",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"LUMBER",
	],
	// Row F
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"GOLD_MINE",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"HIGH_GROUND",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"GOLD_MINE",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"DEPLOY_B",
		"DEPLOY_B",
	],
	// Row G
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"DEPLOY_A",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"LUMBER",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"LUMBER",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"DEPLOY_B",
		"DEPLOY_B",
		"DEPLOY_B",
	],
	// Row H
	[
		"DEPLOY_A",
		"STRONGHOLD_A",
		"DEPLOY_A",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"FOREST",
		"PLAINS",
		"GOLD_MINE",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"GOLD_MINE",
		"PLAINS",
		"FOREST",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"DEPLOY_B",
		"STRONGHOLD_B",
		"DEPLOY_B",
	],
	// Row I
	[
		"DEPLOY_A",
		"DEPLOY_A",
		"DEPLOY_A",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"PLAINS",
		"HILLS",
		"PLAINS",
		"PLAINS",
		"FOREST",
		"PLAINS",
		"DEPLOY_B",
		"DEPLOY_B",
		"DEPLOY_B",
	],
];

function buildCanonicalBoard(config: EngineConfig): HexState[] {
	const board: HexState[] = [];
	for (let row = 0; row < ROWS; row++) {
		const rowTerrain = CANONICAL_TERRAIN[row]!;
		for (let col = 0; col < COLS; col++) {
			const token = rowTerrain[col]!;
			const hexType = TOKEN_TO_HEX_TYPE[token];
			const id = toHexId(row, col);

			let controlledBy: PlayerSide | null = null;
			if (hexType === "deploy_a" || hexType === "stronghold_a") {
				controlledBy = "A";
			} else if (hexType === "deploy_b" || hexType === "stronghold_b") {
				controlledBy = "B";
			}

			let reserve: number | undefined;
			if (hexType === "gold_mine") {
				reserve = config.resourceNodes.goldMineReserve;
			} else if (hexType === "lumber_camp") {
				reserve = config.resourceNodes.lumberCampReserve;
			}

			const hex: HexState = {
				id,
				type: hexType,
				controlledBy,
				unitId: null,
			};
			if (reserve !== undefined) {
				hex.reserve = reserve;
			}
			board.push(hex);
		}
	}
	return board;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

function getHex(state: MatchState, id: HexId): HexState | null {
	if (!isValidHexId(id)) return null;
	return state.board[hexIdIndex(id)] ?? null;
}

function setHexUnit(state: MatchState, id: HexId, unitId: string | null) {
	const idx = hexIdIndex(id);
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, unitId };
}

function setHexControl(state: MatchState, id: HexId, owner: PlayerSide | null) {
	const idx = hexIdIndex(id);
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, controlledBy: owner };
}

function getUnit(state: MatchState, unitId: string): Unit | null {
	for (const side of PLAYER_SIDES) {
		const unit = state.players[side].units.find((u) => u.id === unitId);
		if (unit) return unit;
	}
	return null;
}

function addUnit(state: MatchState, unit: Unit) {
	state.players[unit.owner].units.push(unit);
	setHexUnit(state, unit.position, unit.id);
}

function removeUnit(state: MatchState, unitId: string): Unit | null {
	for (const side of PLAYER_SIDES) {
		const idx = state.players[side].units.findIndex((u) => u.id === unitId);
		if (idx >= 0) {
			const [unit] = state.players[side].units.splice(idx, 1);
			if (!unit) return null;
			setHexUnit(state, unit.position, null);
			return unit;
		}
	}
	return null;
}

function moveUnitTo(state: MatchState, unit: Unit, to: HexId, dist: number) {
	setHexUnit(state, unit.position, null);
	unit.position = to;
	unit.movedThisTurn = true;
	unit.movedDistance = dist;
	setHexUnit(state, to, unit.id);
}

function buildOccupiedSet(state: MatchState): Set<HexId> {
	const occupied = new Set<HexId>();
	for (const side of PLAYER_SIDES) {
		for (const unit of state.players[side].units) {
			occupied.add(unit.position);
		}
	}
	return occupied;
}

function otherSide(side: PlayerSide): PlayerSide {
	return side === "A" ? "B" : "A";
}

function nextUnitId(state: MatchState, side: PlayerSide): string {
	const prefix = `${side}-`;
	let max = 0;
	for (const unit of state.players[side].units) {
		if (unit.id.startsWith(prefix)) {
			const value = Number(unit.id.slice(prefix.length));
			if (Number.isFinite(value) && value > max) max = value;
		}
	}
	return `${side}-${max + 1}`;
}

function cloneState(state: MatchState): MatchState {
	return {
		...state,
		players: {
			A: {
				...state.players.A,
				units: state.players.A.units.map((u) => ({ ...u })),
			},
			B: {
				...state.players.B,
				units: state.players.B.units.map((u) => ({ ...u })),
			},
		},
		board: state.board.map((h) => ({ ...h })),
	};
}

function sortUnits(units: Unit[]): Unit[] {
	return [...units].sort((a, b) => a.id.localeCompare(b.id));
}

function sortHexIds(ids: HexId[]): HexId[] {
	return [...ids].sort((a, b) => {
		const pa = parseHexId(a);
		const pb = parseHexId(b);
		return pa.row - pb.row || pa.col - pb.col;
	});
}

// ---------------------------------------------------------------------------
// Start-of-player-turn tick
// ---------------------------------------------------------------------------

type TickResult = {
	goldIncome: number;
	woodIncome: number;
	vpGained: number;
};

function runStartOfPlayerTurnTick(
	state: MatchState,
	side: PlayerSide,
): TickResult {
	const config = resolveConfig();
	const player = state.players[side];

	// 1. Reset flags on active player's units
	for (const unit of player.units) {
		unit.isFortified = false;
		unit.movedThisTurn = false;
		unit.movedDistance = 0;
		unit.attackedThisTurn = false;
		unit.canActThisTurn = true;
		unit.chargeEligible = undefined;
	}

	// 2. Economy tick
	let goldIncome = 0;
	let woodIncome = 0;
	let vpGained = 0;

	for (const hex of state.board) {
		if (hex.controlledBy !== side) continue;

		if (hex.type === "gold_mine") {
			const reserve = hex.reserve ?? 0;
			const tick = Math.min(config.resourceNodes.goldMineTick, reserve);
			goldIncome += tick;
			hex.reserve = reserve - tick;
		} else if (hex.type === "lumber_camp") {
			const reserve = hex.reserve ?? 0;
			const tick = Math.min(config.resourceNodes.lumberCampTick, reserve);
			woodIncome += tick;
			hex.reserve = reserve - tick;
		} else if (hex.type === "stronghold_a" || hex.type === "stronghold_b") {
			goldIncome += config.resourceNodes.strongholdGoldTick;
		} else if (hex.type === "crown") {
			vpGained += config.resourceNodes.crownVpTick;
		}
	}

	player.gold += goldIncome;
	player.wood += woodIncome;
	player.vp += vpGained;

	// 3. Set actions
	state.actionsRemaining = config.actionsPerTurn;

	return { goldIncome, woodIncome, vpGained };
}

// ---------------------------------------------------------------------------
// Line-of-sight for archer range-2
// ---------------------------------------------------------------------------

function computeLoS(
	attackerPos: HexId,
	targetPos: HexId,
	state: MatchState,
): { clear: boolean; reason?: string } {
	const attackerNeighbors = new Set(neighborsOf(attackerPos));
	const targetNeighbors = new Set(neighborsOf(targetPos));

	const shared: HexId[] = [];
	for (const n of attackerNeighbors) {
		if (targetNeighbors.has(n)) shared.push(n);
	}

	if (shared.length !== 1) {
		return { clear: false, reason: "No straight line (shared neighbors != 1)" };
	}

	const midHex = shared[0]!;
	const targetHex = getHex(state, targetPos);
	const midHexState = getHex(state, midHex);

	if (targetHex?.type === "forest") {
		return { clear: false, reason: "Target is in forest" };
	}
	if (midHexState?.type === "forest") {
		return { clear: false, reason: "Mid hex is forest" };
	}

	// Check if mid hex has a unit blocking LoS
	if (midHexState?.unitId) {
		const attackerHex = getHex(state, attackerPos);
		if (attackerHex?.type !== "high_ground") {
			return { clear: false, reason: "Unit blocking LoS on mid hex" };
		}
	}

	return { clear: true };
}

// ---------------------------------------------------------------------------
// Combat resolution
// ---------------------------------------------------------------------------

type CombatResult = {
	attackPower: number;
	defensePower: number;
	attackerSurvives: boolean;
	defenderSurvives: boolean;
	captured: boolean;
	abilities: string[];
};

function computeCombat(
	attacker: Unit,
	defender: Unit,
	state: MatchState,
	dist: number,
): CombatResult {
	const config = resolveConfig();
	const abilities: string[] = [];

	// Attack power
	let attackPower = config.unitStats[attacker.type].attack;

	// Cavalry charge: +2 if cavalry, moved this turn with distance >= 2,
	// and there was a forest-free shortest path
	if (attacker.type === "cavalry" && attacker.chargeEligible) {
		attackPower += config.abilities.cavalryChargeBonus;
		abilities.push("cavalry_charge");
	}

	// Defense power
	const defenderHex = getHex(state, defender.position);
	let defensePower = config.unitStats[defender.type].defense;

	// Terrain bonus
	if (defenderHex) {
		defensePower += config.terrainDefenseBonus[defenderHex.type];
	}

	// Fortify bonus
	if (defender.isFortified) {
		defensePower += config.abilities.fortifyBonus;
		abilities.push("fortify");
	}

	// Shield Wall: infantry +1 per adjacent friendly infantry, max +2
	if (defender.type === "infantry") {
		const adjacentIds = neighborsOf(defender.position);
		let shieldWallBonus = 0;
		for (const adjId of adjacentIds) {
			const adjHex = getHex(state, adjId);
			if (adjHex?.unitId) {
				const adjUnit = getUnit(state, adjHex.unitId);
				if (
					adjUnit &&
					adjUnit.owner === defender.owner &&
					adjUnit.type === "infantry" &&
					adjUnit.id !== defender.id
				) {
					shieldWallBonus++;
				}
			}
		}
		shieldWallBonus = Math.min(
			shieldWallBonus,
			config.abilities.infantryAdjacencyBonusCap,
		);
		if (shieldWallBonus > 0) {
			defensePower += shieldWallBonus;
			abilities.push(`shield_wall_+${shieldWallBonus}`);
		}
	}

	// Archer melee vulnerability: -1 DEF at distance 1 (floor 0)
	if (defender.type === "archer" && dist === 1) {
		defensePower = Math.max(
			0,
			defensePower - config.abilities.archerMeleeVulnerability,
		);
		abilities.push("archer_melee_vulnerability");
	}

	// Resolve
	const ranged = dist > 1;
	let attackerSurvives = true;
	let defenderSurvives = true;
	let captured = false;

	if (attackPower > defensePower) {
		defenderSurvives = false;
		if (!ranged) captured = true;
	} else if (attackPower === defensePower) {
		attackerSurvives = false;
		defenderSurvives = false;
	} else {
		attackerSurvives = false;
	}

	return {
		attackPower,
		defensePower,
		attackerSurvives,
		defenderSurvives,
		captured,
		abilities,
	};
}

// ---------------------------------------------------------------------------
// Victory conditions
// ---------------------------------------------------------------------------

function computeImmediateTerminal(state: MatchState): TerminalState {
	// Stronghold capture: check after control update
	// A wins if both B20 and H20 are controlled by A
	const [bStronghold1, bStronghold2] = STRONGHOLD_HEXES.B;
	const bS1 = getHex(state, bStronghold1);
	const bS2 = getHex(state, bStronghold2);
	if (bS1?.controlledBy === "A" && bS2?.controlledBy === "A") {
		return {
			ended: true,
			winner: state.players.A.id,
			reason: "stronghold_capture",
		};
	}

	// B wins if both B2 and H2 are controlled by B
	const [aStronghold1, aStronghold2] = STRONGHOLD_HEXES.A;
	const aS1 = getHex(state, aStronghold1);
	const aS2 = getHex(state, aStronghold2);
	if (aS1?.controlledBy === "B" && aS2?.controlledBy === "B") {
		return {
			ended: true,
			winner: state.players.B.id,
			reason: "stronghold_capture",
		};
	}

	// Elimination
	const aUnits = state.players.A.units.length;
	const bUnits = state.players.B.units.length;
	if (aUnits === 0 && bUnits === 0) {
		return { ended: true, winner: null, reason: "draw" };
	}
	if (aUnits === 0) {
		return { ended: true, winner: state.players.B.id, reason: "elimination" };
	}
	if (bUnits === 0) {
		return { ended: true, winner: state.players.A.id, reason: "elimination" };
	}

	return { ended: false };
}

function computeTurnLimitTerminal(state: MatchState): TerminalState {
	const config = resolveConfig();
	if (state.turn <= config.turnLimit) return { ended: false };

	// Timeout tiebreakers: VP > unit value > hex count > draw
	const vpA = state.players.A.vp;
	const vpB = state.players.B.vp;
	if (vpA !== vpB) {
		return {
			ended: true,
			winner: vpA > vpB ? state.players.A.id : state.players.B.id,
			reason: "turn_limit",
		};
	}

	const unitValueA = unitValue(state, "A");
	const unitValueB = unitValue(state, "B");
	if (unitValueA !== unitValueB) {
		return {
			ended: true,
			winner: unitValueA > unitValueB ? state.players.A.id : state.players.B.id,
			reason: "turn_limit",
		};
	}

	const hexCountA = controlledHexCount(state, "A");
	const hexCountB = controlledHexCount(state, "B");
	if (hexCountA !== hexCountB) {
		return {
			ended: true,
			winner: hexCountA > hexCountB ? state.players.A.id : state.players.B.id,
			reason: "turn_limit",
		};
	}

	return { ended: true, winner: null, reason: "draw" };
}

function computeTerminal(state: MatchState): TerminalState {
	const immediate = computeImmediateTerminal(state);
	if (immediate.ended) return immediate;
	return computeTurnLimitTerminal(state);
}

function unitValue(state: MatchState, side: PlayerSide): number {
	const config = resolveConfig();
	let total = 0;
	for (const unit of state.players[side].units) {
		total += config.unitStats[unit.type].cost;
	}
	return total;
}

function controlledHexCount(state: MatchState, side: PlayerSide): number {
	let count = 0;
	for (const hex of state.board) {
		if (hex.controlledBy === side) count++;
	}
	return count;
}

// ---------------------------------------------------------------------------
// Control update (end-of-player-turn)
// ---------------------------------------------------------------------------

function applyControlUpdate(
	state: MatchState,
): { hex: HexId; from: PlayerSide | null; to: PlayerSide | null }[] {
	const changes: {
		hex: HexId;
		from: PlayerSide | null;
		to: PlayerSide | null;
	}[] = [];
	for (const hex of state.board) {
		if (hex.unitId) {
			const unit = getUnit(state, hex.unitId);
			const nextOwner = unit ? unit.owner : hex.controlledBy;
			if (nextOwner !== hex.controlledBy) {
				changes.push({
					hex: hex.id,
					from: hex.controlledBy,
					to: nextOwner,
				});
				hex.controlledBy = nextOwner;
			}
		}
	}
	return changes.sort((a, b) => a.hex.localeCompare(b.hex));
}

// ---------------------------------------------------------------------------
// Public API: createInitialState
// ---------------------------------------------------------------------------

export function createInitialState(
	seed = 0,
	configInput?: EngineConfigInput,
	playersInput?: AgentId[],
): MatchState {
	const players = playersInput ?? ["player-1", "player-2"];
	if (players.length !== 2) {
		throw new Error("Engine requires exactly two players.");
	}
	const [playerA, playerB] = players as [AgentId, AgentId];
	const config = mergeConfig(configInput);
	_activeConfig = config;

	const board = buildCanonicalBoard(config);

	const state: MatchState = {
		seed,
		turn: 1,
		activePlayer: "A",
		actionsRemaining: config.actionsPerTurn,
		players: {
			A: {
				id: playerA,
				gold: 0,
				wood: 0,
				vp: 0,
				units: [],
			},
			B: {
				id: playerB,
				gold: 0,
				wood: 0,
				vp: 0,
				units: [],
			},
		},
		board,
		status: "active",
	};

	// Place starting units (spec Section 6.3)
	const startingUnits: Array<{
		id: string;
		type: UnitType;
		owner: PlayerSide;
		position: HexId;
	}> = [
		{ id: "A-1", type: "infantry", owner: "A", position: "B2" },
		{ id: "A-2", type: "infantry", owner: "A", position: "H2" },
		{ id: "A-3", type: "infantry", owner: "A", position: "G2" },
		{ id: "A-4", type: "cavalry", owner: "A", position: "B3" },
		{ id: "A-5", type: "cavalry", owner: "A", position: "H3" },
		{ id: "A-6", type: "archer", owner: "A", position: "C2" },
		{ id: "B-1", type: "infantry", owner: "B", position: "B20" },
		{ id: "B-2", type: "infantry", owner: "B", position: "H20" },
		{ id: "B-3", type: "infantry", owner: "B", position: "G20" },
		{ id: "B-4", type: "cavalry", owner: "B", position: "B19" },
		{ id: "B-5", type: "cavalry", owner: "B", position: "H19" },
		{ id: "B-6", type: "archer", owner: "B", position: "C20" },
	];

	for (const def of startingUnits) {
		const unit: Unit = {
			id: def.id,
			type: def.type,
			owner: def.owner,
			position: def.position,
			isFortified: false,
			movedThisTurn: false,
			movedDistance: 0,
			attackedThisTurn: false,
			canActThisTurn: true,
		};
		addUnit(state, unit);
	}

	// Run Player A's start-of-turn tick eagerly (so initial state includes Turn 1 income)
	runStartOfPlayerTurnTick(state, "A");

	return state;
}

export function initialState(seed: number, players: AgentId[]): MatchState {
	return createInitialState(seed, undefined, players);
}

// ---------------------------------------------------------------------------
// Public API: query functions
// ---------------------------------------------------------------------------

export function currentPlayer(state: MatchState): AgentId {
	return state.players[state.activePlayer].id;
}

export function isTerminal(state: MatchState): TerminalState {
	return computeTerminal(state);
}

export function winner(state: MatchState): AgentId | null {
	const terminal = computeTerminal(state);
	return terminal.ended ? terminal.winner : null;
}

export function listLegalMoves(state: MatchState): Move[] {
	if (state.status === "ended") return [];
	const config = resolveConfig();
	const side = state.activePlayer;
	const player = state.players[side];
	const moves: Move[] = [];

	const canAct = state.actionsRemaining > 0;

	if (canAct) {
		// Recruit at own strongholds
		const strongholds = STRONGHOLD_HEXES[side];
		for (const shId of strongholds) {
			const hex = getHex(state, shId);
			if (hex && hex.controlledBy === side && hex.unitId == null) {
				for (const unitType of [
					"infantry",
					"cavalry",
					"archer",
				] as UnitType[]) {
					const cost = config.unitStats[unitType].cost;
					if (player.gold >= cost) {
						moves.push({ action: "recruit", unitType, at: shId });
					}
				}
			}
		}

		const occupied = buildOccupiedSet(state);

		// Move
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.movedThisTurn) continue;
			const movementRange = config.unitStats[unit.type].movement;
			const blocked = new Set(occupied);
			blocked.delete(unit.position);
			const reachable = reachableHexes(unit.position, movementRange, blocked);
			for (const hexId of sortHexIds(reachable)) {
				moves.push({ action: "move", unitId: unit.id, to: hexId });
			}
		}

		// Attack
		const enemyUnits = state.players[otherSide(side)].units;
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.attackedThisTurn) continue;
			const range = config.unitStats[unit.type].range;
			const targets: HexId[] = [];
			for (const enemy of enemyUnits) {
				const dist = hexDistance(unit.position, enemy.position);
				if (dist !== null && dist >= 1 && dist <= range) {
					// Check LoS for range-2 attacks
					if (dist === 2) {
						const los = computeLoS(unit.position, enemy.position, state);
						if (!los.clear) continue;
					}
					targets.push(enemy.position);
				}
			}
			for (const hexId of sortHexIds(targets)) {
				moves.push({ action: "attack", unitId: unit.id, target: hexId });
			}
		}

		// Fortify
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.movedThisTurn || unit.attackedThisTurn) continue;
			if (unit.isFortified) continue;
			if (player.wood < 1) continue;
			moves.push({ action: "fortify", unitId: unit.id });
		}
	}

	// end_turn is always available
	moves.push({ action: "end_turn" });
	return moves;
}

// ---------------------------------------------------------------------------
// Public API: validateMove
// ---------------------------------------------------------------------------

export function validateMove(
	state: MatchState,
	move: Move,
):
	| { ok: true; move: Move }
	| { ok: false; reason: MoveRejectionReason; error: string } {
	if (state.status === "ended" || computeTerminal(state).ended) {
		return { ok: false, reason: "terminal", error: "Match already ended." };
	}

	const parsed = MoveSchema.safeParse(move);
	if (!parsed.success) {
		return {
			ok: false,
			reason: "invalid_move_schema",
			error: "Invalid move schema.",
		};
	}

	const config = resolveConfig();
	const m = parsed.data;
	const side = state.activePlayer;
	const player = state.players[side];

	// end_turn and pass don't cost AP
	if (m.action === "end_turn" || m.action === "pass") {
		return { ok: true, move: m };
	}

	if (state.actionsRemaining <= 0) {
		return {
			ok: false,
			reason: "illegal_move",
			error: "No actions remaining.",
		};
	}

	switch (m.action) {
		case "recruit": {
			const hex = getHex(state, m.at);
			if (!hex) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Invalid hex.",
				};
			}
			// Must be a stronghold
			if (hex.type !== "stronghold_a" && hex.type !== "stronghold_b") {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Can only recruit at strongholds.",
				};
			}
			if (hex.controlledBy !== side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Stronghold not controlled by player.",
				};
			}
			if (hex.unitId != null) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Stronghold is occupied.",
				};
			}
			const cost = config.unitStats[m.unitType].cost;
			if (player.gold < cost) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Not enough gold.",
				};
			}
			return { ok: true, move: m };
		}
		case "move": {
			const unit = getUnit(state, m.unitId);
			if (!unit || unit.owner !== side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit not owned by player.",
				};
			}
			if (!unit.canActThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit cannot act this turn.",
				};
			}
			if (unit.movedThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit already moved this turn.",
				};
			}
			if (!isValidHexId(m.to)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.to);
			if (!targetHex || targetHex.unitId != null) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target occupied.",
				};
			}
			const occupied = buildOccupiedSet(state);
			occupied.delete(unit.position);
			const dist = pathDistance(unit.position, m.to, occupied);
			if (dist == null || dist > config.unitStats[unit.type].movement) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of range.",
				};
			}
			return { ok: true, move: m };
		}
		case "attack": {
			const unit = getUnit(state, m.unitId);
			if (!unit || unit.owner !== side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit not owned by player.",
				};
			}
			if (!unit.canActThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit cannot act this turn.",
				};
			}
			if (unit.attackedThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit already attacked this turn.",
				};
			}
			if (!isValidHexId(m.target)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.target);
			if (!targetHex || !targetHex.unitId) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "No target unit.",
				};
			}
			const targetUnit = getUnit(state, targetHex.unitId);
			if (!targetUnit || targetUnit.owner === side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target must be enemy.",
				};
			}
			const dist = hexDistance(unit.position, m.target);
			if (dist == null || dist > config.unitStats[unit.type].range) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of range.",
				};
			}
			// Archer range-2 LoS check
			if (dist === 2) {
				const los = computeLoS(unit.position, m.target, state);
				if (!los.clear) {
					return {
						ok: false,
						reason: "illegal_move",
						error: `Line of sight blocked: ${los.reason}`,
					};
				}
			}
			return { ok: true, move: m };
		}
		case "fortify": {
			const unit = getUnit(state, m.unitId);
			if (!unit || unit.owner !== side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit not owned by player.",
				};
			}
			if (!unit.canActThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit cannot act this turn.",
				};
			}
			if (unit.movedThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit has already moved.",
				};
			}
			if (unit.attackedThisTurn) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit has already attacked.",
				};
			}
			if (unit.isFortified) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit is already fortified.",
				};
			}
			if (player.wood < 1) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Not enough wood.",
				};
			}
			return { ok: true, move: m };
		}
	}
}

// ---------------------------------------------------------------------------
// Public API: applyMove
// ---------------------------------------------------------------------------

export function applyMove(state: MatchState, move: Move): ApplyMoveResult {
	const validation = validateMove(state, move);
	if (!validation.ok) {
		return {
			ok: false,
			state,
			engineEvents: [
				{
					type: "reject",
					turn: state.turn,
					player: state.activePlayer,
					move,
					reason: validation.reason,
				},
			],
			reason: validation.reason,
			error: validation.error,
		};
	}

	const m = validation.move;
	const config = resolveConfig();
	const nextState = cloneState(state);
	const side = nextState.activePlayer;
	const player = nextState.players[side];
	const engineEvents: EngineEvent[] = [];

	switch (m.action) {
		case "recruit": {
			if (m.action !== "recruit") break; // narrowing
			const unitId = nextUnitId(nextState, side);
			const unit: Unit = {
				id: unitId,
				type: m.unitType,
				owner: side,
				position: m.at,
				isFortified: false,
				movedThisTurn: false,
				movedDistance: 0,
				attackedThisTurn: false,
				canActThisTurn: false, // cannot act until next start-of-turn
			};
			player.gold -= config.unitStats[m.unitType].cost;
			addUnit(nextState, unit);
			engineEvents.push({
				type: "recruit",
				turn: nextState.turn,
				player: side,
				unitId,
				unitType: m.unitType,
				at: m.at,
			});
			break;
		}
		case "move": {
			const unit = getUnit(nextState, m.unitId);
			if (!unit) {
				return failMove(nextState, m, "invalid_move", "Unit not found.");
			}
			const occupied = buildOccupiedSet(nextState);
			occupied.delete(unit.position);
			const dist = pathDistance(unit.position, m.to, occupied);
			if (dist == null) {
				return failMove(nextState, m, "invalid_move", "Move path not found.");
			}
			const from = unit.position;

			// Check cavalry charge eligibility before moving
			let chargeEligible = false;
			if (unit.type === "cavalry" && dist >= 2) {
				chargeEligible = hasForestFreePath(
					from,
					m.to,
					dist,
					occupied,
					nextState.board,
				);
			}

			moveUnitTo(nextState, unit, m.to, dist);
			unit.chargeEligible = chargeEligible || undefined;

			engineEvents.push({
				type: "move_unit",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				from,
				to: m.to,
			});
			break;
		}
		case "attack": {
			const attacker = getUnit(nextState, m.unitId);
			if (!attacker) {
				return failMove(nextState, m, "invalid_move", "Attacker not found.");
			}
			const targetHex = getHex(nextState, m.target);
			if (!targetHex || !targetHex.unitId) {
				return failMove(nextState, m, "invalid_move", "Target missing.");
			}
			const defender = getUnit(nextState, targetHex.unitId);
			if (!defender) {
				return failMove(nextState, m, "invalid_move", "Defender missing.");
			}

			const attackerFrom = attacker.position;
			const defenderId = defender.id;
			const dist = hexDistance(attacker.position, defender.position) ?? 0;

			const combat = computeCombat(attacker, defender, nextState, dist);

			if (!combat.defenderSurvives) {
				removeUnit(nextState, defender.id);
			}
			if (!combat.attackerSurvives) {
				removeUnit(nextState, attacker.id);
			}

			// Tie: neutralize defender hex
			if (!combat.attackerSurvives && !combat.defenderSurvives) {
				setHexControl(nextState, defender.position, null);
			}

			// Melee capture: attacker moves into defender hex
			if (combat.attackerSurvives && combat.captured) {
				moveUnitTo(nextState, attacker, defender.position, dist);
			}

			// Mark attacker as having attacked
			if (combat.attackerSurvives) {
				attacker.attackedThisTurn = true;
			}

			engineEvents.push({
				type: "attack",
				turn: nextState.turn,
				player: side,
				attackerId: attacker.id,
				attackerFrom,
				defenderId,
				targetHex: m.target,
				distance: dist,
				ranged: dist > 1,
				attackPower: combat.attackPower,
				defensePower: combat.defensePower,
				abilities: combat.abilities,
				outcome: {
					attacker: combat.attackerSurvives ? "survives" : "dies",
					defender: combat.defenderSurvives ? "survives" : "dies",
					captured: combat.captured,
				},
			});
			break;
		}
		case "fortify": {
			const unit = getUnit(nextState, m.unitId);
			if (!unit) {
				return failMove(nextState, m, "invalid_move", "Unit not found.");
			}
			player.wood -= 1;
			unit.isFortified = true;
			unit.canActThisTurn = false; // fortify consumes the unit's action budget
			engineEvents.push({
				type: "fortify",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				at: unit.position,
			});
			break;
		}
		case "end_turn":
		case "pass":
			break;
	}

	// AP handling
	if (m.action === "end_turn" || m.action === "pass") {
		nextState.actionsRemaining = 0;
	} else {
		nextState.actionsRemaining = Math.max(0, nextState.actionsRemaining - 1);
	}

	// Check immediate terminal (elimination)
	const immediateTerminal = computeImmediateTerminal(nextState);
	if (immediateTerminal.ended) {
		nextState.status = "ended";
		engineEvents.push({
			type: "game_end",
			turn: nextState.turn,
			winner: immediateTerminal.winner,
			reason: immediateTerminal.reason,
		});
		return { ok: true, state: nextState, engineEvents };
	}

	// End-of-player-turn handling
	const turnEnded =
		m.action === "end_turn" ||
		m.action === "pass" ||
		nextState.actionsRemaining <= 0;

	if (turnEnded) {
		// 1. Control update
		const controlChanges = applyControlUpdate(nextState);
		if (controlChanges.length > 0) {
			engineEvents.push({
				type: "control_update",
				turn: nextState.turn,
				changes: controlChanges,
			});
		}

		engineEvents.push({
			type: "turn_end",
			turn: nextState.turn,
			player: side,
		});

		// 2. Check stronghold capture victory after control update
		const captureTerminal = computeImmediateTerminal(nextState);
		if (captureTerminal.ended) {
			nextState.status = "ended";
			engineEvents.push({
				type: "game_end",
				turn: nextState.turn,
				winner: captureTerminal.winner,
				reason: captureTerminal.reason,
			});
			return { ok: true, state: nextState, engineEvents };
		}

		// 3. Switch active player
		const nextSide = otherSide(side);
		nextState.activePlayer = nextSide;

		// Turn increments only after Player B ends
		if (side === "B") {
			nextState.turn += 1;
		}

		// 4. Check turn limit
		const limitTerminal = computeTurnLimitTerminal(nextState);
		if (limitTerminal.ended) {
			nextState.status = "ended";
			engineEvents.push({
				type: "game_end",
				turn: nextState.turn,
				winner: limitTerminal.winner,
				reason: limitTerminal.reason,
			});
			return { ok: true, state: nextState, engineEvents };
		}

		// 5. Run next player's start-of-turn tick
		const tick = runStartOfPlayerTurnTick(nextState, nextSide);
		engineEvents.push({
			type: "turn_start",
			turn: nextState.turn,
			player: nextSide,
			actions: nextState.actionsRemaining,
			goldIncome: tick.goldIncome,
			woodIncome: tick.woodIncome,
			vpGained: tick.vpGained,
			goldAfter: nextState.players[nextSide].gold,
			woodAfter: nextState.players[nextSide].wood,
			vpAfter: nextState.players[nextSide].vp,
		});
	}

	return { ok: true, state: nextState, engineEvents };
}

// ---------------------------------------------------------------------------
// Render ASCII
// ---------------------------------------------------------------------------

export function renderAscii(state: MatchState): string {
	const lines: string[] = [];

	// Header row with column numbers
	const headerCells: string[] = [];
	for (let col = 0; col < COLS; col++) {
		headerCells.push(String(col + 1).padStart(4));
	}
	lines.push(`    ${headerCells.join("")}`);

	for (let row = 0; row < ROWS; row++) {
		const rowLabel = ROW_LETTERS[row]!;
		const cells: string[] = [];
		for (let col = 0; col < COLS; col++) {
			const id = toHexId(row, col);
			const hex = getHex(state, id);
			if (!hex) {
				cells.push(" ?? ");
				continue;
			}
			const unit = hex.unitId ? getUnit(state, hex.unitId) : null;
			const owner = unit?.owner ?? hex.controlledBy ?? ".";
			const content = unit
				? unit.type === "infantry"
					? "i"
					: unit.type === "cavalry"
						? "c"
						: "a"
				: terrainChar(hex.type);
			cells.push(` ${owner}${content} `);
		}
		lines.push(`${rowLabel}  ${cells.join("")}`);
	}

	lines.push("");
	lines.push("Legend: A/B=control, i=infantry, c=cavalry, a=archer");
	lines.push(
		"  S=stronghold, G=gold, L=lumber, C=crown, H=high_ground, F=forest, h=hills, D=deploy",
	);
	return lines.join("\n");
}

function terrainChar(type: HexType): string {
	switch (type) {
		case "plains":
			return ".";
		case "forest":
			return "F";
		case "hills":
			return "h";
		case "high_ground":
			return "H";
		case "gold_mine":
			return "G";
		case "lumber_camp":
			return "L";
		case "crown":
			return "C";
		case "stronghold_a":
		case "stronghold_b":
			return "S";
		case "deploy_a":
		case "deploy_b":
			return "D";
	}
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function failMove(
	state: MatchState,
	move: Move,
	reason: MoveRejectionReason,
	error: string,
): ApplyMoveResult {
	return {
		ok: false,
		state,
		engineEvents: [
			{
				type: "reject",
				turn: state.turn,
				player: state.activePlayer,
				move,
				reason,
			},
		],
		reason,
		error,
	};
}

// ---------------------------------------------------------------------------
// Spectator/SSE schema (envelope unchanged, payload types updated)
// ---------------------------------------------------------------------------

export const SpectatorEventSchema = z.discriminatedUnion("event", [
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("match_found"),
		matchId: z.string(),
		opponentId: z.string().optional(),
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("your_turn"),
		matchId: z.string(),
		stateVersion: z.number().int().optional(),
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("state"),
		matchId: z.string(),
		state: MatchStateSchema,
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("engine_events"),
		matchId: z.string(),
		stateVersion: z.number().int(),
		agentId: z.string(),
		moveId: z.string(),
		move: MoveSchema,
		engineEvents: z.array(z.unknown()),
		ts: z.string(),
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("game_ended"),
		matchId: z.string(),
		winnerAgentId: z.string().nullable().optional(),
		loserAgentId: z.string().nullable().optional(),
		reason: z.string().optional(),
		reasonCode: z.string().optional(),
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("error"),
		error: z.string(),
	}),
	z.object({
		eventVersion: z.literal(1),
		event: z.literal("no_events"),
	}),
]);

export const EventSchema = SpectatorEventSchema;
export type SpectatorEvent = z.infer<typeof SpectatorEventSchema>;
