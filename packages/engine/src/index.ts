import { z } from "zod";

// Contract locks:
// 1) 7x7 offset grid using { q, r } mapped to [-3..3]
// 2) SSE/Spectator event schema unchanged (eventVersion: 1)
// 3) Move format: { action, unitId?, targetHex?, unitType?, reasoning? }

export type AgentId = string;
export type PlayerSide = "A" | "B";
export type HexCoord = { q: number; r: number };
export type HexType = "capital" | "gold_mine" | "tower" | "plains";
export type UnitType = "infantry" | "cavalry" | "archer";

export type Move =
	| { action: "move"; unitId: string; targetHex: HexCoord; reasoning?: string }
	| {
			action: "attack";
			unitId: string;
			targetHex: HexCoord;
			reasoning?: string;
	  }
	| { action: "recruit"; unitType: UnitType; reasoning?: string }
	| { action: "fortify"; unitId: string; reasoning?: string }
	| { action: "pass"; reasoning?: string };

export type Unit = {
	id: string;
	type: UnitType;
	owner: PlayerSide;
	position: HexCoord;
	isFortified: boolean;
	movedThisTurn: boolean;
	movedDistance: number;
};

export type PlayerState = {
	id: AgentId;
	gold: number;
	supply: number;
	supplyCap: number;
	units: Unit[];
};

export type HexState = {
	coord: HexCoord;
	type: HexType;
	controlledBy: PlayerSide | null;
	unitId: string | null;
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
	config?: EngineConfig;
};

export type GameState = MatchState;

export type TerminalReason =
	| "capital_capture"
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
			income: number;
			goldAfter: number;
	  }
	| {
			type: "recruit";
			turn: number;
			player: PlayerSide;
			unitId: string;
			unitType: UnitType;
			at: HexCoord;
	  }
	| {
			type: "move_unit";
			turn: number;
			player: PlayerSide;
			unitId: string;
			from: HexCoord;
			to: HexCoord;
	  }
	| {
			type: "fortify";
			turn: number;
			player: PlayerSide;
			unitId: string;
			at: HexCoord;
	  }
	| {
			type: "attack";
			turn: number;
			player: PlayerSide;
			attackerId: string;
			attackerFrom: HexCoord;
			defenderId: string;
			targetHex: HexCoord;
			distance: number;
			ranged: boolean;
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
				coord: HexCoord;
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

export type EngineConfig = {
	boardSize: 7;
	actionsPerTurn: number;
	startingGold: number;
	baseSupplyCap: number;
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
	hexIncome: {
		capital: number;
		gold_mine: number;
		plains: number;
		tower: number;
	};
	terrainDefenseBonus: {
		capital: number;
		tower: number;
		gold_mine: number;
		plains: number;
	};
	abilities: {
		cavalryChargeBonus: number;
		infantryAdjacencyBonus: number;
		archerMeleeVulnerability: number;
	};
	victory: {
		turnLimit: number;
		territoryControl: number;
		dominance?: { threshold: number; turns: number };
	};
	boardLayout: HexState[];
};

export type EngineConfigInput = Partial<EngineConfig>;

const BOARD_SIZE = 7;
const BOARD_MIN = -3;
const BOARD_MAX = 3;
const PLAYER_SIDES: PlayerSide[] = ["A", "B"];

const CAPITAL_COORDS: Record<PlayerSide, HexCoord> = {
	A: { q: -3, r: -3 },
	B: { q: 3, r: 3 },
};

export const HexCoordSchema = z
	.object({ q: z.number().int(), r: z.number().int() })
	.strict()
	.refine(
		(v) =>
			v.q >= BOARD_MIN &&
			v.q <= BOARD_MAX &&
			v.r >= BOARD_MIN &&
			v.r <= BOARD_MAX,
		{ message: "HexCoord out of bounds" },
	);

export const MoveSchema = z.discriminatedUnion("action", [
	z
		.object({
			action: z.literal("move"),
			unitId: z.string(),
			targetHex: HexCoordSchema,
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("attack"),
			unitId: z.string(),
			targetHex: HexCoordSchema,
			reasoning: z.string().optional(),
		})
		.strict(),
	z
		.object({
			action: z.literal("recruit"),
			unitType: z.enum(["infantry", "cavalry", "archer"]),
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
			action: z.literal("pass"),
			reasoning: z.string().optional(),
		})
		.strict(),
]);

export const UnitTypeSchema = z.enum(["infantry", "cavalry", "archer"]);

export const MatchStateSchema = z.object({
	seed: z.number().int(),
	turn: z.number().int(),
	activePlayer: z.enum(["A", "B"]),
	actionsRemaining: z.number().int(),
	players: z.object({
		A: z.object({
			id: z.string(),
			gold: z.number().int(),
			supply: z.number().int(),
			supplyCap: z.number().int(),
			units: z.array(
				z.object({
					id: z.string(),
					type: UnitTypeSchema,
					owner: z.enum(["A", "B"]),
					position: HexCoordSchema,
					isFortified: z.boolean(),
					movedThisTurn: z.boolean(),
					movedDistance: z.number().int(),
				}),
			),
		}),
		B: z.object({
			id: z.string(),
			gold: z.number().int(),
			supply: z.number().int(),
			supplyCap: z.number().int(),
			units: z.array(
				z.object({
					id: z.string(),
					type: UnitTypeSchema,
					owner: z.enum(["A", "B"]),
					position: HexCoordSchema,
					isFortified: z.boolean(),
					movedThisTurn: z.boolean(),
					movedDistance: z.number().int(),
				}),
			),
		}),
	}),
	board: z.array(
		z.object({
			coord: HexCoordSchema,
			type: z.enum(["capital", "gold_mine", "tower", "plains"]),
			controlledBy: z.enum(["A", "B"]).nullable(),
			unitId: z.string().nullable(),
		}),
	),
	status: z.enum(["active", "ended"]),
	config: z
		.object({
			boardSize: z.literal(7),
			actionsPerTurn: z.number().int(),
			startingGold: z.number().int(),
			baseSupplyCap: z.number().int(),
		})
		.partial()
		.optional(),
});

export const GameStateSchema = MatchStateSchema;

const DEFAULT_BOARD_LAYOUT: HexState[] = buildDefaultBoardLayout();

export const DEFAULT_CONFIG: EngineConfig = {
	boardSize: 7,
	actionsPerTurn: 3,
	startingGold: 50,
	baseSupplyCap: 10,
	unitStats: {
		infantry: { cost: 10, attack: 2, defense: 3, movement: 1, range: 1 },
		cavalry: { cost: 20, attack: 4, defense: 2, movement: 3, range: 1 },
		archer: { cost: 15, attack: 3, defense: 1, movement: 2, range: 2 },
	},
	hexIncome: {
		capital: 5,
		gold_mine: 3,
		plains: 1,
		tower: 0,
	},
	terrainDefenseBonus: {
		capital: 2,
		tower: 1,
		gold_mine: 0,
		plains: 0,
	},
	abilities: {
		cavalryChargeBonus: 1,
		infantryAdjacencyBonus: 1,
		archerMeleeVulnerability: 1,
	},
	victory: {
		turnLimit: 50,
		territoryControl: 0.66,
	},
	boardLayout: DEFAULT_BOARD_LAYOUT,
};

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
	if (configInput?.boardSize && configInput.boardSize !== BOARD_SIZE) {
		throw new Error("Only 7x7 boards are supported in MVP.");
	}

	const config = mergeConfig(configInput);
	const board = cloneBoard(config.boardLayout);

	const state: MatchState = {
		seed,
		turn: 1,
		activePlayer: "A",
		actionsRemaining: config.actionsPerTurn,
		players: {
			A: {
				id: playerA,
				gold: config.startingGold,
				supply: 0,
				supplyCap: config.baseSupplyCap,
				units: [],
			},
			B: {
				id: playerB,
				gold: config.startingGold,
				supply: 0,
				supplyCap: config.baseSupplyCap,
				units: [],
			},
		},
		board,
		status: "active",
		config,
	};

	for (const side of PLAYER_SIDES) {
		const capital = CAPITAL_COORDS[side];
		const capitalHex = getHex(state, capital);
		if (!capitalHex || capitalHex.unitId != null) continue;
		const unitId = nextUnitId(state, side);
		const unit: Unit = {
			id: unitId,
			type: "infantry",
			owner: side,
			position: capital,
			isFortified: false,
			movedThisTurn: false,
			movedDistance: 0,
		};
		addUnit(state, unit);
	}

	recalculateDerived(state);
	return state;
}

export function initialState(seed: number, players: AgentId[]): MatchState {
	return createInitialState(seed, undefined, players);
}

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
	const side = state.activePlayer;
	const player = state.players[side];
	const moves: Move[] = [];

	const canAct = state.actionsRemaining > 0;
	const pendingIncome =
		state.actionsRemaining === config.actionsPerTurn
			? calculateIncome(state, side)
			: 0;
	const effectiveGold = player.gold + pendingIncome;

	if (canAct) {
		// Recruit
		const capital = CAPITAL_COORDS[side];
		const capitalHex = getHex(state, capital);
		if (capitalHex && capitalHex.unitId == null) {
			for (const unitType of ["infantry", "cavalry", "archer"] as UnitType[]) {
				const cost = config.unitStats[unitType].cost;
				if (effectiveGold >= cost && player.supply < player.supplyCap) {
					moves.push({ action: "recruit", unitType });
				}
			}
		}

		// Move
		const occupied = buildOccupiedSet(state);
		for (const unit of sortUnits(player.units)) {
			const reachable = reachableCoords(
				unit.position,
				config.unitStats[unit.type].movement,
				occupied,
			);
			for (const coord of sortCoords(reachable)) {
				moves.push({ action: "move", unitId: unit.id, targetHex: coord });
			}
		}

		// Attack
		const enemyUnits = state.players[otherSide(side)].units;
		for (const unit of sortUnits(player.units)) {
			const range = config.unitStats[unit.type].range;
			const targets: HexCoord[] = [];
			for (const enemy of enemyUnits) {
				const dist = distance(unit.position, enemy.position);
				if (dist !== null && dist <= range) {
					targets.push(enemy.position);
				}
			}
			for (const coord of sortCoords(targets)) {
				moves.push({ action: "attack", unitId: unit.id, targetHex: coord });
			}
		}

		// Fortify
		for (const unit of sortUnits(player.units)) {
			if (!unit.isFortified) {
				moves.push({ action: "fortify", unitId: unit.id });
			}
		}
	}

	// Pass is always available
	moves.push({ action: "pass" });
	return moves;
}

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
	const m = parsed.data;
	const side = state.activePlayer;
	const player = state.players[side];
	const pendingIncome =
		state.actionsRemaining === config.actionsPerTurn
			? calculateIncome(state, side)
			: 0;
	const effectiveGold = player.gold + pendingIncome;

	if (state.actionsRemaining <= 0 && m.action !== "pass") {
		return {
			ok: false,
			reason: "illegal_move",
			error: "No actions remaining.",
		};
	}

	switch (m.action) {
		case "recruit": {
			const cost = config.unitStats[m.unitType].cost;
			if (effectiveGold < cost) {
				return { ok: false, reason: "illegal_move", error: "Not enough gold." };
			}
			if (player.supply >= player.supplyCap) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Supply cap reached.",
				};
			}
			const capital = CAPITAL_COORDS[side];
			const capitalHex = getHex(state, capital);
			if (!capitalHex || capitalHex.unitId != null) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Capital is occupied.",
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
			if (!isValidCoord(m.targetHex)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.targetHex);
			if (!targetHex || targetHex.unitId != null) {
				return { ok: false, reason: "illegal_move", error: "Target occupied." };
			}
			const occupied = buildOccupiedSet(state);
			occupied.delete(coordKey(unit.position));
			const dist = pathDistance(unit.position, m.targetHex, occupied);
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
			if (!isValidCoord(m.targetHex)) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of bounds.",
				};
			}
			const targetHex = getHex(state, m.targetHex);
			if (!targetHex || !targetHex.unitId) {
				return { ok: false, reason: "illegal_move", error: "No target unit." };
			}
			const targetUnit = getUnit(state, targetHex.unitId);
			if (!targetUnit || targetUnit.owner === side) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target must be enemy.",
				};
			}
			const dist = distance(unit.position, targetUnit.position);
			if (dist == null || dist > config.unitStats[unit.type].range) {
				return {
					ok: false,
					reason: "illegal_move",
					error: "Target out of range.",
				};
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
			return { ok: true, move: m };
		}
		case "pass":
			return { ok: true, move: m };
	}
}

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
	const nextState = cloneState(state);
	const side = nextState.activePlayer;
	const player = nextState.players[side];
	const engineEvents: EngineEvent[] = [];

	if (nextState.actionsRemaining === config.actionsPerTurn) {
		const income = calculateIncome(nextState, side);
		player.gold += income;
		clearFortify(nextState, side);
		engineEvents.push({
			type: "turn_start",
			turn: nextState.turn,
			player: side,
			actions: nextState.actionsRemaining,
			income,
			goldAfter: player.gold,
		});
	}

	switch (m.action) {
		case "recruit": {
			const capital = CAPITAL_COORDS[side];
			const unitId = nextUnitId(nextState, side);
			const unit: Unit = {
				id: unitId,
				type: m.unitType,
				owner: side,
				position: capital,
				isFortified: false,
				movedThisTurn: false,
				movedDistance: 0,
			};
			player.gold -= config.unitStats[m.unitType].cost;
			addUnit(nextState, unit);
			engineEvents.push({
				type: "recruit",
				turn: nextState.turn,
				player: side,
				unitId,
				unitType: m.unitType,
				at: capital,
			});
			break;
		}
		case "move": {
			const unit = getUnit(nextState, m.unitId);
			if (!unit) {
				return failMove(nextState, m, "invalid_move", "Unit not found.");
			}
			const occupied = buildOccupiedSet(nextState);
			occupied.delete(coordKey(unit.position));
			const dist = pathDistance(unit.position, m.targetHex, occupied);
			if (dist == null) {
				return failMove(nextState, m, "invalid_move", "Move path not found.");
			}
			const from = unit.position;
			moveUnit(nextState, unit, m.targetHex, dist);
			engineEvents.push({
				type: "move_unit",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				from,
				to: m.targetHex,
			});
			break;
		}
		case "attack": {
			const attacker = getUnit(nextState, m.unitId);
			if (!attacker) {
				return failMove(nextState, m, "invalid_move", "Attacker not found.");
			}
			const targetHex = getHex(nextState, m.targetHex);
			if (!targetHex || !targetHex.unitId) {
				return failMove(nextState, m, "invalid_move", "Target missing.");
			}
			const defender = getUnit(nextState, targetHex.unitId);
			if (!defender) {
				return failMove(nextState, m, "invalid_move", "Defender missing.");
			}

			const attackerFrom = { ...attacker.position };
			const defenderId = defender.id;

			const attackPower = config.unitStats[attacker.type].attack;
			let defensePower = config.unitStats[defender.type].defense;
			const defenseBonus = config.terrainDefenseBonus[targetHex.type];
			defensePower += defenseBonus;
			if (defender.isFortified) defensePower += 1;
			// Phase 2 abilities intentionally omitted (charge, adjacency, archer melee vuln).

			const dist = distance(attacker.position, defender.position) ?? 0;
			const ranged = dist > 1;

			let attackerSurvives = true;
			let defenderSurvives = true;
			let captured = false;

			if (attackPower > defensePower) {
				defenderSurvives = false;
				if (!ranged) {
					captured = true;
				}
			} else if (attackPower === defensePower) {
				attackerSurvives = false;
				defenderSurvives = false;
				setHexControl(nextState, defender.position, null);
			} else {
				attackerSurvives = false;
			}

			if (!defenderSurvives) {
				removeUnit(nextState, defender.id);
			}
			if (!attackerSurvives) {
				removeUnit(nextState, attacker.id);
			} else if (captured) {
				moveUnit(nextState, attacker, defender.position, dist);
			}

			engineEvents.push({
				type: "attack",
				turn: nextState.turn,
				player: side,
				attackerId: attacker.id,
				attackerFrom,
				defenderId,
				targetHex: m.targetHex,
				distance: dist,
				ranged,
				outcome: {
					attacker: attackerSurvives ? "survives" : "dies",
					defender: defenderSurvives ? "survives" : "dies",
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
			unit.isFortified = true;
			engineEvents.push({
				type: "fortify",
				turn: nextState.turn,
				player: side,
				unitId: unit.id,
				at: { ...unit.position },
			});
			break;
		}
		case "pass":
			break;
	}

	if (m.action === "pass") {
		nextState.actionsRemaining = 0;
	} else {
		nextState.actionsRemaining = Math.max(0, nextState.actionsRemaining - 1);
	}

	recalculateDerived(nextState);

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

	const turnEnded = m.action === "pass" || nextState.actionsRemaining <= 0;
	if (turnEnded) {
		const controlChanges = applyControlUpdate(nextState);
		if (controlChanges.length > 0) {
			engineEvents.push({
				type: "control_update",
				turn: nextState.turn,
				changes: controlChanges,
			});
		}
		engineEvents.push({ type: "turn_end", turn: nextState.turn, player: side });

		nextState.activePlayer = otherSide(side);
		nextState.turn += 1;
		nextState.actionsRemaining = config.actionsPerTurn;

		const limitTerminal = computeTurnLimitTerminal(nextState);
		if (limitTerminal.ended) {
			nextState.status = "ended";
			engineEvents.push({
				type: "game_end",
				turn: nextState.turn,
				winner: limitTerminal.winner,
				reason: limitTerminal.reason,
			});
		}
	}

	return { ok: true, state: nextState, engineEvents };
}

export function renderAscii(state: MatchState): string {
	const lines: string[] = [];
	lines.push("    1    2    3    4    5    6    7");
	for (let row = 0; row < BOARD_SIZE; row++) {
		const rowLabel = String.fromCharCode(65 + row);
		const cells: string[] = [];
		for (let col = 0; col < BOARD_SIZE; col++) {
			const coord = toCoord(row, col);
			const hex = getHex(state, coord);
			if (!hex) {
				cells.push("??");
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
				: hex.type === "capital"
					? "C"
					: hex.type === "gold_mine"
						? "G"
						: hex.type === "tower"
							? "T"
							: ".";
			cells.push(`${owner}.${content}`);
		}
		lines.push(`${rowLabel}  ${cells.join(" ")}`);
	}
	lines.push("");
	lines.push(
		"Legend: A/B=control or unit owner, i=infantry, c=cavalry, a=archer",
	);
	lines.push("        C=capital, G=gold, T=tower, .=plains");
	return lines.join("\n");
}

function mergeConfig(input?: EngineConfigInput): EngineConfig {
	const config: EngineConfig = {
		...DEFAULT_CONFIG,
		...input,
		unitStats: { ...DEFAULT_CONFIG.unitStats, ...input?.unitStats },
		hexIncome: { ...DEFAULT_CONFIG.hexIncome, ...input?.hexIncome },
		terrainDefenseBonus: {
			...DEFAULT_CONFIG.terrainDefenseBonus,
			...input?.terrainDefenseBonus,
		},
		abilities: { ...DEFAULT_CONFIG.abilities, ...input?.abilities },
		victory: { ...DEFAULT_CONFIG.victory, ...input?.victory },
		boardLayout: input?.boardLayout
			? normalizeBoardLayout(input.boardLayout)
			: DEFAULT_CONFIG.boardLayout,
	};
	if (config.boardSize !== BOARD_SIZE) {
		throw new Error("Only 7x7 boards are supported in MVP.");
	}
	return config;
}

function resolveConfig(state: MatchState): EngineConfig {
	return state.config ?? DEFAULT_CONFIG;
}

function cloneState(state: MatchState): MatchState {
	return {
		...state,
		players: {
			A: {
				...state.players.A,
				units: state.players.A.units.map((u) => ({
					...u,
					position: { ...u.position },
				})),
			},
			B: {
				...state.players.B,
				units: state.players.B.units.map((u) => ({
					...u,
					position: { ...u.position },
				})),
			},
		},
		board: state.board.map((h) => ({
			...h,
			coord: { ...h.coord },
		})),
	};
}

function cloneBoard(layout: HexState[]): HexState[] {
	return normalizeBoardLayout(layout);
}

function buildDefaultBoardLayout(): HexState[] {
	const board: HexState[] = [];
	for (let row = 0; row < BOARD_SIZE; row++) {
		for (let col = 0; col < BOARD_SIZE; col++) {
			board.push({
				coord: toCoord(row, col),
				type: "plains",
				controlledBy: null,
				unitId: null,
			});
		}
	}

	const specials: Array<{
		label: string;
		type: HexType;
		controlledBy?: PlayerSide;
	}> = [
		{ label: "A1", type: "capital", controlledBy: "A" },
		{ label: "G7", type: "capital", controlledBy: "B" },
		{ label: "B4", type: "gold_mine" },
		{ label: "C6", type: "gold_mine" },
		{ label: "D2", type: "gold_mine" },
		{ label: "F2", type: "gold_mine" },
		{ label: "A3", type: "tower" },
		{ label: "C1", type: "tower" },
		{ label: "D4", type: "tower" },
		{ label: "D7", type: "tower" },
		{ label: "G5", type: "tower" },
	];

	for (const spec of specials) {
		const coord = labelToCoord(spec.label);
		const idx = indexFromCoord(coord);
		const existing = board[idx];
		if (!existing) continue;
		board[idx] = {
			...existing,
			type: spec.type,
			controlledBy: spec.controlledBy ?? existing.controlledBy,
		};
	}

	return board;
}

function normalizeBoardLayout(layout: HexState[]): HexState[] {
	const map = new Map<string, HexState>();
	for (const hex of layout) {
		if (isValidCoord(hex.coord)) {
			map.set(coordKey(hex.coord), {
				coord: { ...hex.coord },
				type: hex.type,
				controlledBy: hex.controlledBy ?? null,
				unitId: hex.unitId ?? null,
			});
		}
	}
	const board: HexState[] = [];
	for (let row = 0; row < BOARD_SIZE; row++) {
		for (let col = 0; col < BOARD_SIZE; col++) {
			const coord = toCoord(row, col);
			const key = coordKey(coord);
			const existing = map.get(key);
			board.push(
				existing ?? {
					coord,
					type: "plains",
					controlledBy: null,
					unitId: null,
				},
			);
		}
	}
	return board;
}

function labelToCoord(label: string): HexCoord {
	const rowChar = label[0];
	if (!rowChar) throw new Error("Invalid coord label.");
	const colStr = label.slice(1);
	const row = rowChar.toUpperCase().charCodeAt(0) - 65;
	const col = Number(colStr) - 1;
	return toCoord(row, col);
}

function toRowCol(coord: HexCoord): { row: number; col: number } {
	return { row: coord.r + 3, col: coord.q + 3 };
}

function toCoord(row: number, col: number): HexCoord {
	return { q: col - 3, r: row - 3 };
}

function isValidCoord(coord: HexCoord): boolean {
	const { row, col } = toRowCol(coord);
	return row >= 0 && row < BOARD_SIZE && col >= 0 && col < BOARD_SIZE;
}

function indexFromCoord(coord: HexCoord): number {
	const { row, col } = toRowCol(coord);
	return row * BOARD_SIZE + col;
}

function coordKey(coord: HexCoord): string {
	return `${coord.q},${coord.r}`;
}

function neighbors(coord: HexCoord): HexCoord[] {
	const { row, col } = toRowCol(coord);
	const deltas: ReadonlyArray<readonly [number, number]> =
		row % 2 === 0
			? ([
					[1, 0],
					[0, 1],
					[-1, 1],
					[-1, 0],
					[-1, -1],
					[0, -1],
				] as const)
			: ([
					[1, 0],
					[1, 1],
					[0, 1],
					[-1, 0],
					[0, -1],
					[1, -1],
				] as const);
	const result: HexCoord[] = [];
	for (const [dc, dr] of deltas) {
		const nr = row + dr;
		const nc = col + dc;
		if (nr >= 0 && nr < BOARD_SIZE && nc >= 0 && nc < BOARD_SIZE) {
			result.push(toCoord(nr, nc));
		}
	}
	return result;
}

function distance(start: HexCoord, target: HexCoord): number | null {
	return bfsDistance(start, target, undefined);
}

function pathDistance(
	start: HexCoord,
	target: HexCoord,
	blocked?: Set<string>,
): number | null {
	return bfsDistance(start, target, blocked);
}

function bfsDistance(
	start: HexCoord,
	target: HexCoord,
	blocked?: Set<string>,
): number | null {
	if (!isValidCoord(start) || !isValidCoord(target)) return null;
	const startKey = coordKey(start);
	const targetKey = coordKey(target);
	if (startKey === targetKey) return 0;

	const queue: Array<{ coord: HexCoord; dist: number }> = [
		{ coord: start, dist: 0 },
	];
	const seen = new Set<string>([startKey]);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		for (const n of neighbors(current.coord)) {
			const key = coordKey(n);
			if (seen.has(key)) continue;
			if (blocked && blocked.has(key)) continue;
			if (key === targetKey) {
				return current.dist + 1;
			}
			seen.add(key);
			queue.push({ coord: n, dist: current.dist + 1 });
		}
	}
	return null;
}

function reachableCoords(
	start: HexCoord,
	range: number,
	blocked: Set<string>,
): HexCoord[] {
	const results: HexCoord[] = [];
	const queue: Array<{ coord: HexCoord; dist: number }> = [
		{ coord: start, dist: 0 },
	];
	const seen = new Set<string>([coordKey(start)]);
	while (queue.length > 0) {
		const current = queue.shift();
		if (!current) break;
		for (const n of neighbors(current.coord)) {
			const key = coordKey(n);
			if (seen.has(key)) continue;
			if (blocked.has(key)) continue;
			const nextDist = current.dist + 1;
			if (nextDist > range) continue;
			seen.add(key);
			queue.push({ coord: n, dist: nextDist });
			results.push(n);
		}
	}
	return results;
}

function getHex(state: MatchState, coord: HexCoord): HexState | null {
	if (!isValidCoord(coord)) return null;
	return state.board[indexFromCoord(coord)] ?? null;
}

function setHexControl(
	state: MatchState,
	coord: HexCoord,
	owner: PlayerSide | null,
) {
	const idx = indexFromCoord(coord);
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, controlledBy: owner };
}

function setHexUnit(state: MatchState, coord: HexCoord, unitId: string | null) {
	const idx = indexFromCoord(coord);
	const existing = state.board[idx];
	if (!existing) return;
	state.board[idx] = { ...existing, unitId };
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

function removeUnit(state: MatchState, unitId: string) {
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

function moveUnit(state: MatchState, unit: Unit, to: HexCoord, dist: number) {
	setHexUnit(state, unit.position, null);
	unit.position = to;
	unit.movedThisTurn = true;
	unit.movedDistance = dist;
	setHexUnit(state, unit.position, unit.id);
}

function buildOccupiedSet(state: MatchState): Set<string> {
	const occupied = new Set<string>();
	for (const side of PLAYER_SIDES) {
		for (const unit of state.players[side].units) {
			occupied.add(coordKey(unit.position));
		}
	}
	return occupied;
}

function otherSide(side: PlayerSide): PlayerSide {
	return side === "A" ? "B" : "A";
}

function sortUnits(units: Unit[]): Unit[] {
	return [...units].sort((a, b) => a.id.localeCompare(b.id));
}

function sortCoords(coords: HexCoord[]): HexCoord[] {
	return [...coords].sort((a, b) => a.r - b.r || a.q - b.q);
}

function clearFortify(state: MatchState, side: PlayerSide) {
	for (const unit of state.players[side].units) {
		unit.isFortified = false;
		unit.movedThisTurn = false;
		unit.movedDistance = 0;
	}
}

function calculateIncome(state: MatchState, side: PlayerSide): number {
	const config = resolveConfig(state);
	let total = 0;
	for (const hex of state.board) {
		if (hex.controlledBy === side) {
			total += config.hexIncome[hex.type];
		}
	}
	return total;
}

function recalculateDerived(state: MatchState) {
	const config = resolveConfig(state);
	for (const side of PLAYER_SIDES) {
		state.players[side].supply = state.players[side].units.length;
		let towers = 0;
		for (const hex of state.board) {
			if (hex.type === "tower" && hex.controlledBy === side) towers += 1;
		}
		state.players[side].supplyCap = config.baseSupplyCap + towers;
	}
}

function computeImmediateTerminal(state: MatchState): TerminalState {
	const capitalA = getHex(state, CAPITAL_COORDS.A);
	const capitalB = getHex(state, CAPITAL_COORDS.B);

	if (capitalA?.unitId) {
		const unit = getUnit(state, capitalA.unitId);
		if (unit && unit.owner === "B") {
			return {
				ended: true,
				winner: state.players.B.id,
				reason: "capital_capture",
			};
		}
	}
	if (capitalB?.unitId) {
		const unit = getUnit(state, capitalB.unitId);
		if (unit && unit.owner === "A") {
			return {
				ended: true,
				winner: state.players.A.id,
				reason: "capital_capture",
			};
		}
	}

	const aUnits = state.players.A.units.length;
	const bUnits = state.players.B.units.length;
	if (aUnits === 0 && bUnits === 0) {
		return { ended: true, winner: null, reason: "draw" };
	}
	if (aUnits === 0 && bUnits > 0) {
		return { ended: true, winner: state.players.B.id, reason: "elimination" };
	}
	if (bUnits === 0 && aUnits > 0) {
		return { ended: true, winner: state.players.A.id, reason: "elimination" };
	}

	return { ended: false };
}

function computeTurnLimitTerminal(state: MatchState): TerminalState {
	const config = resolveConfig(state);
	if (state.turn <= config.victory.turnLimit) return { ended: false };

	const scoreA = scorePlayer(state, "A");
	const scoreB = scorePlayer(state, "B");

	if (scoreA.controlled !== scoreB.controlled) {
		return {
			ended: true,
			winner:
				scoreA.controlled > scoreB.controlled
					? state.players.A.id
					: state.players.B.id,
			reason: "turn_limit",
		};
	}
	if (scoreA.unitValue !== scoreB.unitValue) {
		return {
			ended: true,
			winner:
				scoreA.unitValue > scoreB.unitValue
					? state.players.A.id
					: state.players.B.id,
			reason: "turn_limit",
		};
	}
	if (scoreA.gold !== scoreB.gold) {
		return {
			ended: true,
			winner:
				scoreA.gold > scoreB.gold ? state.players.A.id : state.players.B.id,
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

function scorePlayer(state: MatchState, side: PlayerSide) {
	const config = resolveConfig(state);
	let controlled = 0;
	for (const hex of state.board) {
		if (hex.controlledBy === side) controlled += 1;
	}
	let unitValue = 0;
	for (const unit of state.players[side].units) {
		unitValue += config.unitStats[unit.type].cost;
	}
	return { controlled, unitValue, gold: state.players[side].gold };
}

function applyControlUpdate(
	state: MatchState,
): { coord: HexCoord; from: PlayerSide | null; to: PlayerSide | null }[] {
	const changes: {
		coord: HexCoord;
		from: PlayerSide | null;
		to: PlayerSide | null;
	}[] = [];
	for (const hex of state.board) {
		if (hex.unitId) {
			const unit = getUnit(state, hex.unitId);
			const nextOwner = unit ? unit.owner : hex.controlledBy;
			if (nextOwner !== hex.controlledBy) {
				changes.push({
					coord: hex.coord,
					from: hex.controlledBy,
					to: nextOwner,
				});
				hex.controlledBy = nextOwner;
			}
		}
	}
	if (changes.length > 0) {
		recalculateDerived(state);
	}
	return sortControlChanges(changes);
}

function sortControlChanges(
	changes: {
		coord: HexCoord;
		from: PlayerSide | null;
		to: PlayerSide | null;
	}[],
) {
	return [...changes].sort(
		(a, b) => a.coord.r - b.coord.r || a.coord.q - b.coord.q,
	);
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

// Spectator/SSE schema (unchanged contract)
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
