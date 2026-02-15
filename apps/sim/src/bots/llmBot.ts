import OpenAI from "openai";
import { getDiagnosticsCollector } from "../diagnostics/collector";
import {
	createOpenRouterClient,
	isOpenRouterBaseUrl,
	OPENROUTER_DEFAULT_BASE_URL,
} from "../llm/openrouter";
import type { Bot, MatchState, Move } from "../types";
import {
	matchCommand,
	type ParsedCommand,
	parseCommandsWithReasoning,
} from "./commandParser";
import { encodeLegalMoves, encodeState } from "./stateEncoder";

export interface LlmBotConfig {
	// e.g. "anthropic/claude-3.5-haiku", "openai/gpt-4o-mini"
	model: string;
	// Provider API key (OpenRouter, Anthropic, OpenAI, etc.)
	apiKey: string;
	// Defaults to OpenRouter.
	baseUrl?: string;
	// Optional OpenRouter metadata headers (recommended).
	openRouterReferer?: string;
	openRouterTitle?: string;
	// Strategy prompt from the human.
	systemPrompt?: string;
	// Default 0.3
	temperature?: number;
}

export function makeLlmBot(
	id: string,
	config: LlmBotConfig & { delayMs?: number },
): Bot {
	const client = isOpenRouterBaseUrl(config.baseUrl)
		? createOpenRouterClient({
				apiKey: config.apiKey,
				baseUrl: config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
				referer:
					config.openRouterReferer ??
					process.env.OPENROUTER_REFERRER ??
					undefined,
				title:
					config.openRouterTitle ?? process.env.OPENROUTER_TITLE ?? undefined,
			})
		: new OpenAI({
				apiKey: config.apiKey,
				baseURL: config.baseUrl,
			});

	let turnCount = 0;

	return {
		id,
		name: `LlmBot_${config.model}`,
		chooseMove: ({ legalMoves, rng }) => {
			return legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
		},
		chooseTurn: async (ctx) => {
			const result = await chooseTurn(client, id, config, ctx, turnCount);
			turnCount++;
			return result;
		},
	};
}

async function chooseTurn(
	client: OpenAI,
	botId: string,
	config: LlmBotConfig & { delayMs?: number },
	ctx: {
		state: MatchState;
		legalMoves: Move[];
		turn: number;
		rng: () => number;
	},
	turnCount: number,
): Promise<Move[]> {
	const { state, legalMoves, turn, rng } = ctx;

	if (config.delayMs && config.delayMs > 0) await sleep(config.delayMs);

	const side = inferSide(state, botId);

	// Build compact prompt
	const system =
		turnCount === 0
			? buildFullSystemPrompt(side, state, config.systemPrompt)
			: buildShortSystemPrompt(side);
	const user = buildCompactUserMessage(state, side, legalMoves);

	const startTime = Date.now();
	let apiError: string | undefined;
	let content = "";

	try {
		const completion = await withRetryOnce(async () => {
			return Promise.race([
				client.chat.completions.create({
					model: config.model,
					temperature: config.temperature ?? 0.3,
					messages: [
						{ role: "system", content: system },
						{ role: "user", content: user },
					],
					max_tokens: 400,
				}),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("API timeout after 10s")), 10000),
				),
			]);
		});
		content = completion.choices?.[0]?.message?.content ?? "";
	} catch (e) {
		apiError = e instanceof Error ? e.message : String(e);
		getDiagnosticsCollector().logLlmCall({
			timestamp: new Date().toISOString(),
			botId,
			model: config.model,
			turn,
			apiLatencyMs: Date.now() - startTime,
			apiSuccess: false,
			parsingSuccess: false,
			usedRandomFallback: true,
			commandsReturned: 0,
			commandsMatched: 0,
			commandsSkipped: 0,
			responsePreview: "",
			apiError,
		});
		return [{ action: "end_turn" }];
	}

	// Parse response
	const parsed = parseLlmResponse(content);

	// Match commands to legal moves
	const moves: Move[] = [];

	for (const cmd of parsed.commands) {
		const matched = matchCommand(cmd, legalMoves);
		if (matched) {
			if (moves.length === 0 && parsed.reasoning) {
				moves.push({ ...matched, reasoning: parsed.reasoning } as Move);
			} else {
				moves.push(matched);
			}
		}
	}

	// If no valid commands parsed, fall back to end_turn
	if (moves.length === 0) {
		moves.push({ action: "end_turn" });
	}

	const commandsMatched = moves.length;
	const commandsSkipped = parsed.commands.length - commandsMatched;
	const usedRandomFallback =
		moves.length === 1 &&
		moves[0]?.action === "end_turn" &&
		!parsed.commands.some((c) => c.action === "end_turn");

	getDiagnosticsCollector().logLlmCall({
		timestamp: new Date().toISOString(),
		botId,
		model: config.model,
		turn,
		apiLatencyMs: Date.now() - startTime,
		apiSuccess: true,
		parsingSuccess: parsed.commands.length > 0,
		usedRandomFallback,
		commandsReturned: parsed.commands.length,
		commandsMatched,
		commandsSkipped: commandsSkipped > 0 ? commandsSkipped : 0,
		responsePreview: content.slice(0, 200),
		reasoning: parsed.reasoning,
	});

	return moves;
}

// ---------------------------------------------------------------------------
// System prompt builders
// ---------------------------------------------------------------------------

function buildFullSystemPrompt(
	side: "A" | "B",
	state: MatchState,
	userStrategy?: string,
): string {
	const ownStrongholdHex = findStrongholdHex(state, side);
	const enemySide = side === "A" ? "B" : "A";
	const enemyStrongholdHex = findStrongholdHex(state, enemySide);

	const strategy =
		userStrategy?.trim() ||
		"Be aggressive. Prioritize attacks, then advance toward the enemy stronghold.";

	return [
		`You are Player ${side} in Fightclaw, a hex strategy game.`,
		"",
		"COMMAND FORMAT (one per line):",
		"  move <unitId> <hexId>       - Move unit/stack to hex",
		"  attack <unitId> <hexId>     - Attack target hex",
		"  recruit <unitType> <hexId>  - Recruit at your stronghold (infantry/cavalry/archer)",
		"  fortify <unitId>            - Fortify unit in place",
		"  end_turn                    - End your turn",
		"",
		"UNITS: infantry (ATK=2 DEF=4 HP=3 range=1 move=2), cavalry (ATK=4 DEF=2 HP=2 range=1 move=4), archer (ATK=3 DEF=1 HP=2 range=2 move=3)",
		"COMBAT: damage = max(1, ATK+1+stackBonus - DEF). Cavalry charge: +2 ATK if moved 2+ hexes.",
		"WIN: capture ANY enemy stronghold, eliminate all enemies, or highest VP at turn limit.",
		`Your stronghold: ${ownStrongholdHex}. Enemy stronghold: ${enemyStrongholdHex}.`,
		"",
		strategy,
		"",
		"Respond with commands only. Optional reasoning after --- separator.",
	].join("\n");
}

function buildShortSystemPrompt(side: "A" | "B"): string {
	return `Player ${side}. Commands only. Optional reasoning after ---.`;
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

function buildCompactUserMessage(
	state: MatchState,
	side: "A" | "B",
	legalMoves: Move[],
): string {
	const stateBlock = encodeState(state, side);
	const movesBlock = encodeLegalMoves(legalMoves, state);
	return `${stateBlock}\n${movesBlock}`;
}

// ---------------------------------------------------------------------------
// Response parsing (exported for testing)
// ---------------------------------------------------------------------------

export function parseLlmResponse(text: string): {
	commands: ParsedCommand[];
	reasoning: string | undefined;
} {
	return parseCommandsWithReasoning(text);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function inferSide(state: MatchState, botId: string): "A" | "B" {
	return state.players.A.id === botId ? "A" : "B";
}

function findStrongholdHex(state: MatchState, side: "A" | "B"): string {
	const target = side === "A" ? "stronghold_a" : "stronghold_b";
	const hex = state.board.find((h) => h.type === target);
	return hex?.id ?? "unknown";
}

async function withRetryOnce<T>(fn: () => Promise<T>): Promise<T> {
	try {
		return await fn();
	} catch (err) {
		const status =
			(err as { status?: number; statusCode?: number } | null)?.status ??
			(err as { status?: number; statusCode?: number } | null)?.statusCode;
		if (status === 429 || status === 500 || status === 503) {
			await sleep(2000);
			return fn();
		}
		throw err;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}
