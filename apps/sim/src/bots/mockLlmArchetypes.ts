import type { Move } from "../types";

export type UtilityTerm =
	| "combatValue"
	| "positionValue"
	| "economyValue"
	| "riskValue"
	| "timingValue";

export type BotPhase = "opening" | "midgame" | "closing";

export type MockLlmArchetypeName =
	| "timing_push"
	| "greedy_macro"
	| "turtle_boom"
	| "map_control";

export interface PhasePolicy {
	openingTurnMax: number;
	closingTurnMin: number;
	closingUnitsThreshold: number;
	closingVpLeadThreshold: number;
}

export interface ArchetypeConfig {
	name: MockLlmArchetypeName;
	description: string;
	actionBias: Record<Move["action"], number>;
	termWeights: Record<UtilityTerm, number>;
	phaseActionBias: Record<BotPhase, Partial<Record<Move["action"], number>>>;
	phaseTermNudges: Record<BotPhase, Partial<Record<UtilityTerm, number>>>;
}

export const DEFAULT_PHASE_POLICY: PhasePolicy = {
	openingTurnMax: 6,
	closingTurnMin: 16,
	closingUnitsThreshold: 3,
	closingVpLeadThreshold: 3,
};

export const MOCK_LLM_ARCHETYPES: Record<
	MockLlmArchetypeName,
	ArchetypeConfig
> = {
	timing_push: {
		name: "timing_push",
		description:
			"Hit power spikes quickly and convert tempo into decisive combat.",
		actionBias: {
			attack: 94,
			move: 76,
			recruit: 42,
			fortify: 20,
			upgrade: 70,
			end_turn: -10,
			pass: -10,
		},
		termWeights: {
			combatValue: 1.3,
			positionValue: 0.8,
			economyValue: 0.6,
			riskValue: 0.7,
			timingValue: 1.35,
		},
		phaseActionBias: {
			opening: { upgrade: 18, move: 10, attack: 8 },
			midgame: { attack: 16, move: 8 },
			closing: { attack: 24, move: -8, recruit: -20, fortify: -16 },
		},
		phaseTermNudges: {
			opening: { timingValue: 0.25, economyValue: 0.15 },
			midgame: { combatValue: 0.2 },
			closing: { combatValue: 0.25, riskValue: -0.2, timingValue: 0.2 },
		},
	},
	greedy_macro: {
		name: "greedy_macro",
		description:
			"Invest in economy and upgrades before committing to full combat.",
		actionBias: {
			attack: 78,
			move: 68,
			recruit: 86,
			fortify: 30,
			upgrade: 74,
			end_turn: -4,
			pass: -4,
		},
		termWeights: {
			combatValue: 0.95,
			positionValue: 0.7,
			economyValue: 1.45,
			riskValue: 1.25,
			timingValue: 0.75,
		},
		phaseActionBias: {
			opening: { recruit: 20, upgrade: 16, attack: -8 },
			midgame: { upgrade: 10, recruit: 6 },
			closing: { attack: 22, recruit: -24, fortify: -10 },
		},
		phaseTermNudges: {
			opening: { economyValue: 0.3, riskValue: 0.2 },
			midgame: { positionValue: 0.15 },
			closing: { combatValue: 0.25, timingValue: 0.2, economyValue: -0.35 },
		},
	},
	turtle_boom: {
		name: "turtle_boom",
		description:
			"Stabilize with defensive posture, then turn resource edge into late swings.",
		actionBias: {
			attack: 72,
			move: 58,
			recruit: 74,
			fortify: 88,
			upgrade: 68,
			end_turn: 4,
			pass: 0,
		},
		termWeights: {
			combatValue: 0.9,
			positionValue: 0.85,
			economyValue: 1.1,
			riskValue: 1.55,
			timingValue: 0.75,
		},
		phaseActionBias: {
			opening: { fortify: 14, recruit: 10, attack: -6 },
			midgame: { upgrade: 10, fortify: 8 },
			closing: { attack: 20, fortify: -12, recruit: -14 },
		},
		phaseTermNudges: {
			opening: { riskValue: 0.25, economyValue: 0.15 },
			midgame: { economyValue: 0.1 },
			closing: { combatValue: 0.25, timingValue: 0.25, riskValue: -0.35 },
		},
	},
	map_control: {
		name: "map_control",
		description:
			"Contest terrain and positioning to create high quality engagements.",
		actionBias: {
			attack: 86,
			move: 82,
			recruit: 62,
			fortify: 34,
			upgrade: 64,
			end_turn: -6,
			pass: -6,
		},
		termWeights: {
			combatValue: 1.1,
			positionValue: 1.4,
			economyValue: 0.95,
			riskValue: 1.0,
			timingValue: 1.0,
		},
		phaseActionBias: {
			opening: { move: 20, recruit: 8, attack: 6 },
			midgame: { attack: 10, move: 8 },
			closing: { attack: 24, move: -4, recruit: -18, fortify: -12 },
		},
		phaseTermNudges: {
			opening: { positionValue: 0.3, economyValue: 0.1 },
			midgame: { combatValue: 0.15 },
			closing: { combatValue: 0.25, timingValue: 0.2, riskValue: -0.2 },
		},
	},
};
