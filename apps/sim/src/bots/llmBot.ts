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
const LATE_MATCH_TURN = 60;
const VERY_LATE_MATCH_TURN = 90;
const MIN_SAFE_FORCED_ATTACK_SCORE = -8;

export type LoopState = {
	noAttackStreak: number;
	noProgressStreak: number;
	recruitStreak: number;
};

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
	let noAttackStreak = 0;
	let noProgressStreak = 0;
	let recruitStreak = 0;

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
				{
					noAttackStreak,
					noProgressStreak,
					recruitStreak,
				},
			);
			noAttackStreak = result.hadAttack ? 0 : noAttackStreak + 1;
			recruitStreak = result.hadRecruit ? recruitStreak + 1 : 0;
			noProgressStreak = result.progressObserved ? 0 : noProgressStreak + 1;
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
				{
					noAttackStreak,
					noProgressStreak,
					recruitStreak,
				},
			);
			noAttackStreak = result.hadAttack ? 0 : noAttackStreak + 1;
			recruitStreak = result.hadRecruit ? recruitStreak + 1 : 0;
			noProgressStreak = result.progressObserved ? 0 : noProgressStreak + 1;
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
	loopState?: LoopState,
): Promise<{
	moves: Move[];
	prompt: string;
	rawOutput: string;
	hadAttack: boolean;
	hadRecruit: boolean;
	progressObserved: boolean;
}> {
	const { state, legalMoves, turn } = ctx;

	if (config.delayMs && config.delayMs > 0) await sleep(config.delayMs);

	const side = inferSide(state, botId);

	// Build compact prompt
	const delta = previousSeenState
		? buildTurnDelta(previousSeenState, state, side)
		: undefined;
	const tacticalSummary = buildTacticalSummary(state, side, legalMoves);
	const policyHints = buildLoopPolicyHints(loopState, turn);
	const system =
		turnCount % 3 === 0
			? buildFullSystemPrompt(side, state, config.systemPrompt, policyHints)
			: buildShortSystemPrompt(side, config.systemPrompt, policyHints);
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
		apiError = formatRequestError(e);
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
		const fallback = pickFallbackMove(legalMoves, state, side);
		return {
			moves: [fallback],
			prompt: fullPrompt,
			rawOutput: "",
			hadAttack: false,
			hadRecruit: false,
			progressObserved: false,
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

	const antiLoopMoves = applyLoopPressurePolicy(moves, {
		state,
		side,
		legalMoves,
		turn,
		loopState,
	});
	moves.splice(0, moves.length, ...antiLoopMoves);

	// If no valid commands parsed, fall back to end_turn
	if (moves.length === 0) {
		moves.push(pickFallbackMove(legalMoves, state, side));
	}

	const deltaForProgress =
		previousSeenState != null
			? buildTurnDelta(previousSeenState, state, side)
			: undefined;
	const progressObserved =
		deltaForProgress != null
			? deltaForProgress.ownUnitDelta !== 0 ||
				deltaForProgress.enemyUnitDelta !== 0 ||
				deltaForProgress.ownHpDelta !== 0 ||
				deltaForProgress.enemyHpDelta !== 0 ||
				deltaForProgress.ownVpDelta !== 0 ||
				deltaForProgress.enemyVpDelta !== 0
			: false;

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
		hadAttack: moves.some((move) => move.action === "attack"),
		hadRecruit: moves.some((move) => move.action === "recruit"),
		progressObserved,
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
	policyHints: string[] = [],
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
		...(policyHints.length > 0
			? ["ANTI_LOOP_RULES:", ...policyHints.map((line) => `  - ${line}`), ""]
			: []),
		"Return at most 5 commands. Always include end_turn as the final command if actions remain.",
		"STRICT OUTPUT: commands only, one per line. No prose, no bullets, no numbering, no explanations, no separator.",
	].join("\n");
}

function buildShortSystemPrompt(
	side: "A" | "B",
	userStrategy?: string,
	policyHints: string[] = [],
): string {
	const strategy =
		userStrategy?.trim() ||
		"Be aggressive. Prioritize attacks, then advance toward enemy stronghold.";
	return [
		`Player ${side} in Fightclaw.`,
		"Use only valid CLI commands from LEGAL_MOVES.",
		"Commands execute sequentially; legality changes after each command.",
		`Strategy: ${strategy}`,
		...(policyHints.length > 0 ? [`Anti-loop: ${policyHints.join(" ")}`] : []),
		"Return at most 5 commands and end with end_turn.",
		"STRICT OUTPUT: commands only, one per line. No prose, no bullets, no numbering, no explanations, no separator.",
	].join(" ");
}

function buildLoopPolicyHints(loopState?: LoopState, turn = 0): string[] {
	const hints: string[] = [];
	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const recruitStreak = loopState?.recruitStreak ?? 0;

	hints.push(
		"If ATTACKS are listed in LEGAL_MOVES, include at least one attack before end_turn.",
	);
	hints.push(
		"Do not output recruit-only turns repeatedly; recruit only when it changes immediate tactical pressure.",
	);
	if (noAttack >= 2 || noProgress >= 2) {
		hints.push(
			"Stall risk is high: prioritize direct combat over repositioning this turn.",
		);
	}
	if (noProgress >= 3) {
		hints.push(
			"If no favorable attack exists, make at least one move that reduces distance to the enemy stronghold.",
		);
	}
	if (recruitStreak >= 2) {
		hints.push(
			"Do not recruit again this turn unless there are no legal attacks and no advancing moves.",
		);
	}
	if (
		turn >= LATE_MATCH_TURN &&
		(noAttack >= 1 || noProgress >= 1 || recruitStreak >= 1)
	) {
		hints.push(
			"Late game: avoid low-impact recruit/fortify cycles; choose attack or objective advance.",
		);
	}
	return hints;
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

function pickFallbackMove(
	legalMoves: Move[],
	state?: MatchState,
	side?: "A" | "B",
): Move {
	const attacks = legalMoves.filter(
		(move): move is Extract<Move, { action: "attack" }> =>
			move.action === "attack",
	);
	if (attacks.length > 0 && state && side) {
		const scored = pickBestAttackWithScore(attacks, state, side);
		if (scored) return scored.move;
	}
	if (attacks.length > 0) return attacks[0] as Move;

	if (state && side) {
		const bestAdvance = pickBestObjectiveAdvanceMove(legalMoves, state, side);
		if (bestAdvance) return bestAdvance;
	}
	const firstMove = legalMoves.find((move) => move.action === "move");
	if (firstMove) return firstMove;

	const recruitInfantry = legalMoves.find(
		(move): move is Extract<Move, { action: "recruit" }> =>
			move.action === "recruit" && move.unitType === "infantry",
	);
	if (recruitInfantry) return recruitInfantry;
	const recruitAny = legalMoves.find((move) => move.action === "recruit");
	if (recruitAny) return recruitAny;

	const fortify = legalMoves.find((move) => move.action === "fortify");
	if (fortify) return fortify;
	const upgrade = legalMoves.find((move) => move.action === "upgrade");
	if (upgrade) return upgrade;
	const endTurn = legalMoves.find((move) => move.action === "end_turn");
	if (endTurn) return endTurn;
	return { action: "end_turn" };
}

export function applyLoopPressurePolicy(
	moves: Move[],
	opts: {
		state: MatchState;
		side: "A" | "B";
		legalMoves: Move[];
		turn: number;
		loopState?: LoopState;
	},
): Move[] {
	const { state, side, legalMoves, turn, loopState } = opts;
	const legalAttacks = legalMoves.filter(
		(move): move is Extract<Move, { action: "attack" }> =>
			move.action === "attack",
	);

	if (moves.some((move) => move.action === "attack")) {
		return moves;
	}

	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const recruitStreak = loopState?.recruitStreak ?? 0;
	const lateGame = turn >= LATE_MATCH_TURN;
	const pressure = computeLoopPressure(loopState, turn);
	const hasRecruit = moves.some((move) => move.action === "recruit");
	const lowImpactLoopTurn = isLowImpactLoopTurn(moves, state, side);
	const shouldPreferCombat =
		noAttack >= 2 ||
		noProgress >= 2 ||
		(lateGame && (noAttack >= 1 || noProgress >= 1));
	const shouldBlockRecruitLoop =
		recruitStreak >= 2 ||
		noProgress >= 3 ||
		(lateGame && recruitStreak >= 1 && noAttack >= 1);
	const desperateMode =
		pressure >= 6 || noProgress >= 5 || turn >= VERY_LATE_MATCH_TURN + 20;

	const bestAttack =
		legalAttacks.length > 0
			? pickBestAttackWithScore(legalAttacks, state, side)
			: undefined;
	const canForceAttack =
		bestAttack != null &&
		(bestAttack.score >= MIN_SAFE_FORCED_ATTACK_SCORE || desperateMode);

	if (
		canForceAttack &&
		(shouldPreferCombat ||
			(shouldBlockRecruitLoop && hasRecruit) ||
			(lowImpactLoopTurn && pressure >= 2))
	) {
		return [bestAttack.move, { action: "end_turn" }];
	}

	const bestAdvance = pickBestObjectiveAdvanceMove(legalMoves, state, side);
	if (
		bestAdvance &&
		(shouldBlockRecruitLoop || (lowImpactLoopTurn && pressure >= 2))
	) {
		return [bestAdvance, { action: "end_turn" }];
	}

	return moves;
}

function computeLoopPressure(
	loopState: LoopState | undefined,
	turn: number,
): number {
	const noAttack = loopState?.noAttackStreak ?? 0;
	const noProgress = loopState?.noProgressStreak ?? 0;
	const recruitStreak = loopState?.recruitStreak ?? 0;
	let pressure = 0;

	if (noAttack >= 2) pressure += 2;
	if (noAttack >= 4) pressure += 1;
	if (noProgress >= 2) pressure += 2;
	if (noProgress >= 4) pressure += 2;
	if (recruitStreak >= 3) pressure += 1;
	if (turn >= LATE_MATCH_TURN) pressure += 1;
	if (turn >= VERY_LATE_MATCH_TURN) pressure += 1;
	if (turn >= LATE_MATCH_TURN && (noAttack >= 1 || noProgress >= 1)) {
		pressure += 1;
	}

	return pressure;
}

function isLowImpactLoopTurn(
	moves: Move[],
	state: MatchState,
	side: "A" | "B",
): boolean {
	let sawNonEndTurn = false;
	for (const move of moves) {
		if (move.action === "end_turn") continue;
		sawNonEndTurn = true;
		if (move.action === "attack") return false;
		if (move.action === "move") {
			if (scoreObjectiveAdvanceMove(move, state, side) > 0) {
				return false;
			}
			continue;
		}
		if (move.action === "recruit" || move.action === "fortify") {
			continue;
		}
		return false;
	}
	return sawNonEndTurn;
}

function pickBestObjectiveAdvanceMove(
	legalMoves: Move[],
	state: MatchState,
	side: "A" | "B",
): Extract<Move, { action: "move" }> | undefined {
	let bestMove: Extract<Move, { action: "move" }> | undefined;
	let bestScore = 0;

	for (const move of legalMoves) {
		if (move.action !== "move") continue;
		const score = scoreObjectiveAdvanceMove(move, state, side);
		if (score > bestScore) {
			bestMove = move;
			bestScore = score;
		}
	}

	return bestMove;
}

function scoreObjectiveAdvanceMove(
	move: Extract<Move, { action: "move" }>,
	state: MatchState,
	side: "A" | "B",
): number {
	const enemySide = side === "A" ? "B" : "A";
	const enemyStrongholdHex = findStrongholdHex(state, enemySide);
	const ownById = new Map(
		state.players[side].units.map((unit) => [unit.id, unit]),
	);
	const attacker = ownById.get(move.unitId);
	if (!attacker) return Number.NEGATIVE_INFINITY;

	const startDist = hexDistance(attacker.position, enemyStrongholdHex);
	const endDist = hexDistance(move.to, enemyStrongholdHex);
	if (!Number.isFinite(startDist) || !Number.isFinite(endDist)) {
		return Number.NEGATIVE_INFINITY;
	}

	const byHex = new Map(state.board.map((hex) => [hex.id, hex]));
	const destination = byHex.get(move.to);
	const towardStronghold = (startDist - endDist) * 6;
	const enemyControlPressure = destination?.controlledBy === enemySide ? 4 : 0;
	const objectiveTerrainBonus =
		destination?.type === "crown"
			? 6
			: destination?.type === "gold_mine" || destination?.type === "lumber_camp"
				? 2
				: 0;
	const strongholdCaptureBonus = move.to === enemyStrongholdHex ? 45 : 0;

	return (
		towardStronghold +
		enemyControlPressure +
		objectiveTerrainBonus +
		strongholdCaptureBonus
	);
}

function pickBestAttackWithScore(
	attacks: Extract<Move, { action: "attack" }>[],
	state: MatchState,
	side: "A" | "B",
): { move: Extract<Move, { action: "attack" }>; score: number } | undefined {
	let best:
		| { move: Extract<Move, { action: "attack" }>; score: number }
		| undefined;

	for (const attack of attacks) {
		const score = scoreAttackMove(attack, state, side);
		if (!best || score > best.score) {
			best = { move: attack, score };
		}
	}

	return best;
}

function scoreAttackMove(
	attack: Extract<Move, { action: "attack" }>,
	state: MatchState,
	side: "A" | "B",
): number {
	const enemySide = side === "A" ? "B" : "A";
	const ownById = new Map(
		state.players[side].units.map((unit) => [unit.id, unit]),
	);
	const enemies = state.players[enemySide].units;
	const targets = enemies.filter((enemy) => enemy.position === attack.target);
	const attacker = ownById.get(attack.unitId);
	const targetHex = state.board.find((hex) => hex.id === attack.target);
	const enemyStrongholdType = side === "A" ? "stronghold_b" : "stronghold_a";

	const finishers = targets.filter((target) => target.hp <= 1).length;
	const damaged = targets.filter((target) => target.hp < target.maxHp).length;
	const fortifiedCount = targets.filter((target) => target.isFortified).length;
	const attackerLowHpPenalty = attacker
		? attacker.hp <= 1
			? 14
			: attacker.hp === 2
				? 6
				: 0
		: 0;
	const stackRiskPenalty =
		targets.length >= 2 && (attacker?.hp ?? 3) <= 2 ? 12 : 0;
	const freshTargetPenalty =
		targets.length > 0 && targets.every((target) => target.hp === target.maxHp)
			? 4
			: 0;
	const objectiveBonus = targetHex?.type === enemyStrongholdType ? 28 : 0;
	const controlBonus = targetHex?.controlledBy === enemySide ? 4 : 0;

	return (
		finishers * 36 +
		damaged * 12 +
		targets.length * 6 +
		objectiveBonus +
		controlBonus -
		fortifiedCount * 8 -
		attackerLowHpPenalty -
		stackRiskPenalty -
		freshTargetPenalty
	);
}

function parseHexId(hexId: string): { row: number; col: number } | undefined {
	const match = /^([A-Za-z])(\d+)$/.exec(hexId);
	if (!match) return undefined;
	const rowToken = match[1];
	if (!rowToken) return undefined;
	const row = rowToken.toUpperCase().charCodeAt(0) - 65;
	const col = Number.parseInt(match[2] ?? "", 10) - 1;
	if (!Number.isFinite(col) || col < 0 || row < 0) return undefined;
	return { row, col };
}

function hexDistance(fromHex: string, toHex: string): number {
	const from = parseHexId(fromHex);
	const to = parseHexId(toHex);
	if (!from || !to) return Number.POSITIVE_INFINITY;

	const fromQ = from.col - Math.floor((from.row - (from.row & 1)) / 2);
	const fromR = from.row;
	const fromS = -fromQ - fromR;
	const toQ = to.col - Math.floor((to.row - (to.row & 1)) / 2);
	const toR = to.row;
	const toS = -toQ - toR;

	return Math.max(
		Math.abs(fromQ - toQ),
		Math.abs(fromR - toR),
		Math.abs(fromS - toS),
	);
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

function formatRequestError(error: unknown): string {
	if (error instanceof AggregateError) {
		const details = error.errors
			.map((entry) => formatRequestErrorEntry(entry))
			.filter((entry) => entry.length > 0);
		if (details.length === 0) return error.message;
		return `${error.message}: ${details.join(" | ")}`;
	}
	return formatRequestErrorEntry(error);
}

function formatRequestErrorEntry(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
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
