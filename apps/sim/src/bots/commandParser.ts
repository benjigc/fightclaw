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
	| { action: "upgrade"; unitId: string }
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
 *   ParsedCommand.unitId  ->  Move.unitId   (for "fortify"/"upgrade")
 */
export function matchCommand(
	cmd: ParsedCommand,
	legalMoves: Move[],
): Move | null {
	const normalizedCmd = normalizeParsedCommand(cmd);

	for (const move of legalMoves) {
		if (normalizeAction(move.action) !== normalizedCmd.action) continue;

		switch (normalizedCmd.action) {
			case "move": {
				const m = move as Extract<Move, { action: "move" }>;
				if (
					normalizeValue(m.unitId) === normalizeValue(normalizedCmd.unitId) &&
					normalizeValue(m.to) === normalizeValue(normalizedCmd.target)
				) {
					return move;
				}
				break;
			}
			case "attack": {
				const m = move as Extract<Move, { action: "attack" }>;
				if (
					normalizeValue(m.unitId) === normalizeValue(normalizedCmd.unitId) &&
					normalizeValue(m.target) === normalizeValue(normalizedCmd.target)
				) {
					return move;
				}
				break;
			}
			case "recruit": {
				const m = move as Extract<Move, { action: "recruit" }>;
				if (
					normalizeValue(m.unitType) ===
						normalizeValue(normalizedCmd.unitType) &&
					normalizeValue(m.at) === normalizeValue(normalizedCmd.target)
				) {
					return move;
				}
				break;
			}
			case "fortify": {
				const m = move as Extract<Move, { action: "fortify" }>;
				if (normalizeValue(m.unitId) === normalizeValue(normalizedCmd.unitId))
					return move;
				break;
			}
			case "upgrade": {
				const m = move as Extract<Move, { action: "upgrade" }>;
				if (normalizeValue(m.unitId) === normalizeValue(normalizedCmd.unitId))
					return move;
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
		const line = normalizeCommandLine(raw);
		// Skip blank lines and comments
		if (line === "" || line.startsWith("#")) continue;

		const parts = line.split(/\s+/);
		const action = (parts[0] ?? "").toLowerCase();

		switch (action) {
			case "move": {
				const unitId = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitId && target) {
					results.push({ action: "move", unitId, target });
				}
				break;
			}
			case "attack": {
				const unitId = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitId && target) {
					results.push({ action: "attack", unitId, target });
				}
				break;
			}
			case "recruit": {
				const unitType = cleanToken(parts[1]);
				const target = cleanToken(parts[2]);
				if (unitType && target) {
					results.push({ action: "recruit", unitType, target });
				}
				break;
			}
			case "fortify": {
				const unitId = cleanToken(parts[1]);
				if (unitId) {
					results.push({ action: "fortify", unitId });
				}
				break;
			}
			case "upgrade": {
				const unitId = cleanToken(parts[1]);
				if (unitId) {
					results.push({ action: "upgrade", unitId });
				}
				break;
			}
			case "end": {
				const maybeTurn = (parts[1] ?? "").toLowerCase();
				if (maybeTurn === "turn") {
					results.push({ action: "end_turn" });
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

function normalizeCommandLine(raw: string): string {
	return raw
		.trim()
		.replace(/^\d+[).:-]?\s+/, "")
		.replace(/^[-*]\s+/, "")
		.replace(/^`+|`+$/g, "");
}

function cleanToken(token: string | undefined): string | undefined {
	if (!token) return undefined;
	const cleaned = token.replace(/[^A-Za-z0-9_-]/g, "");
	return cleaned.length > 0 ? cleaned : undefined;
}

function normalizeParsedCommand(cmd: ParsedCommand): ParsedCommand {
	switch (cmd.action) {
		case "move":
			return {
				action: "move",
				unitId: normalizeValue(cmd.unitId),
				target: normalizeValue(cmd.target),
			};
		case "attack":
			return {
				action: "attack",
				unitId: normalizeValue(cmd.unitId),
				target: normalizeValue(cmd.target),
			};
		case "recruit":
			return {
				action: "recruit",
				unitType: normalizeValue(cmd.unitType),
				target: normalizeValue(cmd.target),
			};
		case "fortify":
			return { action: "fortify", unitId: normalizeValue(cmd.unitId) };
		case "upgrade":
			return { action: "upgrade", unitId: normalizeValue(cmd.unitId) };
		case "end_turn":
			return cmd;
	}
}

function normalizeAction(action: string): string {
	const lower = action.toLowerCase();
	return lower === "pass" ? "end_turn" : lower;
}

function normalizeValue(value: string): string;
function normalizeValue(value: string | undefined): string | undefined;
function normalizeValue(value: string | undefined): string | undefined {
	return value?.toLowerCase();
}
