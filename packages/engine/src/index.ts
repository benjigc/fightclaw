import { z } from "zod";

// War of Attrition v2 — 9-row hex grid, HexId coords, resource reserves, abilities

export type AgentId = string;
export type PlayerSide = "A" | "B";
export type HexId = string; // "A1".."I17" or "A1".."I21"
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
export type BaseUnitType = "infantry" | "cavalry" | "archer";
export type Tier2UnitType = "swordsman" | "knight" | "crossbow";
export type UnitType = BaseUnitType | Tier2UnitType;

export type Move =
	| { action: "move"; unitId: string; to: HexId; reasoning?: string }
	| { action: "attack"; unitId: string; target: HexId; reasoning?: string }
	| {
			action: "recruit";
			unitType: BaseUnitType;
			at: HexId;
			reasoning?: string;
	  }
	| { action: "fortify"; unitId: string; reasoning?: string }
	| { action: "upgrade"; unitId: string; reasoning?: string }
	| { action: "end_turn"; reasoning?: string }
	| { action: "pass"; reasoning?: string };

export type Unit = {
	id: string;
	type: UnitType;
	owner: PlayerSide;
	position: HexId;
	hp: number;
	maxHp: number;
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
	unitIds: string[];
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
			unitType: BaseUnitType;
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
			type: "upgrade";
			turn: number;
			player: PlayerSide;
			unitId: string;
			fromType: BaseUnitType;
			toType: Tier2UnitType;
			at: HexId;
	  }
	| {
			type: "attack";
			turn: number;
			player: PlayerSide;
			attackerId: string;
			attackerFrom: HexId;
			defenderIds: string[];
			targetHex: HexId;
			distance: number;
			ranged: boolean;
			attackPower: number;
			defensePower: number;
			abilities: string[];
			outcome: {
				attackerSurvivors: string[];
				attackerCasualties: string[];
				defenderSurvivors: string[];
				defenderCasualties: string[];
				damageDealt: number;
				damageTaken: number;
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
const ACTIONS_PER_TURN = 7;
const TURN_LIMIT = 40;
const FORTIFY_WOOD_COST = 2;
const PLAYER_SIDES: PlayerSide[] = ["A", "B"];

const ROW_LETTERS = "ABCDEFGHI";

const BOARD_17_CANONICAL_COL_MAP = [
	0, 1, 2, 3, 4, 5, 6, 7, 10, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

function inferBoardColumnsFromBoard(board: HexState[]): 17 | 21 {
	if (board.length % ROWS !== 0) {
		throw new Error(
			`Invalid board length=${board.length}; expected multiple of ROWS=${ROWS}`,
		);
	}
	const inferred = board.length / ROWS;
	if (inferred !== 17 && inferred !== 21) {
		throw new Error(
			`Invalid inferred board columns=${inferred} from board length=${board.length}`,
		);
	}
	return inferred;
}

// ---------------------------------------------------------------------------
// HexId coordinate helpers
// ---------------------------------------------------------------------------

export function parseHexId(id: HexId): { row: number; col: number } {
	const rowChar = id[0];
	if (!rowChar) {
		throw new Error(`Invalid hex id: ${id}`);
	}
	const colStr = id.slice(1);
	return {
		row: rowChar.charCodeAt(0) - 65,
		col: Number(colStr) - 1,
	};
}

export function toHexId(row: number, col: number): HexId {
	return `${ROW_LETTERS[row]}${col + 1}`;
}

function hexIdIndex(id: HexId, boardColumns: 17 | 21): number {
	const { row, col } = parseHexId(id);
	return row * boardColumns + col;
}

function isValidHexId(s: string, boardColumns: 17 | 21): boolean {
	if (s.length < 2 || s.length > 3) return false;
	const rowChar = s[0];
	if (!rowChar) return false;
	const rowIdx = rowChar.charCodeAt(0) - 65;
	if (rowIdx < 0 || rowIdx >= ROWS) return false;
	const colNum = Number(s.slice(1));
	if (!Number.isInteger(colNum) || colNum < 1 || colNum > boardColumns) {
		return false;
	}
	return true;
}

export function neighborsOf(id: HexId, boardColumns: 17 | 21 = 17): HexId[] {
	const { row, col } = parseHexId(id);
	return neighbors(row, col, boardColumns);
}

function neighbors(row: number, col: number, boardColumns: 17 | 21): HexId[] {
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
		if (nr >= 0 && nr < ROWS && nc >= 0 && nc < boardColumns) {
			result.push(toHexId(nr, nc));
		}
	}
	return result;
}

function hexDistance(a: HexId, b: HexId, boardColumns: 17 | 21): number | null {
	return bfsDistance(a, b, undefined, boardColumns);
}

function bfsDistance(
	start: HexId,
	target: HexId,
	blocked?: Set<HexId>,
	boardColumns: 17 | 21 = 17,
): number | null {
	if (
		!isValidHexId(start, boardColumns) ||
		!isValidHexId(target, boardColumns)
	) {
		return null;
	}
	if (start === target) return 0;

	const queue: Array<{ id: HexId; dist: number }> = [{ id: start, dist: 0 }];
	const seen = new Set<HexId>([start]);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		for (const n of neighborsOf(current.id, boardColumns)) {
			if (seen.has(n)) continue;
			if (blocked?.has(n)) continue;
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
	boardColumns: 17 | 21,
): number | null {
	return bfsDistance(start, target, blocked, boardColumns);
}

function reachableHexes(
	start: HexId,
	range: number,
	blocked: Set<HexId>,
	boardColumns: 17 | 21,
): HexId[] {
	const results: HexId[] = [];
	const queue: Array<{ id: HexId; dist: number }> = [{ id: start, dist: 0 }];
	const seen = new Set<HexId>([start]);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		for (const n of neighborsOf(current.id, boardColumns)) {
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
	boardColumns: 17 | 21,
): boolean {
	if (pathLen <= 1) return true; // adjacent, no intermediate hexes

	// BFS tracking all shortest paths
	const queue: Array<{ id: HexId; dist: number; forestFree: boolean }> = [
		{ id: start, dist: 0, forestFree: true },
	];
	const bestDist = new Map<HexId, number>();
	bestDist.set(start, 0);

	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) continue;
		if (current.dist >= pathLen) continue;

		for (const n of neighborsOf(current.id, boardColumns)) {
			if (blocked.has(n) && n !== target) continue;
			const nextDist = current.dist + 1;
			if (nextDist > pathLen) continue;

			if (n === target && nextDist === pathLen) {
				if (current.forestFree) return true;
				continue;
			}

			const prev = bestDist.get(n);
			if (prev !== undefined && prev < nextDist) continue;

			const hex = board[hexIdIndex(n, boardColumns)];
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

export const UnitTypeSchema = z.enum([
	"infantry",
	"cavalry",
	"archer",
	"swordsman",
	"knight",
	"crossbow",
]);
export const BaseUnitTypeSchema = z.enum(["infantry", "cavalry", "archer"]);

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
			unitType: BaseUnitTypeSchema,
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
			action: z.literal("upgrade"),
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

const UnitSchema = z.object({
	id: z.string(),
	type: UnitTypeSchema,
	owner: z.enum(["A", "B"]),
	position: HexIdSchema,
	hp: z.number().int(),
	maxHp: z.number().int(),
	isFortified: z.boolean(),
	movedThisTurn: z.boolean(),
	movedDistance: z.number(),
	attackedThisTurn: z.boolean(),
	canActThisTurn: z.boolean(),
});

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
			units: z.array(UnitSchema),
		}),
		B: z.object({
			id: z.string(),
			gold: z.number(),
			wood: z.number(),
			vp: z.number(),
			units: z.array(UnitSchema),
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
			unitIds: z.array(z.string()),
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
	boardColumns: 17 | 21;
	startingGold: number;
	startingWood: number;
	unitStats: {
		infantry: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
		cavalry: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
		archer: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
		swordsman: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
		knight: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
		crossbow: {
			cost: number;
			attack: number;
			defense: number;
			movement: number;
			range: number;
			hp: number;
		};
	};
	upgradeCosts: Record<BaseUnitType, { gold: number; wood: number }>;
	terrainDefenseBonus: Record<HexType, number>;
	fortifyDefenseBonusByTerrain: Partial<Record<HexType, number>>;
	abilities: {
		cavalryChargeBonus: number;
		infantryAdjacencyBonusCap: number;
		archerMeleeVulnerability: number;
		fortifyBonus: number;
		attackerBonus: number;
		stackAttackBonus: number;
		maxStackSize: number;
		vpPerKill: number;
	};
	resourceNodes: {
		goldMineReserve: number;
		goldMineTick: number;
		lumberCampReserve: number;
		lumberCampTick: number;
		strongholdGoldTick: number;
		crownVpTick: number;
		economicNodeControlThreshold: number;
		economicNodeBonusGold: number;
		economicNodeBonusWood: number;
		comebackVpDeficitThreshold: number;
		comebackUnitDeficitThreshold: number;
		comebackHexDeficitThreshold: number;
		comebackGoldBonus: number;
		comebackWoodBonus: number;
	};
};

type DeepPartial<T> = {
	[K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type EngineConfigInput = DeepPartial<EngineConfig>;

export const DEFAULT_CONFIG: EngineConfig = {
	actionsPerTurn: ACTIONS_PER_TURN,
	turnLimit: TURN_LIMIT,
	boardColumns: 17,
	startingGold: 15,
	startingWood: 5,
	unitStats: {
		infantry: {
			cost: 10,
			attack: 2,
			defense: 4,
			movement: 2,
			range: 1,
			hp: 3,
		},
		cavalry: {
			cost: 18,
			attack: 4,
			defense: 2,
			movement: 4,
			range: 1,
			hp: 2,
		},
		archer: {
			cost: 14,
			attack: 3,
			defense: 1,
			movement: 3,
			range: 2,
			hp: 2,
		},
		swordsman: {
			cost: 20,
			attack: 3,
			defense: 3,
			movement: 2,
			range: 1,
			hp: 4,
		},
		knight: {
			cost: 30,
			attack: 5,
			defense: 5,
			movement: 4,
			range: 1,
			hp: 5,
		},
		crossbow: {
			cost: 24,
			attack: 4,
			defense: 2,
			movement: 3,
			range: 2,
			hp: 3,
		},
	},
	upgradeCosts: {
		infantry: { gold: 9, wood: 3 },
		cavalry: { gold: 15, wood: 5 },
		archer: { gold: 12, wood: 4 },
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
		stronghold_a: 1,
		stronghold_b: 1,
	},
	fortifyDefenseBonusByTerrain: {
		forest: 1,
		hills: 1,
		high_ground: 1,
		stronghold_a: 1,
		stronghold_b: 1,
	},
	abilities: {
		cavalryChargeBonus: 2,
		infantryAdjacencyBonusCap: 1,
		archerMeleeVulnerability: 1,
		fortifyBonus: 1,
		attackerBonus: 2,
		stackAttackBonus: 1,
		maxStackSize: 5,
		vpPerKill: 1,
	},
	resourceNodes: {
		goldMineReserve: 20,
		goldMineTick: 3,
		lumberCampReserve: 15,
		lumberCampTick: 2,
		strongholdGoldTick: 2,
		crownVpTick: 1,
		economicNodeControlThreshold: 2,
		economicNodeBonusGold: 1,
		economicNodeBonusWood: 1,
		comebackVpDeficitThreshold: 2,
		comebackUnitDeficitThreshold: 2,
		comebackHexDeficitThreshold: 6,
		comebackGoldBonus: 2,
		comebackWoodBonus: 1,
	},
};

function mergeConfig(input?: EngineConfigInput): EngineConfig {
	if (!input) return DEFAULT_CONFIG;
	return {
		...DEFAULT_CONFIG,
		...input,
		unitStats: {
			infantry: {
				...DEFAULT_CONFIG.unitStats.infantry,
				...input.unitStats?.infantry,
			},
			cavalry: {
				...DEFAULT_CONFIG.unitStats.cavalry,
				...input.unitStats?.cavalry,
			},
			archer: {
				...DEFAULT_CONFIG.unitStats.archer,
				...input.unitStats?.archer,
			},
			swordsman: {
				...DEFAULT_CONFIG.unitStats.swordsman,
				...input.unitStats?.swordsman,
			},
			knight: {
				...DEFAULT_CONFIG.unitStats.knight,
				...input.unitStats?.knight,
			},
			crossbow: {
				...DEFAULT_CONFIG.unitStats.crossbow,
				...input.unitStats?.crossbow,
			},
		},
		upgradeCosts: {
			infantry: {
				...DEFAULT_CONFIG.upgradeCosts.infantry,
				...input.upgradeCosts?.infantry,
			},
			cavalry: {
				...DEFAULT_CONFIG.upgradeCosts.cavalry,
				...input.upgradeCosts?.cavalry,
			},
			archer: {
				...DEFAULT_CONFIG.upgradeCosts.archer,
				...input.upgradeCosts?.archer,
			},
		},
		terrainDefenseBonus: {
			...DEFAULT_CONFIG.terrainDefenseBonus,
			...input.terrainDefenseBonus,
		},
		fortifyDefenseBonusByTerrain: {
			...DEFAULT_CONFIG.fortifyDefenseBonusByTerrain,
			...input.fortifyDefenseBonusByTerrain,
		},
		abilities: { ...DEFAULT_CONFIG.abilities, ...input.abilities },
		resourceNodes: {
			...DEFAULT_CONFIG.resourceNodes,
			...input.resourceNodes,
		},
	};
}

// We store config outside of MatchState to avoid exposing it on the wire.
const CONFIG_BY_STATE = new WeakMap<MatchState, EngineConfig>();

function bindConfig(state: MatchState, config: EngineConfig): MatchState {
	CONFIG_BY_STATE.set(state, config);
	return state;
}

function resolveConfig(state: MatchState): EngineConfig {
	const bound = CONFIG_BY_STATE.get(state);
	if (bound) return bound;
	const inferred = mergeConfig({
		boardColumns: inferBoardColumnsFromBoard(state.board),
	});
	CONFIG_BY_STATE.set(state, inferred);
	return inferred;
}

export function bindEngineConfig(
	state: MatchState,
	configInput?: EngineConfigInput,
): MatchState {
	const existing = resolveConfig(state);
	const boardColumns = inferBoardColumnsFromBoard(state.board);
	const config = mergeConfig({
		...existing,
		...configInput,
		boardColumns,
	});
	return bindConfig(state, config);
}

export function getEngineConfig(state: MatchState): EngineConfig {
	return resolveConfig(state);
}

const UPGRADE_PATH: Record<BaseUnitType, Tier2UnitType> = {
	infantry: "swordsman",
	cavalry: "knight",
	archer: "crossbow",
};

function isBaseUnitType(unitType: UnitType): unitType is BaseUnitType {
	return (
		unitType === "infantry" || unitType === "cavalry" || unitType === "archer"
	);
}

function isCavalryLine(unitType: UnitType): boolean {
	return unitType === "cavalry" || unitType === "knight";
}

function isInfantryLine(unitType: UnitType): boolean {
	return unitType === "infantry" || unitType === "swordsman";
}

function isArcherLine(unitType: UnitType): boolean {
	return unitType === "archer" || unitType === "crossbow";
}

function canonicalColForBoardCol(
	boardCol: number,
	boardColumns: 17 | 21,
): number {
	if (boardColumns === 21) return boardCol;
	return BOARD_17_CANONICAL_COL_MAP[boardCol] ?? boardCol;
}

function mapCanonicalHexToBoardHex(
	hex: HexId,
	boardColumns: 17 | 21,
): HexId | null {
	const { row, col } = parseHexId(hex);
	if (boardColumns === 21) return hex;
	if (boardColumns !== 17) return null;
	const boardCol = (BOARD_17_CANONICAL_COL_MAP as readonly number[]).indexOf(
		col,
	);
	if (boardCol === -1) return null;
	return toHexId(row, boardCol);
}

function strongholdHexesForState(state: MatchState, side: PlayerSide): HexId[] {
	const strongholdType = side === "A" ? "stronghold_a" : "stronghold_b";
	return state.board
		.filter((h) => h.type === strongholdType)
		.map((h) => h.id)
		.sort((a, b) => a.localeCompare(b));
}

// ---------------------------------------------------------------------------
// Canonical board layout (21x9 = 189 hexes)
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
	if (config.boardColumns !== 21 && config.boardColumns !== 17) {
		throw new Error(`Unsupported boardColumns=${String(config.boardColumns)}`);
	}
	const board: HexState[] = [];
	for (let row = 0; row < ROWS; row++) {
		const rowTerrain = CANONICAL_TERRAIN[row];
		if (!rowTerrain) {
			throw new Error(`Missing canonical terrain row ${row}`);
		}
		for (let col = 0; col < config.boardColumns; col++) {
			const canonicalCol = canonicalColForBoardCol(col, config.boardColumns);
			const token = rowTerrain[canonicalCol];
			if (!token) {
				throw new Error(
					`Missing canonical terrain token row=${row} col=${canonicalCol}`,
				);
			}
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
				unitIds: [],
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

function boardColumnsForState(state: MatchState): 17 | 21 {
	return inferBoardColumnsFromBoard(state.board);
}

function getHex(state: MatchState, id: HexId): HexState | null {
	const boardColumns = boardColumnsForState(state);
	if (!isValidHexId(id, boardColumns)) return null;
	return state.board[hexIdIndex(id, boardColumns)] ?? null;
}

function addUnitToHex(state: MatchState, hexId: HexId, unitId: string) {
	const idx = hexIdIndex(hexId, boardColumnsForState(state));
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, unitIds: [...existing.unitIds, unitId] };
}

function removeUnitFromHex(state: MatchState, hexId: HexId, unitId: string) {
	const idx = hexIdIndex(hexId, boardColumnsForState(state));
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = {
		...existing,
		unitIds: existing.unitIds.filter((id) => id !== unitId),
	};
}

function clearHexUnits(state: MatchState, hexId: HexId) {
	const idx = hexIdIndex(hexId, boardColumnsForState(state));
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, unitIds: [] };
}

function getUnit(state: MatchState, unitId: string): Unit | null {
	for (const side of PLAYER_SIDES) {
		const unit = state.players[side].units.find((u) => u.id === unitId);
		if (unit) return unit;
	}
	return null;
}

function getUnitsOnHex(state: MatchState, hexId: HexId): Unit[] {
	const hex = getHex(state, hexId);
	if (!hex) return [];
	const units: Unit[] = [];
	for (const id of hex.unitIds) {
		const u = getUnit(state, id);
		if (u) units.push(u);
	}
	return units;
}

function addUnit(state: MatchState, unit: Unit) {
	state.players[unit.owner].units.push(unit);
	addUnitToHex(state, unit.position, unit.id);
}

function removeUnit(state: MatchState, unitId: string): Unit | null {
	for (const side of PLAYER_SIDES) {
		const idx = state.players[side].units.findIndex((u) => u.id === unitId);
		if (idx >= 0) {
			const [unit] = state.players[side].units.splice(idx, 1);
			if (!unit) return null;
			removeUnitFromHex(state, unit.position, unit.id);
			return unit;
		}
	}
	return null;
}

function moveUnitTo(state: MatchState, unit: Unit, to: HexId, dist: number) {
	removeUnitFromHex(state, unit.position, unit.id);
	unit.position = to;
	unit.movedThisTurn = true;
	unit.movedDistance = dist;
	addUnitToHex(state, to, unit.id);
}

/** Move an entire stack (all units on the same hex as unit) together */
function moveStackTo(state: MatchState, unit: Unit, to: HexId, dist: number) {
	const hex = getHex(state, unit.position);
	if (!hex) return;
	const stackUnitIds = [...hex.unitIds];
	// Remove all from source hex
	clearHexUnits(state, unit.position);
	// Update each unit's position
	for (const uid of stackUnitIds) {
		const u = getUnit(state, uid);
		if (u) {
			u.position = to;
			u.movedThisTurn = true;
			u.movedDistance = dist;
			addUnitToHex(state, to, u.id);
		}
	}
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
	const cloned: MatchState = {
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
		board: state.board.map((h) => ({ ...h, unitIds: [...h.unitIds] })),
	};
	return bindConfig(cloned, resolveConfig(state));
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
	const config = resolveConfig(state);
	const player = state.players[side];
	const enemy = state.players[otherSide(side)];

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

	// Long-horizon macro: holding multiple economy nodes compounds income.
	let controlledEconomicNodes = 0;
	for (const hex of state.board) {
		if (hex.controlledBy !== side) continue;
		if (hex.type === "gold_mine" || hex.type === "lumber_camp") {
			controlledEconomicNodes += 1;
		}
	}
	const economicNodeThreshold = Math.max(
		1,
		config.resourceNodes.economicNodeControlThreshold,
	);
	const economicTiers = Math.floor(
		controlledEconomicNodes / economicNodeThreshold,
	);
	if (economicTiers > 0) {
		goldIncome += economicTiers * config.resourceNodes.economicNodeBonusGold;
		woodIncome += economicTiers * config.resourceNodes.economicNodeBonusWood;
	}

	// Comeback macro: trailing players receive a small stabilizer stipend.
	const vpDeficit =
		enemy.vp - player.vp >= config.resourceNodes.comebackVpDeficitThreshold;
	const unitDeficit =
		enemy.units.length - player.units.length >=
		config.resourceNodes.comebackUnitDeficitThreshold;
	const hexDeficit =
		controlledHexCount(state, otherSide(side)) -
			controlledHexCount(state, side) >=
		config.resourceNodes.comebackHexDeficitThreshold;
	const comebackSignals = [vpDeficit, unitDeficit, hexDeficit].filter(
		Boolean,
	).length;
	if (comebackSignals >= 2) {
		goldIncome += config.resourceNodes.comebackGoldBonus;
		woodIncome += config.resourceNodes.comebackWoodBonus;
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
	const boardColumns = boardColumnsForState(state);
	const attackerNeighbors = new Set(neighborsOf(attackerPos, boardColumns));
	const targetNeighbors = new Set(neighborsOf(targetPos, boardColumns));

	const shared: HexId[] = [];
	for (const n of attackerNeighbors) {
		if (targetNeighbors.has(n)) shared.push(n);
	}

	if (shared.length !== 1) {
		return { clear: false, reason: "No straight line (shared neighbors != 1)" };
	}

	const midHex = shared[0];
	if (!midHex) {
		return { clear: false, reason: "No shared mid hex" };
	}
	const targetHex = getHex(state, targetPos);
	const midHexState = getHex(state, midHex);

	if (targetHex?.type === "forest") {
		return { clear: false, reason: "Target is in forest" };
	}
	if (midHexState?.type === "forest") {
		return { clear: false, reason: "Mid hex is forest" };
	}

	// Check if mid hex has a unit blocking LoS
	if (midHexState && midHexState.unitIds.length > 0) {
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
	damageToDefenders: number;
	damageToAttackers: number;
	abilities: string[];
};

function applyDamageToStack(
	units: Unit[],
	damage: number,
): { survivors: Unit[]; casualties: Unit[] } {
	const survivors: Unit[] = [];
	const casualties: Unit[] = [];
	let remaining = damage;
	for (const u of units) {
		if (remaining <= 0) {
			survivors.push(u);
			continue;
		}
		if (u.hp > remaining) {
			u.hp -= remaining;
			remaining = 0;
			survivors.push(u);
		} else {
			remaining -= u.hp;
			u.hp = 0;
			casualties.push(u);
		}
	}
	return { survivors, casualties };
}

function computeCombat(
	attackers: Unit[],
	defenders: Unit[],
	state: MatchState,
	dist: number,
	initiatingAttackerId: string,
): CombatResult {
	const config = resolveConfig(state);
	const abilities: string[] = [];

	const leadAttacker =
		attackers.find((attacker) => attacker.id === initiatingAttackerId) ??
		attackers[0];
	const leadDefender = defenders[0];
	if (!leadAttacker || !leadDefender) {
		throw new Error("Combat requires at least one attacker and one defender");
	}

	// Attack power: base ATK + attacker bonus + stack bonus + cavalry charge
	let attackPower = config.unitStats[leadAttacker.type].attack;
	attackPower += config.abilities.attackerBonus;
	abilities.push("attacker_bonus");

	// Stack bonus: +1 per extra attacker
	const attackStackExtra = attackers.length - 1;
	if (attackStackExtra > 0) {
		attackPower += attackStackExtra * config.abilities.stackAttackBonus;
		abilities.push(`stack_atk_+${attackStackExtra}`);
	}

	// Cavalry line charge: +2 if cavalry/knight, moved this turn with distance >= 2,
	// and there was a forest-free shortest path
	if (isCavalryLine(leadAttacker.type) && leadAttacker.chargeEligible) {
		attackPower += config.abilities.cavalryChargeBonus;
		abilities.push("cavalry_charge");
	}

	// Defense power: base DEF + terrain + fortify + shield wall + stack bonus
	const defenderHex = getHex(state, leadDefender.position);
	let defensePower = config.unitStats[leadDefender.type].defense;

	// Terrain bonus
	if (defenderHex) {
		defensePower += config.terrainDefenseBonus[defenderHex.type];
	}

	// Fortify bonus (any unit in stack fortified applies)
	if (defenders.some((d) => d.isFortified)) {
		defensePower += config.abilities.fortifyBonus;
		if (defenderHex) {
			defensePower +=
				config.fortifyDefenseBonusByTerrain[defenderHex.type] ?? 0;
		}
		abilities.push("fortify");
	}
	// Slight melee pressure against fortified infantry to reduce stall loops.
	if (
		dist === 1 &&
		isInfantryLine(leadDefender.type) &&
		defenders.some((d) => d.isFortified)
	) {
		defensePower = Math.max(0, defensePower - 1);
		abilities.push("fortify_breached");
	}

	// Shield Wall: +1 per adjacent hex with friendly infantry, max +2
	if (isInfantryLine(leadDefender.type)) {
		const adjacentIds = neighborsOf(
			leadDefender.position,
			boardColumnsForState(state),
		);
		let shieldWallBonus = 0;
		for (const adjId of adjacentIds) {
			const adjHex = getHex(state, adjId);
			if (adjHex && adjHex.unitIds.length > 0) {
				// Count this hex if it has any friendly infantry
				const hasInfantry = adjHex.unitIds.some((uid) => {
					const u = getUnit(state, uid);
					return u && u.owner === leadDefender.owner && isInfantryLine(u.type);
				});
				if (hasInfantry) shieldWallBonus++;
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

	// Defender stack bonus: +1 per extra defender
	const defStackExtra = defenders.length - 1;
	if (defStackExtra > 0) {
		defensePower += defStackExtra * config.abilities.stackAttackBonus;
		abilities.push(`stack_def_+${defStackExtra}`);
	}

	// Archer melee vulnerability: -1 DEF at distance 1 (floor 0)
	if (isArcherLine(leadDefender.type) && dist === 1) {
		defensePower = Math.max(
			0,
			defensePower - config.abilities.archerMeleeVulnerability,
		);
		abilities.push("archer_melee_vulnerability");
	}

	// Resolve damage
	const ranged = dist > 1;
	let damageToDefenders: number;
	let damageToAttackers: number;

	if (attackPower > defensePower) {
		damageToDefenders = attackPower - defensePower;
		damageToAttackers = 0;
	} else if (attackPower === defensePower) {
		damageToDefenders = 1;
		damageToAttackers = 0;
	} else {
		// ATK < DEF
		damageToDefenders = 1; // minimum damage
		damageToAttackers = ranged ? 0 : 1; // counterattack only in melee
	}

	return {
		attackPower,
		defensePower,
		damageToDefenders,
		damageToAttackers,
		abilities,
	};
}

// ---------------------------------------------------------------------------
// Victory conditions
// ---------------------------------------------------------------------------

function computeImmediateTerminal(state: MatchState): TerminalState {
	// Stronghold capture: ONE stronghold is enough to win
	const bStrongholds = strongholdHexesForState(state, "B");
	if (bStrongholds.some((h) => getHex(state, h)?.controlledBy === "A")) {
		return {
			ended: true,
			winner: state.players.A.id,
			reason: "stronghold_capture",
		};
	}

	const aStrongholds = strongholdHexesForState(state, "A");
	if (aStrongholds.some((h) => getHex(state, h)?.controlledBy === "B")) {
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
	const config = resolveConfig(state);
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
	const config = resolveConfig(state);
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
		if (hex.unitIds.length > 0) {
			const firstUnitId = hex.unitIds[0];
			const firstUnit = firstUnitId ? getUnit(state, firstUnitId) : null;
			const nextOwner = firstUnit ? firstUnit.owner : hex.controlledBy;
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

	const board = buildCanonicalBoard(config);

	const state: MatchState = {
		seed,
		turn: 1,
		activePlayer: "A",
		actionsRemaining: config.actionsPerTurn,
		players: {
			A: {
				id: playerA,
				gold: config.startingGold,
				wood: config.startingWood,
				vp: 0,
				units: [],
			},
			B: {
				id: playerB,
				gold: config.startingGold,
				wood: config.startingWood,
				vp: 0,
				units: [],
			},
		},
		board,
		status: "active",
	};

	bindConfig(state, config);

	// Place starting units (spec Section 6.3)
	const startingUnits: Array<{
		id: string;
		type: UnitType;
		owner: PlayerSide;
		position: HexId;
	}> = [
		{ id: "A-1", type: "infantry", owner: "A", position: "B2" as HexId },
		{ id: "A-2", type: "infantry", owner: "A", position: "H2" as HexId },
		{ id: "A-3", type: "infantry", owner: "A", position: "G2" as HexId },
		{ id: "A-4", type: "cavalry", owner: "A", position: "B3" as HexId },
		{ id: "A-5", type: "cavalry", owner: "A", position: "H3" as HexId },
		{ id: "A-6", type: "archer", owner: "A", position: "C2" as HexId },
		{ id: "B-1", type: "infantry", owner: "B", position: "B20" as HexId },
		{ id: "B-2", type: "infantry", owner: "B", position: "H20" as HexId },
		{ id: "B-3", type: "infantry", owner: "B", position: "G20" as HexId },
		{ id: "B-4", type: "cavalry", owner: "B", position: "B19" as HexId },
		{ id: "B-5", type: "cavalry", owner: "B", position: "H19" as HexId },
		{ id: "B-6", type: "archer", owner: "B", position: "C20" as HexId },
	];

	for (const def of startingUnits) {
		const mappedPosition = mapCanonicalHexToBoardHex(
			def.position,
			config.boardColumns,
		);
		if (!mappedPosition) continue;
		const hp = config.unitStats[def.type].hp;
		const unit: Unit = {
			id: def.id,
			type: def.type,
			owner: def.owner,
			position: mappedPosition,
			hp,
			maxHp: hp,
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
	const config = resolveConfig(state);
	const boardColumns = config.boardColumns;
	const side = state.activePlayer;
	const player = state.players[side];
	const moves: Move[] = [];

	const canAct = state.actionsRemaining > 0;

	if (canAct) {
		// Recruit at own strongholds (must be empty)
		const strongholds = strongholdHexesForState(state, side);
		for (const shId of strongholds) {
			const hex = getHex(state, shId);
			if (hex && hex.controlledBy === side && hex.unitIds.length === 0) {
				for (const unitType of [
					"infantry",
					"cavalry",
					"archer",
				] as BaseUnitType[]) {
					const cost = config.unitStats[unitType].cost;
					if (player.gold >= cost) {
						moves.push({ action: "recruit", unitType, at: shId });
					}
				}
			}
		}

		// Build blocked set for movement: enemy hexes and friendly different-type hexes are blocked
		// Friendly same-type hexes (below maxStackSize) are passable destinations
		const seenMoveUnits = new Set<HexId>(); // track stacks already generating moves

		// Move
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.movedThisTurn) continue;
			// Only generate one move per stack position
			if (seenMoveUnits.has(unit.position)) continue;
			seenMoveUnits.add(unit.position);

			const movementRange = config.unitStats[unit.type].movement;
			// Build blocked: hexes that this unit/stack can't pass through or land on
			const blocked = new Set<HexId>();
			for (const s of PLAYER_SIDES) {
				for (const u of state.players[s].units) {
					if (u.position === unit.position) continue; // self/stack
					if (s !== side) {
						blocked.add(u.position); // enemy hexes
					} else if (u.type !== unit.type) {
						blocked.add(u.position); // friendly different type
					}
					// friendly same type: check stack size
				}
			}
			// Also block friendly same-type that are at maxStackSize
			for (const hex of state.board) {
				if (hex.unitIds.length >= config.abilities.maxStackSize) {
					if (hex.id !== unit.position) blocked.add(hex.id);
				}
			}

			const reachable = reachableHexes(
				unit.position,
				movementRange,
				blocked,
				boardColumns,
			);
			for (const hexId of sortHexIds(reachable)) {
				moves.push({ action: "move", unitId: unit.id, to: hexId });
			}
		}

		// Attack — deduplicate target hexes per unit
		const enemyPositions = new Set<HexId>();
		for (const eu of state.players[otherSide(side)].units) {
			enemyPositions.add(eu.position);
		}
		const seenAttackUnits = new Set<HexId>();

		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.attackedThisTurn) continue;
			// One attack action per stack
			if (seenAttackUnits.has(unit.position)) continue;
			seenAttackUnits.add(unit.position);

			const range = config.unitStats[unit.type].range;
			const targets = new Set<HexId>();
			for (const enemyPos of enemyPositions) {
				const dist = hexDistance(unit.position, enemyPos, boardColumns);
				if (dist !== null && dist >= 1 && dist <= range) {
					if (dist === 2) {
						const los = computeLoS(unit.position, enemyPos, state);
						if (!los.clear) continue;
					}
					targets.add(enemyPos);
				}
			}
			for (const hexId of sortHexIds([...targets])) {
				moves.push({ action: "attack", unitId: unit.id, target: hexId });
			}
		}

		// Fortify
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.movedThisTurn || unit.attackedThisTurn) continue;
			if (unit.isFortified) continue;
			if (player.wood < FORTIFY_WOOD_COST) continue;
			moves.push({ action: "fortify", unitId: unit.id });
		}

		// Upgrade (T1 -> T2)
		for (const unit of sortUnits(player.units)) {
			if (!unit.canActThisTurn) continue;
			if (unit.movedThisTurn || unit.attackedThisTurn) continue;
			if (!isBaseUnitType(unit.type)) continue;
			const upgradeCost = config.upgradeCosts[unit.type];
			if (player.gold < upgradeCost.gold || player.wood < upgradeCost.wood) {
				continue;
			}
			moves.push({ action: "upgrade", unitId: unit.id });
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

	const config = resolveConfig(state);
	const boardColumns = config.boardColumns;
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
			if (hex.unitIds.length > 0) {
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
			if (!isValidHexId(m.to, boardColumns)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.to);
			if (!targetHex) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target occupied.",
				};
			}
			// Allow stacking with friendly same-type, but not enemy or different type
			if (targetHex.unitIds.length > 0) {
				const targetUnits = getUnitsOnHex(state, m.to);
				const hasEnemy = targetUnits.some((u) => u.owner !== side);
				const hasDiffType = targetUnits.some((u) => u.type !== unit.type);
				if (hasEnemy || hasDiffType) {
					return {
						ok: false,
						reason: "illegal_move",
						error: "Target occupied.",
					};
				}
				if (targetHex.unitIds.length >= config.abilities.maxStackSize) {
					return {
						ok: false,
						reason: "illegal_move",
						error: "Stack is full.",
					};
				}
			}
			// Build blocked set for pathfinding
			const blocked = new Set<HexId>();
			for (const s of PLAYER_SIDES) {
				for (const u of state.players[s].units) {
					if (u.position === unit.position) continue;
					if (u.position === m.to) continue; // allow destination
					if (s !== side) {
						blocked.add(u.position);
					} else if (u.type !== unit.type) {
						blocked.add(u.position);
					}
				}
			}
			// Block friendly same-type at maxStackSize (except destination, handled above)
			for (const hex of state.board) {
				if (hex.id === unit.position || hex.id === m.to) continue;
				if (hex.unitIds.length >= config.abilities.maxStackSize) {
					blocked.add(hex.id);
				}
			}
			const dist = pathDistance(unit.position, m.to, blocked, boardColumns);
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
			if (!isValidHexId(m.target, boardColumns)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.target);
			if (!targetHex || targetHex.unitIds.length === 0) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "No target unit.",
				};
			}
			const targetUnits = getUnitsOnHex(state, m.target);
			if (targetUnits.length === 0 || targetUnits[0]?.owner === side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target must be enemy.",
				};
			}
			const dist = hexDistance(unit.position, m.target, boardColumns);
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
			if (player.wood < FORTIFY_WOOD_COST) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Not enough wood.",
				};
			}
			return { ok: true, move: m };
		}
		case "upgrade": {
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
			if (!isBaseUnitType(unit.type)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Unit is already upgraded.",
				};
			}
			const upgradeCost = config.upgradeCosts[unit.type];
			if (player.gold < upgradeCost.gold || player.wood < upgradeCost.wood) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Not enough resources.",
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
	const config = resolveConfig(state);
	const boardColumns = config.boardColumns;
	const nextState = cloneState(state);
	const side = nextState.activePlayer;
	const player = nextState.players[side];
	const engineEvents: EngineEvent[] = [];

	switch (m.action) {
		case "recruit": {
			if (m.action !== "recruit") break; // narrowing
			const unitId = nextUnitId(nextState, side);
			const hp = config.unitStats[m.unitType].hp;
			const unit: Unit = {
				id: unitId,
				type: m.unitType,
				owner: side,
				position: m.at,
				hp,
				maxHp: hp,
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
			// Build blocked set matching validateMove logic
			const blocked = new Set<HexId>();
			for (const s of PLAYER_SIDES) {
				for (const u of nextState.players[s].units) {
					if (u.position === unit.position) continue;
					if (u.position === m.to) continue;
					if (s !== side) {
						blocked.add(u.position);
					} else if (u.type !== unit.type) {
						blocked.add(u.position);
					}
				}
			}
			for (const hex of nextState.board) {
				if (hex.id === unit.position || hex.id === m.to) continue;
				if (hex.unitIds.length >= config.abilities.maxStackSize) {
					blocked.add(hex.id);
				}
			}
			const dist = pathDistance(unit.position, m.to, blocked, boardColumns);
			if (dist == null) {
				return failMove(nextState, m, "invalid_move", "Move path not found.");
			}
			const from = unit.position;

			// Check cavalry-line charge eligibility before moving
			let chargeEligible = false;
			if (isCavalryLine(unit.type) && dist >= 2) {
				chargeEligible = hasForestFreePath(
					from,
					m.to,
					dist,
					blocked,
					nextState.board,
					boardColumns,
				);
			}

			// Move entire stack together
			moveStackTo(nextState, unit, m.to, dist);
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
			const leadAttacker = getUnit(nextState, m.unitId);
			if (!leadAttacker) {
				return failMove(nextState, m, "invalid_move", "Attacker not found.");
			}
			const targetHex = getHex(nextState, m.target);
			if (!targetHex || targetHex.unitIds.length === 0) {
				return failMove(nextState, m, "invalid_move", "Target missing.");
			}
			const attackers = getUnitsOnHex(nextState, leadAttacker.position);
			const defenders = getUnitsOnHex(nextState, m.target);
			if (defenders.length === 0) {
				return failMove(nextState, m, "invalid_move", "Defender missing.");
			}
			const leadDefender = defenders[0];
			if (!leadDefender) {
				return failMove(nextState, m, "invalid_move", "Defender missing.");
			}

			const attackerFrom = leadAttacker.position;
			const defenderIds = defenders.map((d) => d.id);
			const dist =
				hexDistance(
					leadAttacker.position,
					leadDefender.position,
					boardColumns,
				) ?? 0;
			const ranged = dist > 1;

			const combat = computeCombat(
				attackers,
				defenders,
				nextState,
				dist,
				leadAttacker.id,
			);

			// Apply damage to defenders
			const defResult = applyDamageToStack(defenders, combat.damageToDefenders);
			for (const dead of defResult.casualties) {
				removeUnit(nextState, dead.id);
				// VP for kill
				player.vp += config.abilities.vpPerKill;
			}

			// Apply damage to attackers (counterattack)
			const atkResult = applyDamageToStack(attackers, combat.damageToAttackers);
			const enemySide = otherSide(side);
			for (const dead of atkResult.casualties) {
				removeUnit(nextState, dead.id);
				nextState.players[enemySide].vp += config.abilities.vpPerKill;
			}

			// Melee capture: attackers move in if ALL defenders dead
			const allDefendersDead = defResult.survivors.length === 0;
			const captured =
				!ranged && allDefendersDead && atkResult.survivors.length > 0;
			if (captured) {
				// Move surviving attackers into defender hex
				for (const surv of atkResult.survivors) {
					moveUnitTo(nextState, surv, m.target, dist);
				}
			}

			// Mark surviving attackers as having attacked
			for (const surv of atkResult.survivors) {
				surv.attackedThisTurn = true;
			}

			engineEvents.push({
				type: "attack",
				turn: nextState.turn,
				player: side,
				attackerId: leadAttacker.id,
				attackerFrom,
				defenderIds,
				targetHex: m.target,
				distance: dist,
				ranged,
				attackPower: combat.attackPower,
				defensePower: combat.defensePower,
				abilities: combat.abilities,
				outcome: {
					attackerSurvivors: atkResult.survivors.map((u) => u.id),
					attackerCasualties: atkResult.casualties.map((u) => u.id),
					defenderSurvivors: defResult.survivors.map((u) => u.id),
					defenderCasualties: defResult.casualties.map((u) => u.id),
					damageDealt: combat.damageToDefenders,
					damageTaken: combat.damageToAttackers,
					captured,
				},
			});
			break;
		}
		case "fortify": {
			const unit = getUnit(nextState, m.unitId);
			if (!unit) {
				return failMove(nextState, m, "invalid_move", "Unit not found.");
			}
			player.wood -= FORTIFY_WOOD_COST;
			// Fortify all units on the hex
			const stackUnits = getUnitsOnHex(nextState, unit.position);
			for (const su of stackUnits) {
				su.isFortified = true;
				su.canActThisTurn = false;
			}
			engineEvents.push({
				type: "fortify",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				at: unit.position,
			});
			break;
		}
		case "upgrade": {
			const unit = getUnit(nextState, m.unitId);
			if (!unit) {
				return failMove(nextState, m, "invalid_move", "Unit not found.");
			}
			if (!isBaseUnitType(unit.type)) {
				return failMove(
					nextState,
					m,
					"invalid_move",
					"Unit is already upgraded.",
				);
			}
			const fromType = unit.type;
			const toType = UPGRADE_PATH[fromType];
			const upgradeCost = config.upgradeCosts[fromType];
			player.gold -= upgradeCost.gold;
			player.wood -= upgradeCost.wood;
			const nextStats = config.unitStats[toType];
			unit.type = toType;
			unit.maxHp = nextStats.hp;
			unit.hp = Math.min(nextStats.hp, unit.hp + 1);
			unit.canActThisTurn = false;
			unit.movedThisTurn = false;
			unit.attackedThisTurn = false;
			unit.chargeEligible = undefined;
			engineEvents.push({
				type: "upgrade",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				fromType,
				toType,
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
	const cols = boardColumnsForState(state);

	// Header row with column numbers
	const headerCells: string[] = [];
	for (let col = 0; col < cols; col++) {
		headerCells.push(String(col + 1).padStart(4));
	}
	lines.push(`    ${headerCells.join("")}`);

	for (let row = 0; row < ROWS; row++) {
		const rowLabel = ROW_LETTERS[row] ?? "?";
		const cells: string[] = [];
		for (let col = 0; col < cols; col++) {
			const id = toHexId(row, col);
			const hex = getHex(state, id);
			if (!hex) {
				cells.push(" ?? ");
				continue;
			}
			const firstUnitId = hex.unitIds[0];
			const unit = firstUnitId ? getUnit(state, firstUnitId) : null;
			const owner = unit?.owner ?? hex.controlledBy ?? ".";
			const stackCount = hex.unitIds.length;
			const content = unit
				? unitTypeChar(unit.type) + (stackCount > 1 ? String(stackCount) : "")
				: terrainChar(hex.type);
			cells.push(` ${owner}${content.padEnd(2)} `.slice(0, 4));
		}
		lines.push(`${rowLabel}  ${cells.join("")}`);
	}

	lines.push("");
	lines.push(
		"Legend: A/B=control, i=infantry, c=cavalry, a=archer, s=swordsman, k=knight, x=crossbow",
	);
	lines.push(
		"  S=stronghold, G=gold, L=lumber, C=crown, H=high_ground, F=forest, h=hills, D=deploy",
	);
	return lines.join("\n");
}

function unitTypeChar(type: UnitType): string {
	switch (type) {
		case "infantry":
			return "i";
		case "cavalry":
			return "c";
		case "archer":
			return "a";
		case "swordsman":
			return "s";
		case "knight":
			return "k";
		case "crossbow":
			return "x";
	}
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
		event: z.literal("match_ended"),
		matchId: z.string(),
		winnerAgentId: z.string().nullable().optional(),
		loserAgentId: z.string().nullable().optional(),
		reason: z.string().optional(),
		reasonCode: z.string().optional(),
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
