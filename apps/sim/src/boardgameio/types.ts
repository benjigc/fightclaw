import type { AgentId, EngineConfigInput, MatchState, Move } from "../types";

export type ScenarioName = "melee" | "ranged" | "stronghold_rush" | "midfield";

export type HarnessMode = "legacy" | "boardgameio";

export type InvalidPolicy = "skip" | "stop_turn" | "forfeit";

export type MoveValidationMode = "strict" | "relaxed";

export interface HarnessOptions {
	harness?: HarnessMode;
	invalidPolicy?: InvalidPolicy;
	strict?: boolean;
	moveValidationMode?: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt?: boolean;
	storeFullOutput?: boolean;
}

export interface HarnessConfig {
	seed: number;
	players: [AgentId, AgentId];
	maxTurns: number;
	engineConfig?: EngineConfigInput;
	scenario?: ScenarioName;
	invalidPolicy: InvalidPolicy;
	strict: boolean;
	moveValidationMode: MoveValidationMode;
	artifactDir?: string;
	storeFullPrompt: boolean;
	storeFullOutput: boolean;
}

export interface BoardgameHarnessState {
	matchState: MatchState;
	turnIndex: number;
	playerMap: Record<string, AgentId>;
	reversePlayerMap: Record<string, string>;
}

export interface MoveApplyPayload {
	move: Move;
	turnIndex: number;
	commandIndex: number;
}

export interface TurnPlanMeta {
	turnIndex: number;
	prompt?: string;
	rawOutput?: string;
	model?: string;
}

export interface CommandAttempt {
	commandIndex: number;
	move: Move;
	accepted: boolean;
	rejectionReason?: string;
}

export interface AcceptedMoveRecord {
	ply: number;
	playerID: string;
	engineMove: Move;
	preHash: string;
	postHash: string;
}

export interface TurnArtifact {
	turnIndex: number;
	playerID: string;
	promptHash: string;
	outputHash: string;
	prompt?: string;
	rawOutput?: string;
	model?: string;
	commandAttempts: CommandAttempt[];
}

export interface MatchArtifact {
	artifactVersion: 1;
	hashAlgo: "sha256";
	stateHashInput: "stable-json-sorted-keys-v1";
	engineRulesVersion: string;
	simHarnessVersion: string;
	redactionApplied: boolean;
	seed: number;
	scenario?: ScenarioName;
	participants: [AgentId, AgentId];
	invalidPolicy: InvalidPolicy;
	acceptedMoves: AcceptedMoveRecord[];
	turns: TurnArtifact[];
	result: {
		winner: AgentId | null;
		reason: "terminal" | "maxTurns" | "illegal";
		turns: number;
		illegalMoves: number;
	};
	finalStateHash: string;
	bgioLog?: unknown[] | null;
	truncated?: {
		promptBytes: number;
		outputBytes: number;
	};
}

export interface ReplayResult {
	ok: boolean;
	error?: string;
	finalStateHash?: string;
}
