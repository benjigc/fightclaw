/**
 * Compact state encoder for LLM consumption.
 *
 * Replaces verbose ASCII board + JSON dumps with a structured,
 * token-efficient format that conveys all necessary tactical information.
 */

import type { MatchState, Move } from "../types";

// ---------------------------------------------------------------------------
// Type abbreviations
// ---------------------------------------------------------------------------

const TYPE_ABBREV: Record<string, string> = {
	infantry: "inf",
	cavalry: "cav",
	archer: "arc",
	swordsman: "swd",
	knight: "kni",
	crossbow: "xbw",
};

// Terrain types to skip when listing terrain near units
const BORING_TERRAIN = new Set(["plains", "deploy_a", "deploy_b"]);

// Terrain display names (compact)
const TERRAIN_DISPLAY: Record<string, string> = {
	forest: "forest",
	hills: "hills",
	high_ground: "high_ground",
	gold_mine: "gold_mine",
	lumber_camp: "lumber_camp",
	crown: "crown",
	stronghold_a: "stronghold",
	stronghold_b: "stronghold",
};

// ---------------------------------------------------------------------------
// encodeMove — single move to CLI command string
// ---------------------------------------------------------------------------

export function encodeMove(move: Move): string {
	switch (move.action) {
		case "move":
			return `move ${move.unitId} ${move.to}`;
		case "attack":
			return `attack ${move.unitId} ${move.target}`;
		case "recruit":
			return `recruit ${move.unitType} ${move.at}`;
		case "fortify":
			return `fortify ${move.unitId}`;
		case "upgrade":
			return `upgrade ${move.unitId}`;
		case "end_turn":
			return "end_turn";
		case "pass":
			return "end_turn";
	}
}

// ---------------------------------------------------------------------------
// encodeState — full game state in compact notation
// ---------------------------------------------------------------------------

export function encodeState(
	state: MatchState,
	side: "A" | "B",
	lastEnemyMoves?: Move[],
): string {
	const enemySide = side === "A" ? "B" : "A";
	const player = state.players[side];
	const enemy = state.players[enemySide];

	const lines: string[] = [];

	// Header
	lines.push(
		`STATE turn=${state.turn} player=${side} actions=${state.actionsRemaining} gold=${player.gold} wood=${player.wood} vp=${player.vp}`,
	);
	lines.push(`ENEMY gold=${enemy.gold} wood=${enemy.wood} vp=${enemy.vp}`);
	lines.push("");

	// Build a hex lookup for quick terrain checks
	const hexMap = new Map<string, { type: string }>();
	for (const hex of state.board) {
		hexMap.set(hex.id, { type: hex.type });
	}

	// Units for the active side
	lines.push(`UNITS_${side}:`);
	const sortedFriendly = [...player.units].sort((a, b) =>
		a.id.localeCompare(b.id),
	);
	for (const unit of sortedFriendly) {
		const abbrev = TYPE_ABBREV[unit.type] ?? unit.type;
		let line = `  ${unit.id} ${abbrev} ${unit.position} hp=${unit.hp}/${unit.maxHp}`;
		if (unit.isFortified) {
			line += " fortified";
		}
		// Check if unit is on a stronghold
		const hex = hexMap.get(unit.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Units for the enemy side
	lines.push(`UNITS_${enemySide}:`);
	const sortedEnemy = [...enemy.units].sort((a, b) => a.id.localeCompare(b.id));
	for (const unit of sortedEnemy) {
		const abbrev = TYPE_ABBREV[unit.type] ?? unit.type;
		let line = `  ${unit.id} ${abbrev} ${unit.position} hp=${unit.hp}/${unit.maxHp}`;
		if (unit.isFortified) {
			line += " fortified";
		}
		const hex = hexMap.get(unit.position);
		if (hex && (hex.type === "stronghold_a" || hex.type === "stronghold_b")) {
			line += " [stronghold]";
		}
		lines.push(line);
	}
	lines.push("");

	// Terrain near units — only interesting terrain on hexes where units stand
	const terrainEntries: string[] = [];
	const allUnits = [...player.units, ...enemy.units];
	const seenPositions = new Set<string>();
	for (const unit of allUnits) {
		if (seenPositions.has(unit.position)) continue;
		seenPositions.add(unit.position);
		const hex = hexMap.get(unit.position);
		if (hex && !BORING_TERRAIN.has(hex.type)) {
			const display = TERRAIN_DISPLAY[hex.type] ?? hex.type;
			terrainEntries.push(`${unit.position}=${display}`);
		}
	}
	if (terrainEntries.length > 0) {
		lines.push("TERRAIN_NEAR_UNITS:");
		lines.push(`  ${terrainEntries.join(" ")}`);
		lines.push("");
	}

	// Last enemy moves
	if (lastEnemyMoves && lastEnemyMoves.length > 0) {
		lines.push("LAST_ENEMY_TURN:");
		for (const move of lastEnemyMoves) {
			lines.push(`  ${encodeMove(move)}`);
		}
		lines.push("");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// encodeLegalMoves — categorize legal moves by action type
// ---------------------------------------------------------------------------

export function encodeLegalMoves(moves: Move[], state: MatchState): string {
	const attacks: string[] = [];
	const moveMoves: string[] = [];
	const recruits: string[] = [];
	const other: string[] = [];

	// Build a unit lookup by position for attack target info
	const unitsByPosition = new Map<
		string,
		{ id: string; type: string; hp: number; maxHp: number }
	>();
	for (const side of ["A", "B"] as const) {
		for (const unit of state.players[side].units) {
			// Store the first unit at each position (lead unit of stack)
			if (!unitsByPosition.has(unit.position)) {
				unitsByPosition.set(unit.position, {
					id: unit.id,
					type: unit.type,
					hp: unit.hp,
					maxHp: unit.maxHp,
				});
			}
		}
	}

	for (const move of moves) {
		switch (move.action) {
			case "attack": {
				const targetUnit = unitsByPosition.get(move.target);
				if (targetUnit) {
					const abbrev = TYPE_ABBREV[targetUnit.type] ?? targetUnit.type;
					attacks.push(
						`  attack ${move.unitId} ${move.target} (target: ${targetUnit.id} ${abbrev} hp=${targetUnit.hp}/${targetUnit.maxHp})`,
					);
				} else {
					attacks.push(`  attack ${move.unitId} ${move.target}`);
				}
				break;
			}
			case "move":
				moveMoves.push(`  move ${move.unitId} ${move.to}`);
				break;
			case "recruit":
				recruits.push(`  recruit ${move.unitType} ${move.at}`);
				break;
			case "end_turn":
			case "pass":
				other.push("  end_turn");
				break;
			case "fortify":
				other.push(`  fortify ${move.unitId}`);
				break;
			case "upgrade":
				other.push(`  upgrade ${move.unitId}`);
				break;
		}
	}

	const lines: string[] = [];
	lines.push("LEGAL_MOVES:");

	if (attacks.length > 0) {
		lines.push("ATTACKS:");
		lines.push(...attacks);
	}
	if (moveMoves.length > 0) {
		lines.push("MOVES:");
		lines.push(...moveMoves);
	}
	if (recruits.length > 0) {
		lines.push("RECRUIT:");
		lines.push(...recruits);
	}
	if (other.length > 0) {
		lines.push("OTHER:");
		lines.push(...other);
	}

	return lines.join("\n");
}
