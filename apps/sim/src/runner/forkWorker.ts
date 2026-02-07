/**
 * Fork-compatible worker script.
 * Runs as a child process via child_process.fork() — inherits tsx loader
 * from the parent's process.execArgv automatically.
 */
import { makeAggressiveBot } from "../bots/aggressiveBot";
import { makeGreedyBot } from "../bots/greedyBot";
import type { MockLlmConfig } from "../bots/mockLlmBot";
import { makeMockLlmBot } from "../bots/mockLlmBot";
import { makeRandomLegalBot } from "../bots/randomBot";
import { playMatch } from "../match";
import type { Bot, MatchResult } from "../types";

export interface BotConfig {
	id: string;
	name: string;
	type: "random" | "greedy" | "aggressive" | "mockllm";
	/** Mock LLM config (strategy + inline prompt), only used when type is "mockllm" */
	llmConfig?: MockLlmConfig;
}

interface BatchRequest {
	type: "run_batch";
	seeds: number[];
	maxTurns: number;
	botConfigs: BotConfig[];
}

interface BatchResponse {
	type: "batch_complete";
	results: MatchResult[];
}

interface ErrorResponse {
	type: "error";
	error: string;
}

interface ShutdownRequest {
	type: "shutdown";
}

type WorkerMessage = BatchRequest | ShutdownRequest;

function createBot(config: BotConfig): Bot {
	switch (config.type) {
		case "greedy":
			return makeGreedyBot(config.id);
		case "aggressive":
			return makeAggressiveBot(config.id);
		case "mockllm":
			return makeMockLlmBot(config.id, config.llmConfig);
		default:
			return makeRandomLegalBot(config.id);
	}
}

process.on("message", async (msg: WorkerMessage) => {
	if (msg.type === "shutdown") {
		process.exit(0);
	}

	if (msg.type === "run_batch") {
		try {
			const players = msg.botConfigs.map(createBot);
			const results: MatchResult[] = [];

			for (const seed of msg.seeds) {
				const result = await playMatch({
					seed,
					players,
					maxTurns: msg.maxTurns,
					verbose: false,
					record: false,
					autofixIllegal: true,
				});
				results.push(result);
			}

			process.send?.({
				type: "batch_complete",
				results,
			} satisfies BatchResponse);
		} catch (error) {
			process.send?.({
				type: "error",
				error: error instanceof Error ? error.message : String(error),
			} satisfies ErrorResponse);
		}
	}
});
