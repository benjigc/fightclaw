import { MoveSchema } from "@fightclaw/engine";
import { Engine } from "../engineAdapter";
import type { AgentId, EngineEvent, MatchState, Move } from "../types";
import type { BoardgameHarnessState, MoveValidationMode } from "./types";

export function bindHarnessMatchState(
	harnessState: Pick<BoardgameHarnessState, "matchState" | "engineConfig">,
): MatchState {
	return Engine.bindEngineConfig(
		harnessState.matchState,
		harnessState.engineConfig,
	);
}

export function createPlayerMap(players: [AgentId, AgentId]) {
	const playerMap: Record<string, AgentId> = {
		"0": players[0],
		"1": players[1],
	};
	const reversePlayerMap: Record<string, string> = {
		[String(players[0])]: "0",
		[String(players[1])]: "1",
	};
	return { playerMap, reversePlayerMap };
}

export function mapActiveSideToPlayerID(state: MatchState): string {
	return state.activePlayer === "A" ? "0" : "1";
}

export function assertActivePlayerMapped(
	state: MatchState,
	players: [AgentId, AgentId],
): void {
	const expectedAgent = state.players[state.activePlayer].id;
	if (expectedAgent !== players[0] && expectedAgent !== players[1]) {
		throw new Error(
			`Engine active player ${String(expectedAgent)} is not in harness players`,
		);
	}
}

export function applyEngineMoveChecked(opts: {
	state: MatchState;
	move: Move;
	validationMode: MoveValidationMode;
}): {
	accepted: boolean;
	nextState: MatchState;
	rejectionReason?: string;
	engineEvents: EngineEvent[];
} {
	const engineMove = stripMoveAnnotations(opts.move);

	if (!MoveSchema.safeParse(engineMove).success) {
		return {
			accepted: false,
			nextState: opts.state,
			rejectionReason: "invalid_move_schema",
			engineEvents: [],
		};
	}

	if (opts.validationMode === "strict") {
		const legalMoves = Engine.listLegalMoves(opts.state);
		const legal = legalMoves.some(
			(m) => stripReasoningJson(m) === stripReasoningJson(engineMove),
		);
		if (!legal) {
			return {
				accepted: false,
				nextState: opts.state,
				rejectionReason: "illegal_move",
				engineEvents: [],
			};
		}
	}

	const result = Engine.applyMove(opts.state, engineMove);
	if (!result.ok) {
		return {
			accepted: false,
			nextState: result.state,
			rejectionReason: result.reason,
			engineEvents: result.engineEvents,
		};
	}
	return {
		accepted: true,
		nextState: result.state,
		engineEvents: result.engineEvents,
	};
}

function stripReasoningJson(move: Move): string {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return JSON.stringify(clean);
}

function stripMoveAnnotations(move: Move): Move {
	const clean = {
		...(move as Move & { reasoning?: string; metadata?: unknown }),
	};
	delete clean.reasoning;
	delete clean.metadata;
	return clean as Move;
}
