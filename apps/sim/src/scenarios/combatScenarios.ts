import { Engine } from "../engineAdapter";
import type { AgentId, MatchState } from "../types";

/**
 * Creates a match state with units already positioned for immediate combat.
 * This bypasses the "movement phase" and tests actual combat decisions.
 */
export function createCombatScenario(
	seed: number,
	players: AgentId[],
	scenario: "melee" | "ranged" | "stronghold_rush" | "midfield" = "melee",
): MatchState {
	// Start with normal initial state
	const state = Engine.createInitialState(seed, players);

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
	const unit = {
		id: unitId,
		type: unitType,
		owner,
		position,
		hp: unitType === "infantry" ? 3 : 2,
		maxHp: unitType === "infantry" ? 3 : 2,
		isFortified: false,
		movedThisTurn: false,
		movedDistance: 0,
		attackedThisTurn: false,
		canActThisTurn: true,
	};

	state.players[owner].units.push(unit as Unit);

	// Add to board
	const hex = state.board.find((h) => h.id === position);
	if (hex) {
		hex.unitIds.push(unitId);
	}
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
