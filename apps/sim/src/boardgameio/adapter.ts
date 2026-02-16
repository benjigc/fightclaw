import { MoveSchema } from "@fightclaw/engine";
import { Engine } from "../engineAdapter";
import type { AgentId, MatchState, Move } from "../types";
import type { MoveValidationMode } from "./types";

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
	engineEventsCount: number;
} {
	if (!MoveSchema.safeParse(opts.move).success) {
		return {
			accepted: false,
			nextState: opts.state,
			rejectionReason: "invalid_move_schema",
			engineEventsCount: 0,
		};
	}

	if (opts.validationMode === "strict") {
		const legalMoves = Engine.listLegalMoves(opts.state);
		const legal = legalMoves.some(
			(m) => stripReasoningJson(m) === stripReasoningJson(opts.move),
		);
		if (!legal) {
			return {
				accepted: false,
				nextState: opts.state,
				rejectionReason: "illegal_move",
				engineEventsCount: 0,
			};
		}
	}

	const result = Engine.applyMove(opts.state, opts.move);
	if (!result.ok) {
		return {
			accepted: false,
			nextState: result.state,
			rejectionReason: result.reason,
			engineEventsCount: result.engineEvents.length,
		};
	}
	return {
		accepted: true,
		nextState: result.state,
		engineEventsCount: result.engineEvents.length,
	};
}

function stripReasoningJson(move: Move): string {
	const clean = { ...(move as Move & { reasoning?: string }) };
	delete clean.reasoning;
	return JSON.stringify(clean);
}
