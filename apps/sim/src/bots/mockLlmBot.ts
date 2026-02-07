import * as fs from "node:fs";
import * as path from "node:path";
import { pickOne } from "../rng";
import type { Bot, Move } from "../types";

/** Configuration for mock LLM bot */
export interface MockLlmConfig {
	/** Inline prompt instructions (e.g., "Always attack first") */
	inline?: string;
	/** Path to JSON file with prompt config */
	file?: string;
	/** Strategy pattern: aggressive, defensive, random, strategic */
	strategy?: "aggressive" | "defensive" | "random" | "strategic";
}

/** File-based prompt config */
interface PromptFileConfig {
	botId: string;
	inline?: string;
	strategy?: "aggressive" | "defensive" | "random" | "strategic";
}

function loadPromptFromFile(filePath: string): PromptFileConfig {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const content = fs.readFileSync(absolutePath, "utf-8");
	return JSON.parse(content) as PromptFileConfig;
}

const actionScores: Record<string, Record<Move["action"], number>> = {
	aggressive: {
		attack: 100,
		move: 50,
		recruit: 25,
		fortify: -100,
		end_turn: -50,
		pass: -50,
	},
	defensive: {
		fortify: 100,
		recruit: 75,
		move: -25,
		attack: -50,
		end_turn: 0,
		pass: 0,
	},
	balanced: {
		recruit: 60,
		move: 50,
		attack: 40,
		fortify: 30,
		end_turn: 10,
		pass: 10,
	},
};

/**
 * Score a move based on strategy and optional prompt instructions.
 * The "strategic" mode parses prompt text to bias move selection,
 * simulating how real LLM agents interpret prompt instructions.
 */
function scoreMoveForStrategy(
	move: Move,
	strategy: "aggressive" | "defensive" | "random" | "strategic",
	promptInstructions?: string,
): number {
	if (strategy === "random") return 0;

	if (strategy === "aggressive")
		return actionScores.aggressive[move.action] ?? 0;
	if (strategy === "defensive") return actionScores.defensive[move.action] ?? 0;

	// "strategic" — parse prompt instructions to boost matching actions
	if (promptInstructions) {
		const lower = promptInstructions.toLowerCase();
		if (lower.includes("attack") && move.action === "attack") return 100;
		if (lower.includes("defend") && move.action === "fortify") return 100;
		if (lower.includes("recruit") && move.action === "recruit") return 100;
		if (lower.includes("move") && move.action === "move") return 75;
		if (lower.includes("fortify") && move.action === "fortify") return 80;
	}

	// Default balanced scoring
	return actionScores.balanced[move.action] ?? 0;
}

/**
 * Create a mock LLM bot that simulates prompt-driven strategy selection.
 *
 * This is key for testing game balance: by varying the prompt instructions
 * and strategies across thousands of matches, we can detect whether any
 * single strategy dominates or whether diverse approaches are viable.
 */
export function makeMockLlmBot(id: string, config: MockLlmConfig = {}): Bot {
	let fileConfig: PromptFileConfig | null = null;
	if (config.file) {
		fileConfig = loadPromptFromFile(config.file);
	}

	const effectiveStrategy =
		config.strategy ?? fileConfig?.strategy ?? "strategic";
	const effectiveInline = config.inline ?? fileConfig?.inline;

	return {
		id,
		name: fileConfig?.botId ?? `MockLLM_${effectiveStrategy}`,
		chooseMove: async ({ legalMoves, rng }) => {
			if (effectiveStrategy === "random") {
				return pickOne(legalMoves, rng);
			}

			let bestScore = Number.NEGATIVE_INFINITY;
			let bestMoves: Move[] = [];

			for (const move of legalMoves) {
				const score = scoreMoveForStrategy(
					move,
					effectiveStrategy,
					effectiveInline,
				);
				if (score > bestScore) {
					bestScore = score;
					bestMoves = [move];
				} else if (score === bestScore) {
					bestMoves.push(move);
				}
			}

			return pickOne(bestMoves.length > 0 ? bestMoves : legalMoves, rng);
		},
	};
}
