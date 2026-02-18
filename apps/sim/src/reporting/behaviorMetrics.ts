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
	gold: number | null;
	wood: number | null;
	terrainByHex: Record<string, string>;
	ownUnits: ParsedUnit[];
	enemyUnits: ParsedUnit[];
};

type ArtifactTurn = {
	playerID: string;
	prompt?: string;
	rawOutput?: string;
	metricsV2?: {
		actions?: {
			byTypeAccepted?: Record<string, number>;
		};
		combat?: {
			ownHpDelta?: number;
		};
		resources?: {
			ownGoldDelta?: number;
			ownWoodDelta?: number;
		};
		side?: "A" | "B";
		upgrade?: {
			upgradesAccepted?: number;
			estimatedGoldSpend?: number;
			estimatedWoodSpend?: number;
		};
	};
	commandAttempts?: Array<{
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
	archetypeSeparation: {
		actionMixSignal: Record<string, number>;
		resourceSpendCurveSignal: {
			early: number;
			mid: number;
			late: number;
			totalEstimatedSpend: number;
		};
	};
	macroIndex: {
		recruitTiming: {
			gamesWithRecruit: number;
			meanFirstRecruitTurn: number | null;
		};
		bankedResources: {
			turnsWithResourceState: number;
			avgGold: number | null;
			avgWood: number | null;
			avgTotalBanked: number | null;
		};
		nodeControlDurationProxy: {
			samples: number;
			avgControlledNodeShare: number | null;
		};
		score: number;
	};
	terrainLeverage: {
		fightsInitiated: number;
		fightsWithTerrainData: number;
		advantagedInitiations: number;
		leverageRate: number | null;
	};
	fortifyROI: {
		fortifyActionsAccepted: number;
		woodSpentEstimate: number;
		damagePreventedEstimate: number;
		roi: number | null;
		samplesAfterFortify: number;
		samplesWithoutFortify: number;
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

const ECON_NODE_TERRAINS = new Set(["gold_mine", "lumber_camp", "crown"]);

const TERRAIN_ADVANTAGE_SCORE: Record<string, number> = {
	crown: 4,
	high_ground: 3,
	hills: 2,
	forest: 1,
	lumber_camp: 1,
	gold_mine: 1,
};

function parseCol(hexId: string): number | null {
	const n = Number.parseInt(hexId.replace(/^[A-Z]/i, ""), 10);
	return Number.isFinite(n) ? n : null;
}

function parseStateFromPrompt(prompt: string | undefined): ParsedState | null {
	if (!prompt) return null;
	const stateLine = prompt
		.split("\n")
		.find((line) => line.trimStart().startsWith("STATE "));
	const stateMatch = stateLine?.match(
		/STATE\s+turn=\d+\s+player=([AB])(?:\s+actions=\d+)?\s+gold=(-?\d+)\s+wood=(-?\d+)/,
	);
	if (!stateMatch) return null;
	const side = stateMatch[1] as "A" | "B";
	const gold = Number.parseInt(stateMatch[2] ?? "", 10);
	const wood = Number.parseInt(stateMatch[3] ?? "", 10);
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
		gold: Number.isFinite(gold) ? gold : null,
		wood: Number.isFinite(wood) ? wood : null,
		terrainByHex: parseTerrainBlock(prompt),
		ownUnits: parseUnitsBlock(ownMatch[1], side),
		enemyUnits: parseUnitsBlock(enemyMatch[1], enemySide),
	};
}

function parseTerrainBlock(prompt: string): Record<string, string> {
	const terrainMatch = prompt.match(
		/TERRAIN_NEAR_UNITS:\n([\s\S]*?)(?:\n\n|\nTURN_DELTA_|\nTACTICAL_|\nLEGAL_MOVES:|$)/,
	);
	if (!terrainMatch?.[1]) return {};
	const mappings = terrainMatch[1]
		.split(/\s+/)
		.map((token) => token.trim())
		.filter(Boolean);
	const byHex: Record<string, string> = {};
	for (const mapping of mappings) {
		const eqIndex = mapping.indexOf("=");
		if (eqIndex <= 0) continue;
		const hex = mapping.slice(0, eqIndex).trim().toUpperCase();
		const terrain = mapping
			.slice(eqIndex + 1)
			.trim()
			.toLowerCase();
		if (!hex || !terrain) continue;
		byHex[hex] = terrain;
	}
	return byHex;
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

function clamp01(value: number): number {
	if (Number.isNaN(value)) return 0;
	if (value < 0) return 0;
	if (value > 1) return 1;
	return value;
}

function toPhase(i: number, total: number): "early" | "mid" | "late" {
	if (total <= 1) return "early";
	const p = i / (total - 1);
	if (p < 1 / 3) return "early";
	if (p < 2 / 3) return "mid";
	return "late";
}

function terrainScore(terrain: string | undefined): number {
	if (!terrain) return 0;
	return TERRAIN_ADVANTAGE_SCORE[terrain] ?? 0;
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
	if (existsSync(path.join(direct, "artifacts"))) {
		return path.join(direct, "artifacts");
	}
	return direct;
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
	const firstRecruitTurns: number[] = [];
	const bankedGoldSamples: number[] = [];
	const bankedWoodSamples: number[] = [];
	const nodeControlShares: number[] = [];
	const resourceSpendByPhase = {
		early: 0,
		mid: 0,
		late: 0,
	};
	let terrainFightsInitiated = 0;
	let terrainFightsWithData = 0;
	let terrainAdvantagedInitiations = 0;
	let fortifyActionsAccepted = 0;
	const ownHpLossAfterFortify: number[] = [];
	const ownHpLossWithoutFortify: number[] = [];
	let turns = 0;
	let turnsWithPrompt = 0;
	let turnsWithRawOutput = 0;
	let turnsWithReasoningField = 0;
	let parsedGames = 0;

	for (const file of files) {
		let artifact: Artifact;
		try {
			artifact = JSON.parse(readFileSync(file, "utf-8")) as Artifact;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(
				`Failed to parse artifact JSON (${file}): ${message}. Skipping file.`,
			);
			continue;
		}
		parsedGames++;
		const parsedIllegalMoves = artifact.result?.illegalMoves;
		if (
			typeof parsedIllegalMoves === "number" &&
			Number.isFinite(parsedIllegalMoves)
		) {
			illegalMoves += parsedIllegalMoves;
		}
		let gameHasUpgrade = false;
		let gameFirstUpgradeTurn: number | null = null;
		let gameUpgradeCount = 0;
		let gameUpgradeGoldSpend = 0;
		let gameUpgradeWoodSpend = 0;
		let gameFirstRecruitTurn: number | null = null;
		const lastTurnUsedFortifyBySide: Partial<Record<"A" | "B", boolean>> = {};

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
			const attempts = turn.commandAttempts ?? [];
			turns++;
			if (turn.prompt) turnsWithPrompt++;
			if (turn.rawOutput?.trim()) turnsWithRawOutput++;
			if (
				attempts.some(
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
				const upgradesAcceptedFromAttempts = attempts.filter(
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
			const sideKey = before?.side ?? turn.metricsV2?.side;
			const ownHpLoss =
				typeof turn.metricsV2?.combat?.ownHpDelta === "number"
					? Math.max(0, -turn.metricsV2.combat.ownHpDelta)
					: null;

			if (before) {
				if (before.gold !== null) bankedGoldSamples.push(before.gold);
				if (before.wood !== null) bankedWoodSamples.push(before.wood);
				if (before.ownUnits.length > 0) {
					let onNode = 0;
					for (const unit of before.ownUnits) {
						const terrain = before.terrainByHex[unit.position];
						if (terrain && ECON_NODE_TERRAINS.has(terrain)) onNode++;
					}
					nodeControlShares.push(onNode / before.ownUnits.length);
				}
			}

			const accepted = attempts.filter((a) => a.accepted);
			const acceptedFortifies = accepted.filter(
				(a) => a.move.action === "fortify",
			);
			fortifyActionsAccepted += acceptedFortifies.length;
			if (gameFirstRecruitTurn === null) {
				const hasRecruit = accepted.some((a) => a.move.action === "recruit");
				if (hasRecruit) gameFirstRecruitTurn = i + 1;
			}
			const resourceGoldSpend = Math.max(
				0,
				-(turn.metricsV2?.resources?.ownGoldDelta ?? 0),
			);
			const resourceWoodSpend = Math.max(
				0,
				-(turn.metricsV2?.resources?.ownWoodDelta ?? 0),
			);
			const resourceSpend = resourceGoldSpend + resourceWoodSpend;
			if (resourceSpend > 0) {
				const phase = toPhase(i, artifact.turns.length);
				resourceSpendByPhase[phase] += resourceSpend;
			}
			const turnAttackAttempts = accepted.filter(
				(a) => a.move.action === "attack",
			);
			attacks += turnAttackAttempts.length;
			terrainFightsInitiated += turnAttackAttempts.length;

			if (before && turnAttackAttempts.length > 0) {
				const ownById = new Map(before.ownUnits.map((u) => [u.id, u]));
				const enemyByPos = new Map(
					before.enemyUnits.map((u) => [u.position, u]),
				);
				for (const attack of turnAttackAttempts) {
					const attacker = attack.move.unitId
						? ownById.get(attack.move.unitId)
						: undefined;
					const targetPos = attack.move.target;
					if (!attacker || !targetPos) continue;
					const defender = enemyByPos.get(targetPos);
					if (!defender) continue;
					const attackerTerrain = before.terrainByHex[attacker.position];
					const defenderTerrain = before.terrainByHex[defender.position];
					if (!attackerTerrain || !defenderTerrain) continue;
					terrainFightsWithData++;
					if (terrainScore(attackerTerrain) > terrainScore(defenderTerrain)) {
						terrainAdvantagedInitiations++;
					}
				}
			}

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
				const turnOwnHpLoss = beforeOwnHp - afterOwnHp;
				const enemyUnitLoss =
					before.enemyUnits.length - after.enemyUnits.length;
				const ownUnitLoss = before.ownUnits.length - after.ownUnits.length;
				const favorable =
					enemyHpLoss > turnOwnHpLoss || enemyUnitLoss > ownUnitLoss;
				if (favorable) favorableTradeTurns++;

				const setback =
					turnOwnHpLoss > enemyHpLoss || ownUnitLoss > enemyUnitLoss;
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
						const nextAttempts = nextTurn.commandAttempts ?? [];
						const nextAccepted = nextAttempts.filter((a) => a.accepted);
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

			if (sideKey && ownHpLoss !== null) {
				if (lastTurnUsedFortifyBySide[sideKey]) {
					ownHpLossAfterFortify.push(ownHpLoss);
				} else {
					ownHpLossWithoutFortify.push(ownHpLoss);
				}
				lastTurnUsedFortifyBySide[sideKey] = acceptedFortifies.length > 0;
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
		if (gameFirstRecruitTurn !== null) {
			firstRecruitTurns.push(gameFirstRecruitTurn);
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
	const totalResourceSpend =
		resourceSpendByPhase.early +
		resourceSpendByPhase.mid +
		resourceSpendByPhase.late;
	const normalizedSpendCurve = {
		early:
			totalResourceSpend > 0
				? resourceSpendByPhase.early / totalResourceSpend
				: 0,
		mid:
			totalResourceSpend > 0
				? resourceSpendByPhase.mid / totalResourceSpend
				: 0,
		late:
			totalResourceSpend > 0
				? resourceSpendByPhase.late / totalResourceSpend
				: 0,
	};

	const meanFirstRecruitTurn =
		firstRecruitTurns.length > 0 ? mean(firstRecruitTurns) : null;
	const avgGold = bankedGoldSamples.length > 0 ? mean(bankedGoldSamples) : null;
	const avgWood = bankedWoodSamples.length > 0 ? mean(bankedWoodSamples) : null;
	const avgTotalBanked =
		avgGold !== null && avgWood !== null ? avgGold + avgWood : null;
	const avgControlledNodeShare =
		nodeControlShares.length > 0 ? mean(nodeControlShares) : null;
	const recruitTimingScore =
		meanFirstRecruitTurn !== null
			? clamp01(1 - (meanFirstRecruitTurn - 1) / 20)
			: 0;
	const bankedResourcesScore =
		avgTotalBanked !== null ? clamp01(1 - avgTotalBanked / 40) : 0;
	const nodeControlScore = avgControlledNodeShare ?? 0;
	const macroScore = clamp01(
		(recruitTimingScore + bankedResourcesScore + nodeControlScore) / 3,
	);
	const baselineLoss =
		ownHpLossWithoutFortify.length > 0 ? mean(ownHpLossWithoutFortify) : 0;
	const postFortifyLoss =
		ownHpLossAfterFortify.length > 0 ? mean(ownHpLossAfterFortify) : 0;
	const damagePreventedPerSample = Math.max(0, baselineLoss - postFortifyLoss);
	const damagePreventedEstimate =
		damagePreventedPerSample * ownHpLossAfterFortify.length;
	const woodSpentEstimate = fortifyActionsAccepted * 2;
	const fortifyRoi =
		woodSpentEstimate > 0 ? damagePreventedEstimate / woodSpentEstimate : null;

	return {
		games: parsedGames,
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
			upgradeAdoptionRate: parsedGames > 0 ? gamesWithUpgrade / parsedGames : 0,
			totalUpgradesAccepted,
			avgUpgradesPerGame:
				parsedGames > 0 ? totalUpgradesAccepted / parsedGames : 0,
			meanFirstUpgradeTurn:
				firstUpgradeTurns.length > 0 ? mean(firstUpgradeTurns) : null,
			avgEstimatedUpgradeGoldSpendPerGame:
				parsedGames > 0 ? totalEstimatedUpgradeGoldSpend / parsedGames : 0,
			avgEstimatedUpgradeWoodSpendPerGame:
				parsedGames > 0 ? totalEstimatedUpgradeWoodSpend / parsedGames : 0,
		},
		archetypeSeparation: {
			actionMixSignal: normalizedAcceptedActions,
			resourceSpendCurveSignal: {
				...normalizedSpendCurve,
				totalEstimatedSpend: totalResourceSpend,
			},
		},
		macroIndex: {
			recruitTiming: {
				gamesWithRecruit: firstRecruitTurns.length,
				meanFirstRecruitTurn,
			},
			bankedResources: {
				turnsWithResourceState: Math.min(
					bankedGoldSamples.length,
					bankedWoodSamples.length,
				),
				avgGold,
				avgWood,
				avgTotalBanked,
			},
			nodeControlDurationProxy: {
				samples: nodeControlShares.length,
				avgControlledNodeShare,
			},
			score: macroScore,
		},
		terrainLeverage: {
			fightsInitiated: terrainFightsInitiated,
			fightsWithTerrainData: terrainFightsWithData,
			advantagedInitiations: terrainAdvantagedInitiations,
			leverageRate:
				terrainFightsWithData > 0
					? terrainAdvantagedInitiations / terrainFightsWithData
					: null,
		},
		fortifyROI: {
			fortifyActionsAccepted,
			woodSpentEstimate,
			damagePreventedEstimate,
			roi: fortifyRoi,
			samplesAfterFortify: ownHpLossAfterFortify.length,
			samplesWithoutFortify: ownHpLossWithoutFortify.length,
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
