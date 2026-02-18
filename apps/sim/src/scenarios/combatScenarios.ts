import type { ScenarioName } from "../boardgameio/types";
import { Engine } from "../engineAdapter";
import type { AgentId, EngineConfigInput, MatchState } from "../types";

const BOARD_17_CANONICAL_COL_MAP = [
	0, 1, 2, 3, 4, 5, 6, 7, 10, 13, 14, 15, 16, 17, 18, 19, 20,
] as const;

/**
 * Creates a match state with units already positioned for immediate combat.
 * This bypasses the "movement phase" and tests actual combat decisions.
 */
export function createCombatScenario(
	seed: number,
	players: AgentId[],
	scenario: ScenarioName = "melee",
	engineConfig?: EngineConfigInput,
): MatchState {
	// Start with normal initial state
	const state = Engine.createInitialState(seed, players, engineConfig);

	// Clear existing units
	state.players.A.units = [];
	state.players.B.units = [];
	state.board.forEach((hex) => {
		hex.unitIds = [];
	});

	switch (scenario) {
		case "melee":
			// Both sides positioned for immediate melee combat
			// Units are 1-2 hexes apart, can attack on turn 1
			addUnitToState(state, "A-1", "infantry", "A", "F9");
			addUnitToState(state, "A-2", "cavalry", "A", "G9");
			addUnitToState(state, "A-3", "archer", "A", "E9");
			addUnitToState(state, "B-1", "infantry", "B", "G10");
			addUnitToState(state, "B-2", "cavalry", "B", "F10");
			addUnitToState(state, "B-3", "archer", "B", "H10");
			break;

		case "ranged":
			// Archer standoff - tests range-2 attacks
			addUnitToState(state, "A-1", "archer", "A", "F8");
			addUnitToState(state, "A-2", "archer", "A", "G8");
			addUnitToState(state, "B-1", "infantry", "B", "F11");
			addUnitToState(state, "B-2", "cavalry", "B", "G11");
			break;

		case "stronghold_rush":
			// One side about to capture the stronghold
			// Tests decisive end-game decisions
			addUnitToState(state, "A-1", "cavalry", "A", "C3"); // Near B's stronghold
			addUnitToState(state, "A-2", "infantry", "A", "C2");
			addUnitToState(state, "B-1", "cavalry", "B", "B20"); // Defending
			break;

		case "midfield":
			// Full armies positioned in the center for immediate engagement
			// A front line at col 10, B front line at col 11 — directly adjacent
			addUnitToState(state, "A-1", "infantry", "A", "D10");
			addUnitToState(state, "A-2", "infantry", "A", "E10");
			addUnitToState(state, "A-3", "infantry", "A", "F10");
			addUnitToState(state, "A-4", "cavalry", "A", "D9");
			addUnitToState(state, "A-5", "cavalry", "A", "F9");
			addUnitToState(state, "A-6", "archer", "A", "E9");

			addUnitToState(state, "B-1", "infantry", "B", "D11");
			addUnitToState(state, "B-2", "infantry", "B", "E11");
			addUnitToState(state, "B-3", "infantry", "B", "F11");
			addUnitToState(state, "B-4", "cavalry", "B", "D12");
			addUnitToState(state, "B-5", "cavalry", "B", "F12");
			addUnitToState(state, "B-6", "archer", "B", "E12");
			break;

		case "all_infantry":
			addCompositionStaggered(state, "infantry", "infantry");
			break;
		case "all_cavalry":
			addCompositionBlitz(state, "cavalry", "cavalry");
			break;
		case "all_archer":
			addCompositionFrontline(state, "archer", "archer");
			break;
		case "infantry_archer":
			addCompositionFrontline(state, "infantry", "archer");
			break;
		case "cavalry_archer":
			addCompositionFrontline(state, "cavalry", "archer");
			break;
		case "infantry_cavalry":
			addCompositionFrontline(state, "infantry", "cavalry");
			break;
	}

	return state;
}

function addUnitToState(
	state: MatchState,
	unitId: string,
	unitType: "infantry" | "cavalry" | "archer",
	owner: "A" | "B",
	position: string,
) {
	let resolvedPosition = resolveScenarioHex(state, position);
	let hex = state.board.find((h) => h.id === resolvedPosition);
	if (!hex) return;
	if (hex.unitIds.length > 0) {
		const relocated = findNearestEmptyInRow(state, resolvedPosition);
		if (!relocated) return;
		resolvedPosition = relocated;
		hex = state.board.find((h) => h.id === resolvedPosition);
		if (!hex) return;
	}

	const unit = {
		id: unitId,
		type: unitType,
		owner,
		position: resolvedPosition,
		hp: unitType === "infantry" ? 3 : 2,
		maxHp: unitType === "infantry" ? 3 : 2,
		isFortified: false,
		movedThisTurn: false,
		movedDistance: 0,
		attackedThisTurn: false,
		canActThisTurn: true,
	};

	state.players[owner].units.push(unit as Unit);
	hex.unitIds.push(unitId);
}

function resolveScenarioHex(state: MatchState, requested: string): string {
	const match = /^([A-I])(\d+)$/.exec(requested);
	if (!match) return requested;
	const row = match[1];
	const canonicalCol = Number.parseInt(match[2] ?? "", 10) - 1;
	if (!Number.isFinite(canonicalCol) || canonicalCol < 0) return requested;

	const cols = boardColumns(state);
	if (cols !== 17) return requested;

	const map = BOARD_17_CANONICAL_COL_MAP as readonly number[];
	const exact = map.indexOf(canonicalCol);
	if (exact >= 0) return `${row}${exact + 1}`;

	let nearestIndex = 0;
	let nearestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < map.length; i++) {
		const distance = Math.abs(map[i]! - canonicalCol);
		if (distance < nearestDistance) {
			nearestDistance = distance;
			nearestIndex = i;
		}
	}
	return `${row}${nearestIndex + 1}`;
}

function boardColumns(state: MatchState): number {
	return Math.floor(state.board.length / 9);
}

function findNearestEmptyInRow(
	state: MatchState,
	position: string,
): string | undefined {
	const match = /^([A-I])(\d+)$/.exec(position);
	if (!match) return undefined;
	const row = match[1];
	const col = Number.parseInt(match[2] ?? "", 10);
	if (!Number.isFinite(col) || col < 1) return undefined;

	const cols = boardColumns(state);
	const isEmpty = (candidateCol: number) => {
		const id = `${row}${candidateCol}`;
		const hex = state.board.find((h) => h.id === id);
		return hex ? hex.unitIds.length === 0 : false;
	};
	if (isEmpty(col)) return `${row}${col}`;

	for (let d = 1; d < cols; d++) {
		const right = col + d;
		if (right <= cols && isEmpty(right)) return `${row}${right}`;
		const left = col - d;
		if (left >= 1 && isEmpty(left)) return `${row}${left}`;
	}
	return undefined;
}

// Type augmentation
interface Unit {
	id: string;
	type: "infantry" | "cavalry" | "archer";
	owner: "A" | "B";
	position: string;
	hp: number;
	maxHp: number;
	isFortified: boolean;
	movedThisTurn: boolean;
	movedDistance: number;
	attackedThisTurn: boolean;
	canActThisTurn: boolean;
}

function addCompositionFrontline(
	state: MatchState,
	aType: "infantry" | "cavalry" | "archer",
	bType: "infantry" | "cavalry" | "archer",
) {
	addUnitToState(state, "A-1", aType, "A", "D10");
	addUnitToState(state, "A-2", aType, "A", "E10");
	addUnitToState(state, "A-3", aType, "A", "F10");
	addUnitToState(state, "A-4", aType, "A", "D9");
	addUnitToState(state, "A-5", aType, "A", "E9");
	addUnitToState(state, "A-6", aType, "A", "F9");

	addUnitToState(state, "B-1", bType, "B", "D11");
	addUnitToState(state, "B-2", bType, "B", "E11");
	addUnitToState(state, "B-3", bType, "B", "F11");
	addUnitToState(state, "B-4", bType, "B", "D12");
	addUnitToState(state, "B-5", bType, "B", "E12");
	addUnitToState(state, "B-6", bType, "B", "F12");
}

function addCompositionStaggered(
	state: MatchState,
	aType: "infantry" | "cavalry" | "archer",
	bType: "infantry" | "cavalry" | "archer",
) {
	// Wider standoff and backline stagger increase setup/positioning turns.
	addUnitToState(state, "A-1", aType, "A", "C8");
	addUnitToState(state, "A-2", aType, "A", "E8");
	addUnitToState(state, "A-3", aType, "A", "G8");
	addUnitToState(state, "A-4", aType, "A", "D7");
	addUnitToState(state, "A-5", aType, "A", "E7");
	addUnitToState(state, "A-6", aType, "A", "F7");

	addUnitToState(state, "B-1", bType, "B", "C13");
	addUnitToState(state, "B-2", bType, "B", "E13");
	addUnitToState(state, "B-3", bType, "B", "G13");
	addUnitToState(state, "B-4", bType, "B", "D14");
	addUnitToState(state, "B-5", bType, "B", "E14");
	addUnitToState(state, "B-6", bType, "B", "F14");
}

function addCompositionBlitz(
	state: MatchState,
	aType: "infantry" | "cavalry" | "archer",
	bType: "infantry" | "cavalry" | "archer",
) {
	// Tight contact lanes create early trades and a faster tempo profile.
	addUnitToState(state, "A-1", aType, "A", "D9");
	addUnitToState(state, "A-2", aType, "A", "E9");
	addUnitToState(state, "A-3", aType, "A", "F9");
	addUnitToState(state, "A-4", aType, "A", "D8");
	addUnitToState(state, "A-5", aType, "A", "E8");
	addUnitToState(state, "A-6", aType, "A", "F8");

	addUnitToState(state, "B-1", bType, "B", "D10");
	addUnitToState(state, "B-2", bType, "B", "E10");
	addUnitToState(state, "B-3", bType, "B", "F10");
	addUnitToState(state, "B-4", bType, "B", "D11");
	addUnitToState(state, "B-5", bType, "B", "E11");
	addUnitToState(state, "B-6", bType, "B", "F11");
}
