import type { Move } from "../types";

/**
 * Discriminated union of parsed CLI-style commands from LLM output.
 * These use a flat "target" field; matchCommand maps them to the
 * engine's Move shape (which uses "to", "target", or "at" depending
 * on the action).
 */
export type ParsedCommand =
	| { action: "move"; unitId: string; target: string }
	| { action: "attack"; unitId: string; target: string }
	| { action: "recruit"; unitType: string; target: string }
	| { action: "fortify"; unitId: string }
	| { action: "end_turn" };

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Parse multi-line CLI-style command text into an array of ParsedCommands.
 *
 * - Strips markdown code fences (``` ... ```)
 * - Truncates at a `---` separator (reasoning section)
 * - Skips blank lines and `# comment` lines
 * - Action names are case-insensitive
 * - `pass` is treated as `end_turn`
 */
export function parseCommands(text: string): ParsedCommand[] {
	const cleaned = stripCodeFences(text);
	const commandSection = splitAtSeparator(cleaned).commands;
	return parseLines(commandSection);
}

/**
 * Like parseCommands but also extracts the reasoning text after `---`.
 */
export function parseCommandsWithReasoning(text: string): {
	commands: ParsedCommand[];
	reasoning: string | undefined;
} {
	const cleaned = stripCodeFences(text);
	const { commands: commandSection, reasoning } = splitAtSeparator(cleaned);
	return {
		commands: parseLines(commandSection),
		reasoning,
	};
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/**
 * Match a ParsedCommand against the array of legal moves.
 * Returns the matching Move or null if no match is found.
 *
 * Field mapping:
 *   ParsedCommand.target  ->  Move.to      (for "move")
 *   ParsedCommand.target  ->  Move.target   (for "attack")
 *   ParsedCommand.target  ->  Move.at       (for "recruit")
 */
export function matchCommand(
	cmd: ParsedCommand,
	legalMoves: Move[],
): Move | null {
	for (const move of legalMoves) {
		if (move.action !== cmd.action) continue;

		switch (cmd.action) {
			case "move": {
				const m = move as Extract<Move, { action: "move" }>;
				if (m.unitId === cmd.unitId && m.to === cmd.target) return move;
				break;
			}
			case "attack": {
				const m = move as Extract<Move, { action: "attack" }>;
				if (m.unitId === cmd.unitId && m.target === cmd.target) return move;
				break;
			}
			case "recruit": {
				const m = move as Extract<Move, { action: "recruit" }>;
				if (m.unitType === cmd.unitType && m.at === cmd.target) return move;
				break;
			}
			case "fortify": {
				const m = move as Extract<Move, { action: "fortify" }>;
				if (m.unitId === cmd.unitId) return move;
				break;
			}
			case "end_turn": {
				return move;
			}
		}
	}
	return null;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Strip markdown code fences (``` or ```lang). */
function stripCodeFences(text: string): string {
	return text.replace(/^```[a-z]*\s*$/gm, "").trim();
}

/**
 * Split text at the first `---` line.
 * Returns the command portion and optional reasoning.
 */
function splitAtSeparator(text: string): {
	commands: string;
	reasoning: string | undefined;
} {
	const idx = text.indexOf("\n---");
	if (idx === -1) {
		return { commands: text, reasoning: undefined };
	}
	const commands = text.slice(0, idx);
	// Reasoning starts after "---\n"
	const afterSep = text.slice(idx + 1); // includes "---\n..."
	const reasoningStart = afterSep.indexOf("\n");
	if (reasoningStart === -1) {
		return { commands, reasoning: undefined };
	}
	const reasoning = afterSep.slice(reasoningStart + 1).trim();
	return {
		commands,
		reasoning: reasoning.length > 0 ? reasoning : undefined,
	};
}

/** Parse individual lines into ParsedCommands, skipping blanks/comments. */
function parseLines(text: string): ParsedCommand[] {
	const results: ParsedCommand[] = [];
	const lines = text.split("\n");

	for (const raw of lines) {
		const line = raw.trim();
		// Skip blank lines and comments
		if (line === "" || line.startsWith("#")) continue;

		const parts = line.split(/\s+/);
		const action = (parts[0] ?? "").toLowerCase();

		switch (action) {
			case "move": {
				const unitId = parts[1];
				const target = parts[2];
				if (unitId && target) {
					results.push({ action: "move", unitId, target });
				}
				break;
			}
			case "attack": {
				const unitId = parts[1];
				const target = parts[2];
				if (unitId && target) {
					results.push({ action: "attack", unitId, target });
				}
				break;
			}
			case "recruit": {
				const unitType = parts[1];
				const target = parts[2];
				if (unitType && target) {
					results.push({ action: "recruit", unitType, target });
				}
				break;
			}
			case "fortify": {
				const unitId = parts[1];
				if (unitId) {
					results.push({ action: "fortify", unitId });
				}
				break;
			}
			case "end_turn":
			case "pass": {
				results.push({ action: "end_turn" });
				break;
			}
			// Unknown actions are silently skipped
		}
	}

	return results;
}
