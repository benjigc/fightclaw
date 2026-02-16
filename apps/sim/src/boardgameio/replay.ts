import { Engine } from "../engineAdapter";
import { createCombatScenario } from "../scenarios/combatScenarios";
import type { MatchState } from "../types";
import { sha256, stableStringify } from "./artifact";
import type { MatchArtifact, ReplayResult } from "./types";

export function replayBoardgameArtifact(artifact: MatchArtifact): ReplayResult {
	let state: MatchState = artifact.scenario
		? createCombatScenario(
				artifact.seed,
				artifact.participants,
				artifact.scenario,
			)
		: Engine.createInitialState(artifact.seed, artifact.participants);

	for (const entry of artifact.acceptedMoves) {
		const preHash = hashState(state);
		if (preHash !== entry.preHash) {
			return {
				ok: false,
				error: `Pre-state hash mismatch at ply ${entry.ply}`,
			};
		}
		const result = Engine.applyMove(state, entry.engineMove);
		if (!result.ok) {
			return {
				ok: false,
				error: `Engine rejected move during replay at ply ${entry.ply}: ${result.reason}`,
			};
		}
		state = result.state;
		const postHash = hashState(state);
		if (postHash !== entry.postHash) {
			return {
				ok: false,
				error: `Post-state hash mismatch at ply ${entry.ply}`,
			};
		}
	}

	const finalStateHash = hashState(state);
	if (finalStateHash !== artifact.finalStateHash) {
		return {
			ok: false,
			error: "Final state hash mismatch",
			finalStateHash,
		};
	}

	return {
		ok: true,
		finalStateHash,
	};
}

function hashState(state: MatchState): string {
	return sha256(stableStringify(state));
}
