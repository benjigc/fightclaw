import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

type ParsedUnit = {
	id: string;
	side: "A" | "B";
	position: string;
	hp: number;
	maxHp: number;
};

type ParsedState = {
	side: "A" | "B";
	ownUnits: ParsedUnit[];
	enemyUnits: ParsedUnit[];
};

type ArtifactTurn = {
	playerID: string;
	prompt?: string;
	rawOutput?: string;
	metricsV2?: {
		upgrade?: {
			upgradesAccepted?: number;
			estimatedGoldSpend?: number;
			estimatedWoodSpend?: number;
		};
	};
	commandAttempts: Array<{
		accepted: boolean;
		rejectionReason?: string;
		move: {
			action: string;
			unitId?: string;
			target?: string;
			to?: string;
			reasoning?: string;
		};
	}>;
};

type Artifact = {
	participants: [string, string];
	turns: ArtifactTurn[];
	result: {
		winner: string | null;
		reason: string;
		illegalMoves: number;
		turns: number;
	};
	acceptedMoves: Array<{
		playerID: string;
		engineMove: {
			action: string;
		};
	}>;
	seed?: number;
	scenario?: string;
};

type BehaviorSummary = {
	games: number;
	illegalMoves: number;
	attackTimingQuality: {
		attacks: number;
		finisherOpportunities: number;
		finisherSuccesses: number;
		finisherRate: number | null;
		attackTurnsWithSnapshot: number;
		favorableTradeTurns: number;
		favorableTradeRate: number | null;
	};
	positionalProgression: {
		A: { games: number; avgDeltaDistanceToEnemyStronghold: number | null };
		B: { games: number; avgDeltaDistanceToEnemyStronghold: number | null };
	};
	adaptation: {
		setbackTurns: number;
		followupTurns: number;
		adaptedFollowups: number;
		adaptationRate: number | null;
	};
	actionDiversity: {
		gamesWithAcceptedMoves: number;
		avgUniqueActions: number;
		avgShannonEntropy: number;
	};
	actionProfile: {
		acceptedActionCounts: Record<string, number>;
		normalizedAcceptedActions: Record<string, number>;
	};
	upgradeEconomy: {
		gamesWithUpgrade: number;
		upgradeAdoptionRate: number;
		totalUpgradesAccepted: number;
		avgUpgradesPerGame: number;
		meanFirstUpgradeTurn: number | null;
		avgEstimatedUpgradeGoldSpendPerGame: number;
		avgEstimatedUpgradeWoodSpendPerGame: number;
	};
	telemetryCoverage: {
		turns: number;
		turnsWithPrompt: number;
		turnsWithRawOutput: number;
		turnsWithReasoningField: number;
		reasoningCoverageRate: number;
		rawOutputCoverageRate: number;
	};
};

function parseCol(hexId: string): number | null {
	const n = Number.parseInt(hexId.replace(/^[A-Z]/i, ""), 10);
	return Number.isFinite(n) ? n : null;
}

function parseStateFromPrompt(prompt: string | undefined): ParsedState | null {
	if (!prompt) return null;
	const stateMatch = prompt.match(/STATE\s+turn=\d+\s+player=([AB])/);
	if (!stateMatch) return null;
	const side = stateMatch[1] as "A" | "B";
	const ownMatch = prompt.match(
		new RegExp(`UNITS_${side}:([\\s\\S]*?)(?:\\n\\n|\\nUNITS_)`),
	);
	const enemySide = side === "A" ? "B" : "A";
	const enemyMatch = prompt.match(
		new RegExp(
			`UNITS_${enemySide}:([\\s\\S]*?)(?:\\n\\n|\\nTERRAIN_|\\nTURN_DELTA_|\\nTACTICAL_|\\nLEGAL_MOVES:)`,
		),
	);
	if (!ownMatch || !enemyMatch) return null;
	return {
		side,
		ownUnits: parseUnitsBlock(ownMatch[1], side),
		enemyUnits: parseUnitsBlock(enemyMatch[1], enemySide),
	};
}

function parseUnitsBlock(block: string, side: "A" | "B"): ParsedUnit[] {
	const lines = block
		.split("\n")
		.map((l) => l.trim())
		.filter(Boolean);
	const units: ParsedUnit[] = [];
	for (const line of lines) {
		const m = line.match(/^([AB]-\d+)\s+\w+\s+([A-Z]\d+)\s+hp=(\d+)\/(\d+)/);
		if (!m) continue;
		const id = m[1];
		const position = m[2];
		const hpRaw = m[3];
		const maxHpRaw = m[4];
		if (!id || !position || !hpRaw || !maxHpRaw) continue;
		units.push({
			id,
			side,
			position,
			hp: Number.parseInt(hpRaw, 10),
			maxHp: Number.parseInt(maxHpRaw, 10),
		});
	}
	return units;
}

function sumHp(units: ParsedUnit[]): number {
	return units.reduce((s, u) => s + u.hp, 0);
}

function mean(values: number[]): number {
	if (values.length === 0) return 0;
	return values.reduce((s, v) => s + v, 0) / values.length;
}

function shannonEntropy(counts: Map<string, number>): number {
	let total = 0;
	for (const v of counts.values()) total += v;
	if (total <= 0) return 0;
	let h = 0;
	for (const v of counts.values()) {
		if (v <= 0) continue;
		const p = v / total;
		h -= p * Math.log2(p);
	}
	return h;
}

function resolveArtifactsDir(input: string): string {
	const direct = path.resolve(input);
	if (!existsSync(direct)) {
		throw new Error(`Input path not found: ${direct}`);
	}
	const statPath = path.resolve(direct);
	if (existsSync(path.join(statPath, "artifacts"))) {
		return path.join(statPath, "artifacts");
	}
	return statPath;
}

export function analyzeBehaviorFromArtifacts(input: string): BehaviorSummary {
	const artifactsDir = resolveArtifactsDir(input);
	const files = readdirSync(artifactsDir)
		.filter((f) => f.endsWith(".json"))
		.map((f) => path.join(artifactsDir, f));

	let illegalMoves = 0;
	let attacks = 0;
	let finisherOpportunities = 0;
	let finisherSuccesses = 0;
	let attackTurnsWithSnapshot = 0;
	let favorableTradeTurns = 0;
	const progressionA: number[] = [];
	const progressionB: number[] = [];
	let setbackTurns = 0;
	let followupTurns = 0;
	let adaptedFollowups = 0;
	let gamesWithAcceptedMoves = 0;
	const uniqueActionCounts: number[] = [];
	const entropies: number[] = [];
	const acceptedActionCounts = new Map<string, number>();
	let gamesWithUpgrade = 0;
	let totalUpgradesAccepted = 0;
	let totalEstimatedUpgradeGoldSpend = 0;
	let totalEstimatedUpgradeWoodSpend = 0;
	const firstUpgradeTurns: number[] = [];
	let turns = 0;
	let turnsWithPrompt = 0;
	let turnsWithRawOutput = 0;
	let turnsWithReasoningField = 0;

	for (const file of files) {
		const artifact = JSON.parse(readFileSync(file, "utf-8")) as Artifact;
		illegalMoves += artifact.result?.illegalMoves ?? 0;
		let gameHasUpgrade = false;
		let gameFirstUpgradeTurn: number | null = null;
		let gameUpgradeCount = 0;
		let gameUpgradeGoldSpend = 0;
		let gameUpgradeWoodSpend = 0;

		const actionCounts = new Map<string, number>();
		for (const mv of artifact.acceptedMoves ?? []) {
			const action = mv.engineMove?.action ?? "unknown";
			actionCounts.set(action, (actionCounts.get(action) ?? 0) + 1);
			acceptedActionCounts.set(
				action,
				(acceptedActionCounts.get(action) ?? 0) + 1,
			);
		}
		if (actionCounts.size > 0) {
			gamesWithAcceptedMoves++;
			uniqueActionCounts.push(actionCounts.size);
			entropies.push(shannonEntropy(actionCounts));
		}

		const sideTurns: Record<
			"A" | "B",
			Array<{ idx: number; state: ParsedState }>
		> = {
			A: [],
			B: [],
		};
		const parsedStates: Array<ParsedState | null> = artifact.turns.map((t) =>
			parseStateFromPrompt(t.prompt),
		);
		for (let i = 0; i < parsedStates.length; i++) {
			const ps = parsedStates[i];
			if (!ps) continue;
			sideTurns[ps.side].push({ idx: i, state: ps });
		}

		for (let i = 0; i < artifact.turns.length; i++) {
			const turn = artifact.turns[i];
			if (!turn) continue;
			turns++;
			if (turn.prompt) turnsWithPrompt++;
			if (turn.rawOutput?.trim()) turnsWithRawOutput++;
			if (
				turn.commandAttempts.some(
					(attempt) =>
						typeof attempt.move?.reasoning === "string" &&
						attempt.move.reasoning.length > 0,
				)
			) {
				turnsWithReasoningField++;
			}

			const metricsUpgrade = turn.metricsV2?.upgrade;
			const upgradesAcceptedFromMetrics = metricsUpgrade?.upgradesAccepted ?? 0;
			if (upgradesAcceptedFromMetrics > 0) {
				gameHasUpgrade = true;
				gameUpgradeCount += upgradesAcceptedFromMetrics;
				gameUpgradeGoldSpend += metricsUpgrade?.estimatedGoldSpend ?? 0;
				gameUpgradeWoodSpend += metricsUpgrade?.estimatedWoodSpend ?? 0;
				if (gameFirstUpgradeTurn === null) {
					gameFirstUpgradeTurn = i + 1;
				}
			} else {
				const upgradesAcceptedFromAttempts = turn.commandAttempts.filter(
					(a) => a.accepted && a.move.action === "upgrade",
				).length;
				if (upgradesAcceptedFromAttempts > 0) {
					gameHasUpgrade = true;
					gameUpgradeCount += upgradesAcceptedFromAttempts;
					if (gameFirstUpgradeTurn === null) {
						gameFirstUpgradeTurn = i + 1;
					}
				}
			}

			const before = parsedStates[i];
			const after = i + 1 < parsedStates.length ? parsedStates[i + 1] : null;

			const accepted = turn.commandAttempts.filter((a) => a.accepted);
			const turnAttackAttempts = accepted.filter(
				(a) => a.move.action === "attack",
			);
			attacks += turnAttackAttempts.length;

			if (before && after && turnAttackAttempts.length > 0) {
				attackTurnsWithSnapshot++;
				const enemyByPos = new Map(
					before.enemyUnits.map((u) => [u.position, u]),
				);
				const afterEnemyIds = new Set(after.enemyUnits.map((u) => u.id));

				for (const a of turnAttackAttempts) {
					const targetPos = a.move.target;
					if (!targetPos) continue;
					const targetUnit = enemyByPos.get(targetPos);
					if (!targetUnit) continue;
					if (targetUnit.hp <= 1) {
						finisherOpportunities++;
						if (!afterEnemyIds.has(targetUnit.id)) {
							finisherSuccesses++;
						}
					}
				}

				const beforeEnemyHp = sumHp(before.enemyUnits);
				const beforeOwnHp = sumHp(before.ownUnits);
				const afterEnemyHp = sumHp(after.enemyUnits);
				const afterOwnHp = sumHp(after.ownUnits);
				const enemyHpLoss = beforeEnemyHp - afterEnemyHp;
				const ownHpLoss = beforeOwnHp - afterOwnHp;
				const enemyUnitLoss =
					before.enemyUnits.length - after.enemyUnits.length;
				const ownUnitLoss = before.ownUnits.length - after.ownUnits.length;
				const favorable =
					enemyHpLoss > ownHpLoss || enemyUnitLoss > ownUnitLoss;
				if (favorable) favorableTradeTurns++;

				const setback = ownHpLoss > enemyHpLoss || ownUnitLoss > enemyUnitLoss;
				if (setback) {
					setbackTurns++;
					const side = before.side;
					const nextSameSideIdx = sideTurns[side].find((t) => t.idx > i)?.idx;
					if (nextSameSideIdx !== undefined) {
						followupTurns++;
						const thisAttackShare =
							turnAttackAttempts.length / Math.max(1, accepted.length);
						const nextTurn = artifact.turns[nextSameSideIdx];
						if (!nextTurn) continue;
						const nextAccepted = nextTurn.commandAttempts.filter(
							(a) => a.accepted,
						);
						const nextAttackShare =
							nextAccepted.filter((a) => a.move.action === "attack").length /
							Math.max(1, nextAccepted.length);
						const usedRecoveryAction = nextAccepted.some(
							(a) => a.move.action === "recruit" || a.move.action === "fortify",
						);
						if (
							usedRecoveryAction ||
							nextAttackShare <= thisAttackShare - 0.25
						) {
							adaptedFollowups++;
						}
					}
				}
			}
		}

		if (gameHasUpgrade) {
			gamesWithUpgrade++;
			totalUpgradesAccepted += gameUpgradeCount;
			totalEstimatedUpgradeGoldSpend += gameUpgradeGoldSpend;
			totalEstimatedUpgradeWoodSpend += gameUpgradeWoodSpend;
			if (gameFirstUpgradeTurn !== null) {
				firstUpgradeTurns.push(gameFirstUpgradeTurn);
			}
		}

		for (const side of ["A", "B"] as const) {
			const series = sideTurns[side]
				.sort((a, b) => a.idx - b.idx)
				.map((x) => {
					const targetCol = side === "A" ? 20 : 2;
					const dists = x.state.ownUnits
						.map((u) => parseCol(u.position))
						.filter((v): v is number => v !== null)
						.map((col) => Math.abs(col - targetCol));
					return dists.length > 0 ? mean(dists) : null;
				})
				.filter((v): v is number => v !== null);
			if (series.length >= 2) {
				const first = series[0];
				const last = series[series.length - 1];
				if (first === undefined || last === undefined) continue;
				const delta = last - first;
				if (side === "A") progressionA.push(delta);
				else progressionB.push(delta);
			}
		}
	}

	const acceptedActionTotal = Array.from(acceptedActionCounts.values()).reduce(
		(sum, value) => sum + value,
		0,
	);
	const acceptedActionCountsObj = Object.fromEntries(
		Array.from(acceptedActionCounts.entries()).sort((a, b) =>
			a[0].localeCompare(b[0]),
		),
	);
	const normalizedAcceptedActions = Object.fromEntries(
		Array.from(acceptedActionCounts.entries())
			.sort((a, b) => a[0].localeCompare(b[0]))
			.map(([action, count]) => [
				action,
				acceptedActionTotal > 0 ? count / acceptedActionTotal : 0,
			]),
	);

	return {
		games: files.length,
		illegalMoves,
		attackTimingQuality: {
			attacks,
			finisherOpportunities,
			finisherSuccesses,
			finisherRate:
				finisherOpportunities > 0
					? finisherSuccesses / finisherOpportunities
					: null,
			attackTurnsWithSnapshot,
			favorableTradeTurns,
			favorableTradeRate:
				attackTurnsWithSnapshot > 0
					? favorableTradeTurns / attackTurnsWithSnapshot
					: null,
		},
		positionalProgression: {
			A: {
				games: progressionA.length,
				avgDeltaDistanceToEnemyStronghold:
					progressionA.length > 0 ? mean(progressionA) : null,
			},
			B: {
				games: progressionB.length,
				avgDeltaDistanceToEnemyStronghold:
					progressionB.length > 0 ? mean(progressionB) : null,
			},
		},
		adaptation: {
			setbackTurns,
			followupTurns,
			adaptedFollowups,
			adaptationRate:
				followupTurns > 0 ? adaptedFollowups / followupTurns : null,
		},
		actionDiversity: {
			gamesWithAcceptedMoves,
			avgUniqueActions:
				uniqueActionCounts.length > 0 ? mean(uniqueActionCounts) : 0,
			avgShannonEntropy: entropies.length > 0 ? mean(entropies) : 0,
		},
		actionProfile: {
			acceptedActionCounts: acceptedActionCountsObj,
			normalizedAcceptedActions,
		},
		upgradeEconomy: {
			gamesWithUpgrade,
			upgradeAdoptionRate:
				files.length > 0 ? gamesWithUpgrade / files.length : 0,
			totalUpgradesAccepted,
			avgUpgradesPerGame:
				files.length > 0 ? totalUpgradesAccepted / files.length : 0,
			meanFirstUpgradeTurn:
				firstUpgradeTurns.length > 0 ? mean(firstUpgradeTurns) : null,
			avgEstimatedUpgradeGoldSpendPerGame:
				files.length > 0 ? totalEstimatedUpgradeGoldSpend / files.length : 0,
			avgEstimatedUpgradeWoodSpendPerGame:
				files.length > 0 ? totalEstimatedUpgradeWoodSpend / files.length : 0,
		},
		telemetryCoverage: {
			turns,
			turnsWithPrompt,
			turnsWithRawOutput,
			turnsWithReasoningField,
			reasoningCoverageRate: turns > 0 ? turnsWithReasoningField / turns : 0,
			rawOutputCoverageRate: turns > 0 ? turnsWithRawOutput / turns : 0,
		},
	};
}
