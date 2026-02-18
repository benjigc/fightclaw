import OpenAI from "openai";
import { getDiagnosticsCollector } from "../diagnostics/collector";
import { Engine } from "../engineAdapter";
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

const DEFAULT_LLM_TIMEOUT_MS = 35_000;
const DEFAULT_LLM_MAX_RETRIES = 3;
const DEFAULT_LLM_RETRY_BASE_MS = 1_000;
const DEFAULT_LLM_MAX_TOKENS = 320;

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
	// Number of concurrent requests per turn (first success wins).
	parallelCalls?: number;
	// Per-call timeout in ms.
	timeoutMs?: number;
	// Retry configuration.
	maxRetries?: number;
	retryBaseMs?: number;
	// Token budget for response.
	maxTokens?: number;
}

export function makeLlmBot(
	id: string,
	config: LlmBotConfig & { delayMs?: number },
): Bot {
	let client: OpenAI;

	if (isOpenRouterBaseUrl(config.baseUrl)) {
		client = createOpenRouterClient({
			apiKey: config.apiKey,
			baseUrl: config.baseUrl ?? OPENROUTER_DEFAULT_BASE_URL,
			referer:
				config.openRouterReferer ??
				process.env.OPENROUTER_REFERRER ??
				undefined,
			title:
				config.openRouterTitle ?? process.env.OPENROUTER_TITLE ?? undefined,
		});
	} else {
		client = new OpenAI({
			apiKey: config.apiKey,
			baseURL: config.baseUrl,
		});
	}

	let turnCount = 0;
	let previousSeenState: MatchState | undefined;

	return {
		id,
		name: `LlmBot_${config.model}`,
		chooseMove: ({ legalMoves, rng }) => {
			return legalMoves[Math.floor(rng() * legalMoves.length)] as Move;
		},
		chooseTurn: async (ctx) => {
			const result = await chooseTurnDetailed(
				client,
				id,
				config,
				ctx,
				turnCount,
				previousSeenState,
			);
			turnCount++;
			previousSeenState = structuredClone(ctx.state);
			return result.moves;
		},
		chooseTurnWithMeta: async (ctx) => {
			const result = await chooseTurnDetailed(
				client,
				id,
				config,
				ctx,
				turnCount,
				previousSeenState,
			);
			turnCount++;
			previousSeenState = structuredClone(ctx.state);
			return {
				moves: result.moves,
				prompt: result.prompt,
				rawOutput: result.rawOutput,
				model: config.model,
			};
		},
	};
}

async function chooseTurnDetailed(
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
	previousSeenState?: MatchState,
): Promise<{
	moves: Move[];
	prompt: string;
	rawOutput: string;
}> {
	const { state, legalMoves, turn } = ctx;

	if (config.delayMs && config.delayMs > 0) await sleep(config.delayMs);

	const side = inferSide(state, botId);

	// Build compact prompt
	const delta = previousSeenState
		? buildTurnDelta(previousSeenState, state, side)
		: undefined;
	const tacticalSummary = buildTacticalSummary(state, side, legalMoves);
	const system =
		turnCount % 3 === 0
			? buildFullSystemPrompt(side, state, config.systemPrompt)
			: buildShortSystemPrompt(side, config.systemPrompt);
	const user = buildCompactUserMessage(
		state,
		side,
		legalMoves,
		tacticalSummary,
		delta,
	);
	const fullPrompt = `${system}\n\n${user}`;

	const startTime = Date.now();
	let apiError: string | undefined;
	let content = "";

	try {
		const timeoutMs = Math.max(
			1,
			config.timeoutMs ??
				parseEnvInt(process.env.SIM_LLM_TIMEOUT_MS, DEFAULT_LLM_TIMEOUT_MS),
		);
		const retryConfig = {
			maxRetries:
				config.maxRetries ??
				parseEnvInt(process.env.SIM_LLM_MAX_RETRIES, DEFAULT_LLM_MAX_RETRIES),
			baseDelayMs:
				config.retryBaseMs ??
				parseEnvInt(
					process.env.SIM_LLM_RETRY_BASE_MS,
					DEFAULT_LLM_RETRY_BASE_MS,
				),
		};
		const parallelCalls = Math.max(
			1,
			config.parallelCalls ??
				parseEnvInt(process.env.SIM_LLM_PARALLEL_CALLS, 1),
		);

		const requestOnce = () =>
			requestWithTimeout(client, config, system, user, timeoutMs);

		const completion =
			parallelCalls === 1
				? await withRetry(requestOnce, retryConfig)
				: await Promise.any(
						Array.from({ length: parallelCalls }, () =>
							withRetry(requestOnce, retryConfig),
						),
					);
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
		const fallback = pickFallbackMove(legalMoves, ctx.rng);
		return {
			moves: [fallback],
			prompt: fullPrompt,
			rawOutput: "",
		};
	}

	// Parse response
	const parsed = parseLlmResponse(content);

	// Match commands against a simulated evolving legal state so later
	// commands are checked after earlier actions are applied.
	const moves: Move[] = [];
	let simulatedState = state;
	let currentLegalMoves = legalMoves;

	for (const cmd of parsed.commands.slice(0, 5)) {
		const matched = matchCommand(cmd, currentLegalMoves);
		if (!matched) continue;

		const candidate =
			moves.length === 0 && parsed.reasoning
				? ({ ...matched, reasoning: parsed.reasoning } as Move)
				: matched;
		const applied = Engine.applyMove(simulatedState, candidate);
		if (!applied.ok) {
			continue;
		}
		moves.push(candidate);
		simulatedState = applied.state;

		if (Engine.isTerminal(simulatedState).ended) {
			break;
		}
		if (String(Engine.currentPlayer(simulatedState)) !== String(botId)) {
			break;
		}
		currentLegalMoves = Engine.listLegalMoves(simulatedState);
	}

	// If no valid commands parsed, fall back to end_turn
	if (moves.length === 0) {
		moves.push(pickFallbackMove(legalMoves, ctx.rng));
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

	return {
		moves,
		prompt: fullPrompt,
		rawOutput: content,
	};
}

function requestWithTimeout(
	client: OpenAI,
	config: LlmBotConfig,
	system: string,
	user: string,
	timeoutMs: number,
) {
	const controller = new AbortController();
	const timeout = setTimeout(() => {
		controller.abort();
	}, timeoutMs);

	return client.chat.completions
		.create(
			{
				model: config.model,
				temperature: config.temperature ?? 0.3,
				messages: [
					{ role: "system", content: system },
					{ role: "user", content: user },
				],
				max_tokens: config.maxTokens ?? DEFAULT_LLM_MAX_TOKENS,
			},
			{ signal: controller.signal },
		)
		.catch((error) => {
			if (controller.signal.aborted) {
				throw new Error(`API timeout after ${timeoutMs}ms`);
			}
			throw error;
		})
		.finally(() => {
			clearTimeout(timeout);
		});
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
		"  upgrade <unitId>            - Upgrade a base unit (infantry->swordsman, cavalry->knight, archer->crossbow)",
		"  end_turn                    - End your turn",
		"IMPORTANT: commands execute in order and legality changes after each command.",
		"",
		"UNITS T1: infantry, cavalry, archer. T2 upgrades: infantry->swordsman, cavalry->knight, archer->crossbow.",
		"COMBAT: damage = max(1, ATK+1+stackBonus - DEF). Cavalry charge: +2 ATK if moved 2+ hexes.",
		"WIN: capture ANY enemy stronghold, eliminate all enemies, or highest VP at turn limit.",
		`Your stronghold: ${ownStrongholdHex}. Enemy stronghold: ${enemyStrongholdHex}.`,
		"",
		strategy,
		"",
		"Return at most 5 commands. Always include end_turn as the final command if actions remain.",
		"Respond with commands only. Optional reasoning after --- separator.",
	].join("\n");
}

function buildShortSystemPrompt(
	side: "A" | "B",
	userStrategy?: string,
): string {
	const strategy =
		userStrategy?.trim() ||
		"Be aggressive. Prioritize attacks, then advance toward enemy stronghold.";
	return [
		`Player ${side} in Fightclaw.`,
		"Use only valid CLI commands from LEGAL_MOVES.",
		"Commands execute sequentially; legality changes after each command.",
		`Strategy: ${strategy}`,
		"Return at most 5 commands and end with end_turn.",
		"Optional reasoning after --- separator.",
	].join(" ");
}

// ---------------------------------------------------------------------------
// User message builder
// ---------------------------------------------------------------------------

function buildCompactUserMessage(
	state: MatchState,
	side: "A" | "B",
	legalMoves: Move[],
	tacticalSummary: string[],
	delta?: TurnDelta,
): string {
	const stateBlock = encodeState(state, side);
	const movesBlock = encodeLegalMoves(legalMoves, state);
	const deltaBlock = delta ? encodeTurnDelta(delta) : "";
	const tacticalBlock =
		tacticalSummary.length > 0
			? `TACTICAL_SUMMARY:\n${tacticalSummary.map((line) => `  - ${line}`).join("\n")}\n`
			: "";
	return `${stateBlock}\n${deltaBlock}${tacticalBlock}${movesBlock}`;
}

type TurnDelta = {
	ownUnitDelta: number;
	enemyUnitDelta: number;
	ownHpDelta: number;
	enemyHpDelta: number;
	ownVpDelta: number;
	enemyVpDelta: number;
	ownResDelta: { gold: number; wood: number };
	enemyResDelta: { gold: number; wood: number };
};

function buildTurnDelta(
	prev: MatchState,
	current: MatchState,
	side: "A" | "B",
): TurnDelta {
	const enemySide = side === "A" ? "B" : "A";
	const prevOwn = prev.players[side];
	const prevEnemy = prev.players[enemySide];
	const curOwn = current.players[side];
	const curEnemy = current.players[enemySide];
	const sumHp = (units: { hp: number }[]) =>
		units.reduce((s, u) => s + u.hp, 0);
	return {
		ownUnitDelta: curOwn.units.length - prevOwn.units.length,
		enemyUnitDelta: curEnemy.units.length - prevEnemy.units.length,
		ownHpDelta: sumHp(curOwn.units) - sumHp(prevOwn.units),
		enemyHpDelta: sumHp(curEnemy.units) - sumHp(prevEnemy.units),
		ownVpDelta: curOwn.vp - prevOwn.vp,
		enemyVpDelta: curEnemy.vp - prevEnemy.vp,
		ownResDelta: {
			gold: curOwn.gold - prevOwn.gold,
			wood: curOwn.wood - prevOwn.wood,
		},
		enemyResDelta: {
			gold: curEnemy.gold - prevEnemy.gold,
			wood: curEnemy.wood - prevEnemy.wood,
		},
	};
}

function encodeTurnDelta(delta: TurnDelta): string {
	const line = (n: number) => (n > 0 ? `+${n}` : `${n}`);
	return [
		"TURN_DELTA_SINCE_YOUR_LAST_TURN:",
		`  own_units=${line(delta.ownUnitDelta)} own_hp=${line(delta.ownHpDelta)} own_vp=${line(delta.ownVpDelta)} own_gold=${line(delta.ownResDelta.gold)} own_wood=${line(delta.ownResDelta.wood)}`,
		`  enemy_units=${line(delta.enemyUnitDelta)} enemy_hp=${line(delta.enemyHpDelta)} enemy_vp=${line(delta.enemyVpDelta)} enemy_gold=${line(delta.enemyResDelta.gold)} enemy_wood=${line(delta.enemyResDelta.wood)}`,
		"",
	].join("\n");
}

function buildTacticalSummary(
	state: MatchState,
	side: "A" | "B",
	legalMoves: Move[],
): string[] {
	const enemySide = side === "A" ? "B" : "A";
	const enemies = state.players[enemySide].units;
	const byPos = new Map(enemies.map((u) => [u.position, u]));
	const attacks = legalMoves.filter(
		(m): m is Extract<Move, { action: "attack" }> => m.action === "attack",
	);
	const ranked = attacks
		.map((m) => {
			const target = byPos.get(m.target);
			const finisher = target ? (target.hp <= 1 ? 30 : 0) : 0;
			const score = (target ? 10 - target.hp : 0) + finisher;
			const targetLabel = target
				? `${target.id}(${target.type} hp=${target.hp}/${target.maxHp})`
				: m.target;
			return {
				score,
				text: `high-value attack: attack ${m.unitId} ${m.target} -> ${targetLabel}`,
			};
		})
		.sort((a, b) => b.score - a.score)
		.slice(0, 3)
		.map((r) => r.text);

	const lowHpThreats = enemies
		.filter((u) => u.hp <= 1)
		.slice(0, 3)
		.map((u) => `${u.id}@${u.position} hp=${u.hp}/${u.maxHp}`);
	if (lowHpThreats.length > 0) {
		ranked.push(`enemy units in kill range: ${lowHpThreats.join(", ")}`);
	}
	const ownLowHp = state.players[side].units
		.filter((u) => u.hp <= 1)
		.slice(0, 3)
		.map((u) => `${u.id}@${u.position} hp=${u.hp}/${u.maxHp}`);
	if (ownLowHp.length > 0) {
		ranked.push(`protect fragile units: ${ownLowHp.join(", ")}`);
	}
	return ranked;
}

function pickFallbackMove(legalMoves: Move[], rng: () => number): Move {
	const attacks = legalMoves.filter((m) => m.action === "attack");
	if (attacks.length > 0) {
		return attacks[Math.floor(rng() * attacks.length)] as Move;
	}
	const moves = legalMoves.filter((m) => m.action === "move");
	if (moves.length > 0) {
		return moves[Math.floor(rng() * moves.length)] as Move;
	}
	const recruit = legalMoves.find((m) => m.action === "recruit");
	if (recruit) return recruit;
	return { action: "end_turn" };
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

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

async function withRetry<T>(
	fn: () => Promise<T>,
	opts: { maxRetries: number; baseDelayMs: number },
): Promise<T> {
	let attempt = 0;
	let lastErr: unknown;
	while (attempt <= opts.maxRetries) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (!isRetryableError(err) || attempt === opts.maxRetries) {
				throw err;
			}
			const delayMs = computeBackoffWithJitter(opts.baseDelayMs, attempt);
			await sleep(delayMs);
			attempt++;
		}
	}
	throw lastErr;
}

function isRetryableError(err: unknown): boolean {
	const status =
		(err as { status?: number; statusCode?: number } | null)?.status ??
		(err as { status?: number; statusCode?: number } | null)?.statusCode;
	if (status === 429 || status === 500 || status === 502 || status === 503) {
		return true;
	}
	const msg = String(
		(err as { message?: string } | null)?.message ?? err,
	).toLowerCase();
	return (
		msg.includes("timeout") ||
		msg.includes("timed out") ||
		msg.includes("econnreset") ||
		msg.includes("fetch failed") ||
		msg.includes("network")
	);
}

function computeBackoffWithJitter(
	baseDelayMs: number,
	attempt: number,
): number {
	const exp = Math.min(attempt, 6);
	const jitter = Math.floor(Math.random() * Math.max(100, baseDelayMs));
	return baseDelayMs * 2 ** exp + jitter;
}

function parseEnvInt(value: string | undefined, fallback: number): number {
	if (!value) return fallback;
	const parsed = Number.parseInt(value, 10);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
