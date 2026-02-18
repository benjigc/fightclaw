import * as fs from "node:fs";
import * as path from "node:path";
import { pickOne } from "../rng";
import type { Bot, MatchState, Move } from "../types";
import {
	type ArchetypeConfig,
	type BotPhase,
	DEFAULT_PHASE_POLICY,
	MOCK_LLM_ARCHETYPES,
	type MockLlmArchetypeName,
	type UtilityTerm,
} from "./mockLlmArchetypes";

type LegacyStrategy = "aggressive" | "defensive" | "random" | "strategic";
type StrategyLike = LegacyStrategy | MockLlmArchetypeName;

interface MoveUtilityBreakdown {
	archetype: MockLlmArchetypeName | "random";
	phase: BotPhase;
	phaseTriggers: string[];
	baseActionBias: number;
	phaseActionBias: number;
	promptBonus: number;
	policyAdjustments: number;
	termsRaw: Record<UtilityTerm, number>;
	termWeights: Record<UtilityTerm, number>;
	termsWeighted: Record<UtilityTerm, number>;
	total: number;
}

interface MoveMetadata {
	whyThisMove: string;
	breakdown: MoveUtilityBreakdown;
}

interface MoveCandidate {
	move: Move;
	metadata: MoveMetadata;
}

/** Configuration for mock LLM bot */
export interface MockLlmConfig {
	/** Inline prompt instructions (e.g., "Always attack first") */
	inline?: string;
	/** Path to JSON file with prompt config */
	file?: string;
	/** Strategy pattern (legacy or direct archetype) */
	strategy?: StrategyLike;
	/** Explicit archetype override */
	archetype?: MockLlmArchetypeName;
}

/** File-based prompt config */
interface PromptFileConfig {
	botId: string;
	inline?: string;
	strategy?: StrategyLike;
	archetype?: MockLlmArchetypeName;
}

interface PromptIntents {
	attack: boolean;
	defend: boolean;
	recruit: boolean;
	advance: boolean;
}

interface ScoringContext {
	move: Move;
	state: MatchState;
	side: "A" | "B";
	archetype: ArchetypeConfig;
	phase: BotPhase;
	phaseTriggers: string[];
	turn: number;
	promptIntents: PromptIntents;
	hasPlayableAlternatives: boolean;
	hasLegalAttack: boolean;
}

function loadPromptFromFile(filePath: string): PromptFileConfig {
	const absolutePath = path.isAbsolute(filePath)
		? filePath
		: path.resolve(process.cwd(), filePath);
	const content = fs.readFileSync(absolutePath, "utf-8");
	return JSON.parse(content) as PromptFileConfig;
}

function includesAny(haystack: string, needles: string[]): boolean {
	return needles.some((needle) => haystack.includes(needle));
}

function parsePromptIntents(promptInstructions?: string): PromptIntents {
	if (!promptInstructions) {
		return {
			attack: false,
			defend: false,
			recruit: false,
			advance: false,
		};
	}

	const lower = promptInstructions.toLowerCase();
	return {
		attack: includesAny(lower, [
			"attack",
			"eliminate",
			"kill",
			"finish",
			"counterattack",
			"focus fire",
			"damaged enem",
		]),
		defend: includesAny(lower, [
			"defend",
			"protect",
			"hold",
			"formation",
			"fortify",
		]),
		recruit: includesAny(lower, [
			"recruit",
			"reinforce",
			"build",
			"train",
			"economy",
		]),
		advance: includesAny(lower, [
			"advance",
			"press",
			"push",
			"stronghold",
			"capture",
			"frontline",
		]),
	};
}

function inferSide(state: MatchState, id: string): "A" | "B" {
	return String(state.players.A.id) === String(id) ? "A" : "B";
}

function colIndex(hexId: string): number {
	const value = Number(hexId.slice(1));
	return Number.isFinite(value) ? value : 0;
}

function findUnit(state: MatchState, unitId: string) {
	for (const unit of state.players.A.units) {
		if (unit.id === unitId) return unit;
	}
	for (const unit of state.players.B.units) {
		if (unit.id === unitId) return unit;
	}
	return null;
}

function enemyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const enemy = side === "A" ? state.players.B : state.players.A;
	return enemy.units.filter((unit) => unit.position === hexId);
}

function friendlyUnitsAtHex(state: MatchState, side: "A" | "B", hexId: string) {
	const own = side === "A" ? state.players.A : state.players.B;
	return own.units.filter((unit) => unit.position === hexId);
}

function hexTypeAt(state: MatchState, hexId: string): string | null {
	const hex = state.board.find((h) => h.id === hexId);
	return hex?.type ?? null;
}

function archetypeUnit(unitType: string): "infantry" | "cavalry" | "archer" {
	if (unitType === "swordsman") return "infantry";
	if (unitType === "knight") return "cavalry";
	if (unitType === "crossbow") return "archer";
	return unitType as "infantry" | "cavalry" | "archer";
}

function matchupBonus(attackerType: string, defenderType: string): number {
	const attacker = archetypeUnit(attackerType);
	const defender = archetypeUnit(defenderType);
	if (attacker === "infantry" && defender === "cavalry") return 10;
	if (attacker === "cavalry" && defender === "archer") return 10;
	if (attacker === "archer" && defender === "infantry") return 10;
	if (attacker === "infantry" && defender === "archer") return -6;
	if (attacker === "cavalry" && defender === "infantry") return -6;
	if (attacker === "archer" && defender === "cavalry") return -6;
	return 0;
}

function resolvePhase(ctx: {
	state: MatchState;
	side: "A" | "B";
	turn: number;
	hasLegalAttack: boolean;
}): { phase: BotPhase; triggers: string[] } {
	const triggers: string[] = [];
	const own = ctx.side === "A" ? ctx.state.players.A : ctx.state.players.B;
	const enemy = ctx.side === "A" ? ctx.state.players.B : ctx.state.players.A;
	const vpLead = own.vp - enemy.vp;

	if (ctx.turn <= DEFAULT_PHASE_POLICY.openingTurnMax) {
		triggers.push(`turn<=${DEFAULT_PHASE_POLICY.openingTurnMax}`);
		return { phase: "opening", triggers };
	}

	if (ctx.turn >= DEFAULT_PHASE_POLICY.closingTurnMin) {
		triggers.push(`turn>=${DEFAULT_PHASE_POLICY.closingTurnMin}`);
	}
	if (enemy.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold) {
		triggers.push(`enemyUnits<=${DEFAULT_PHASE_POLICY.closingUnitsThreshold}`);
	}
	if (own.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold) {
		triggers.push(`ownUnits<=${DEFAULT_PHASE_POLICY.closingUnitsThreshold}`);
	}
	if (
		Math.abs(vpLead) >= DEFAULT_PHASE_POLICY.closingVpLeadThreshold &&
		ctx.turn > DEFAULT_PHASE_POLICY.openingTurnMax
	) {
		triggers.push(`absVpLead>=${DEFAULT_PHASE_POLICY.closingVpLeadThreshold}`);
	}
	if (
		ctx.hasLegalAttack &&
		ctx.turn >= DEFAULT_PHASE_POLICY.closingTurnMin - 2 &&
		enemy.units.length <= DEFAULT_PHASE_POLICY.closingUnitsThreshold + 1
	) {
		triggers.push("tactical_closing_window");
	}

	if (triggers.length > 0) {
		return { phase: "closing", triggers };
	}
	return { phase: "midgame", triggers: ["default"] };
}

function mapStrategyToArchetype(
	strategy: StrategyLike,
): MockLlmArchetypeName | null {
	if (strategy === "random") return null;
	if (strategy in MOCK_LLM_ARCHETYPES) {
		return strategy as MockLlmArchetypeName;
	}
	if (strategy === "aggressive") return "timing_push";
	if (strategy === "defensive") return "turtle_boom";
	return "map_control";
}

function inferArchetypeFromIntents(
	mapped: MockLlmArchetypeName,
	promptIntents: PromptIntents,
): MockLlmArchetypeName {
	if (promptIntents.recruit && !promptIntents.attack) return "greedy_macro";
	if (promptIntents.defend && !promptIntents.advance) return "turtle_boom";
	if (promptIntents.advance && promptIntents.attack) return "timing_push";
	if (promptIntents.advance) return "map_control";
	return mapped;
}

function scorePromptBias(move: Move, promptIntents: PromptIntents): number {
	let bonus = 0;
	if (promptIntents.attack && move.action === "attack") bonus += 65;
	if (promptIntents.defend && move.action === "fortify") bonus += 32;
	if (promptIntents.defend && move.action === "recruit") bonus += 14;
	if (promptIntents.defend && move.action === "upgrade") bonus += 8;
	if (promptIntents.recruit && move.action === "recruit") bonus += 28;
	if (promptIntents.recruit && move.action === "upgrade") bonus += 18;
	if (promptIntents.advance && move.action === "move") bonus += 22;
	if (promptIntents.advance && move.action === "attack") bonus += 10;
	return bonus;
}

function combatValue(ctx: ScoringContext): number {
	const { move, state, side } = ctx;
	if (move.action === "attack") {
		const attacker = findUnit(state, move.unitId);
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const damaged = enemies.filter((u) => u.hp < u.maxHp).length;
		const finishable = enemies.filter((u) => u.hp <= 1).length;
		const typeBonus =
			attacker && enemies.length > 0
				? Math.max(
						...enemies.map((enemy) => matchupBonus(attacker.type, enemy.type)),
					)
				: 0;
		const fortifiedPenalty = enemies.some((enemy) => enemy.isFortified)
			? -8
			: 0;
		return (
			enemies.length * 12 +
			damaged * 16 +
			finishable * 30 +
			typeBonus +
			fortifiedPenalty
		);
	}

	if (move.action === "fortify") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		const enemy = side === "A" ? state.players.B : state.players.A;
		const threatened = enemy.units.some(
			(u) => Math.abs(colIndex(u.position) - colIndex(unit.position)) <= 1,
		);
		return threatened ? 14 : 4;
	}

	if (move.action === "upgrade") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		if (unit.type === "infantry") return 14;
		if (unit.type === "archer") return 12;
		if (unit.type === "cavalry") return 10;
	}

	return 0;
}

function positionValue(ctx: ScoringContext): number {
	const { move, state, side } = ctx;
	if (move.action !== "move") return 0;
	const mover = findUnit(state, move.unitId);
	if (!mover) return 0;

	const fromCol = colIndex(mover.position);
	const toCol = colIndex(move.to);
	const delta = side === "A" ? toCol - fromCol : fromCol - toCol;
	const targetTerrain = hexTypeAt(state, move.to);
	const terrainBonus =
		targetTerrain === "high_ground"
			? 12
			: targetTerrain === "hills" || targetTerrain === "forest"
				? 6
				: targetTerrain === "gold_mine" || targetTerrain === "lumber_camp"
					? 7
					: 0;
	const stackUnits = friendlyUnitsAtHex(state, side, move.to);
	const stackBonus =
		stackUnits.length > 0 &&
		stackUnits.every((u) => u.type === mover.type) &&
		stackUnits.length < 5
			? 8
			: 0;

	return delta * 6 + terrainBonus + stackBonus;
}

function economyValue(ctx: ScoringContext): number {
	const { move, state, side, phase } = ctx;
	const own = side === "A" ? state.players.A : state.players.B;
	const enemy = side === "A" ? state.players.B : state.players.A;
	const resourceLead = own.gold + own.wood - (enemy.gold + enemy.wood);
	const unitDiff = own.units.length - enemy.units.length;

	if (move.action === "recruit") {
		let value = 12;
		if (own.units.length < 4) value += 14;
		if (resourceLead > 4) value += 8;
		if (phase === "closing") value -= 20;
		return value;
	}

	if (move.action === "upgrade") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		let value = 10;
		if (resourceLead > 2) value += 6;
		if (unitDiff <= -1) value += 4;
		if (phase === "closing") value -= 8;
		return value;
	}

	if (move.action === "fortify") {
		if (resourceLead < 0) return -4;
		return phase === "opening" ? 4 : 0;
	}

	return 0;
}

function riskValue(ctx: ScoringContext): number {
	const { move, state, side, phase } = ctx;
	if (move.action === "attack") {
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const attacker = findUnit(state, move.unitId);
		if (!attacker || enemies.length === 0) return -5;
		const hpGap = attacker.hp - Math.max(...enemies.map((u) => u.hp));
		const fortifiedEnemies = enemies.filter((u) => u.isFortified).length;
		let value = hpGap * 4 - fortifiedEnemies * 6;
		if (phase === "closing") {
			value += 8;
		}
		return value;
	}
	if (move.action === "move") {
		const unit = findUnit(state, move.unitId);
		if (!unit) return 0;
		const enemy = side === "A" ? state.players.B : state.players.A;
		const destinationCol = colIndex(move.to);
		const exposed = enemy.units.some(
			(u) => Math.abs(colIndex(u.position) - destinationCol) <= 1,
		);
		return exposed ? -8 : 3;
	}
	if (move.action === "fortify") return 10;
	if (move.action === "end_turn" || move.action === "pass") return -2;
	return 0;
}

function timingValue(ctx: ScoringContext): number {
	const { move, state, side, turn, phase, hasLegalAttack } = ctx;
	if (move.action === "upgrade") {
		if (turn <= 10) return 16;
		if (turn <= 20) return 8;
		return -8;
	}
	if (move.action === "attack") {
		const enemies = enemyUnitsAtHex(state, side, move.target);
		const finishable = enemies.filter((u) => u.hp <= 1).length;
		let value = finishable * 22;
		if (phase === "closing") value += 16;
		if (hasLegalAttack) value += turn >= 16 ? 18 : 10;
		return value;
	}
	if (move.action === "move") {
		if (phase === "opening") return 8;
		if (phase === "closing") return -10;
		return 2;
	}
	if (move.action === "recruit") {
		if (phase === "opening") return 10;
		if (phase === "closing") return -18;
		return 0;
	}
	if (move.action === "fortify") {
		if (phase === "closing") return -8;
		return phase === "opening" ? 4 : 0;
	}
	return 0;
}

function scorePolicyAdjustments(ctx: ScoringContext): number {
	const { move, turn, hasLegalAttack, hasPlayableAlternatives, phase } = ctx;
	let score = 0;

	if (hasLegalAttack) {
		if (move.action === "attack") {
			score += turn >= 16 ? 28 : 14;
		}
		if (move.action === "move" && turn >= 22) score -= 14;
		if (move.action === "recruit" && turn >= 14) score -= 26;
	}

	if (phase === "closing") {
		if (move.action === "move") score -= 8;
		if (move.action === "recruit") score -= 16;
		if (move.action === "fortify") score -= 10;
		if (move.action === "attack") score += 14;
	}

	if (
		hasPlayableAlternatives &&
		(move.action === "end_turn" || move.action === "pass")
	) {
		score -= 100;
	}
	return score;
}

function buildWeightedTerms(
	raw: Record<UtilityTerm, number>,
	archetype: ArchetypeConfig,
	phase: BotPhase,
): {
	weights: Record<UtilityTerm, number>;
	weighted: Record<UtilityTerm, number>;
	total: number;
} {
	const weights = { ...archetype.termWeights };
	for (const key of Object.keys(
		archetype.phaseTermNudges[phase],
	) as UtilityTerm[]) {
		weights[key] += archetype.phaseTermNudges[phase][key] ?? 0;
	}

	const weighted = {
		combatValue: Math.round(raw.combatValue * weights.combatValue),
		positionValue: Math.round(raw.positionValue * weights.positionValue),
		economyValue: Math.round(raw.economyValue * weights.economyValue),
		riskValue: Math.round(raw.riskValue * weights.riskValue),
		timingValue: Math.round(raw.timingValue * weights.timingValue),
	};

	const total =
		weighted.combatValue +
		weighted.positionValue +
		weighted.economyValue +
		weighted.riskValue +
		weighted.timingValue;

	return { weights, weighted, total };
}

function buildWhyThisMove(breakdown: MoveUtilityBreakdown): string {
	const termSummary = [
		`combat=${breakdown.termsWeighted.combatValue}`,
		`position=${breakdown.termsWeighted.positionValue}`,
		`economy=${breakdown.termsWeighted.economyValue}`,
		`risk=${breakdown.termsWeighted.riskValue}`,
		`timing=${breakdown.termsWeighted.timingValue}`,
	].join(", ");
	const triggerLabel = breakdown.phaseTriggers.join("+");
	return `phase=${breakdown.phase}(${triggerLabel}) archetype=${breakdown.archetype} total=${breakdown.total}; ${termSummary}`;
}

function scoreMoveWithUtility(ctx: ScoringContext): MoveMetadata {
	const baseActionBias = ctx.archetype.actionBias[ctx.move.action] ?? 0;
	const phaseActionBias =
		ctx.archetype.phaseActionBias[ctx.phase][ctx.move.action] ?? 0;
	const promptBonus = scorePromptBias(ctx.move, ctx.promptIntents);
	const policyAdjustments = scorePolicyAdjustments(ctx);

	const rawTerms = {
		combatValue: combatValue(ctx),
		positionValue: positionValue(ctx),
		economyValue: economyValue(ctx),
		riskValue: riskValue(ctx),
		timingValue: timingValue(ctx),
	};

	const weighted = buildWeightedTerms(rawTerms, ctx.archetype, ctx.phase);
	const total =
		baseActionBias +
		phaseActionBias +
		promptBonus +
		policyAdjustments +
		weighted.total;

	const breakdown: MoveUtilityBreakdown = {
		archetype: ctx.archetype.name,
		phase: ctx.phase,
		phaseTriggers: ctx.phaseTriggers,
		baseActionBias,
		phaseActionBias,
		promptBonus,
		policyAdjustments,
		termsRaw: rawTerms,
		termWeights: weighted.weights,
		termsWeighted: weighted.weighted,
		total,
	};

	return {
		whyThisMove: buildWhyThisMove(breakdown),
		breakdown,
	};
}

function withMetadata(move: Move, metadata: MoveMetadata): Move {
	return {
		...(move as Move & {
			reasoning?: string;
			metadata?: MoveMetadata;
		}),
		reasoning: metadata.whyThisMove,
		metadata,
	} as unknown as Move;
}

/**
 * Create a mock LLM bot that simulates prompt-driven strategy selection.
 *
 * Strategy compatibility:
 * - aggressive -> timing_push
 * - defensive -> turtle_boom
 * - strategic -> map_control
 * - random stays random
 */
export function makeMockLlmBot(id: string, config: MockLlmConfig = {}): Bot {
	let fileConfig: PromptFileConfig | null = null;
	if (config.file) {
		fileConfig = loadPromptFromFile(config.file);
	}

	const strategy = config.strategy ?? fileConfig?.strategy ?? "strategic";
	const effectiveInline = config.inline ?? fileConfig?.inline;
	const promptIntents = parsePromptIntents(effectiveInline);
	const promptTag = effectiveInline?.trim().length ? "custom" : "default";

	const mappedArchetype = mapStrategyToArchetype(strategy);
	const effectiveArchetype =
		config.archetype ??
		fileConfig?.archetype ??
		(mappedArchetype
			? inferArchetypeFromIntents(mappedArchetype, promptIntents)
			: null);

	return {
		id,
		name:
			fileConfig?.botId ??
			`MockLLM[strategy=${strategy},archetype=${effectiveArchetype ?? "random"},prompt=${promptTag}]`,
		chooseMove: async ({ legalMoves, rng, state, turn }) => {
			if (strategy === "random" || !effectiveArchetype) {
				const randomMove = pickOne(legalMoves, rng);
				return withMetadata(randomMove, {
					whyThisMove:
						"phase=midgame(default) archetype=random total=0; random_pick",
					breakdown: {
						archetype: "random",
						phase: "midgame",
						phaseTriggers: ["random_strategy"],
						baseActionBias: 0,
						phaseActionBias: 0,
						promptBonus: 0,
						policyAdjustments: 0,
						termsRaw: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						termWeights: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						termsWeighted: {
							combatValue: 0,
							positionValue: 0,
							economyValue: 0,
							riskValue: 0,
							timingValue: 0,
						},
						total: 0,
					},
				});
			}

			const side = inferSide(state, id);
			const hasLegalAttack = legalMoves.some(
				(move) => move.action === "attack",
			);
			const hasPlayableAlternatives = legalMoves.some(
				(move) => move.action !== "end_turn" && move.action !== "pass",
			);
			const { phase, triggers } = resolvePhase({
				state,
				side,
				turn,
				hasLegalAttack,
			});
			const archetype = MOCK_LLM_ARCHETYPES[effectiveArchetype];

			let bestScore = Number.NEGATIVE_INFINITY;
			let bestMoves: MoveCandidate[] = [];

			for (const move of legalMoves) {
				const metadata = scoreMoveWithUtility({
					move,
					state,
					side,
					archetype,
					phase,
					phaseTriggers: triggers,
					turn,
					promptIntents,
					hasPlayableAlternatives,
					hasLegalAttack,
				});
				if (metadata.breakdown.total > bestScore) {
					bestScore = metadata.breakdown.total;
					bestMoves = [{ move, metadata }];
				} else if (metadata.breakdown.total === bestScore) {
					bestMoves.push({ move, metadata });
				}
			}

			const selected = pickOne(bestMoves, rng);
			return withMetadata(selected.move, selected.metadata);
		},
	};
}
