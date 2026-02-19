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

type ArtifactCommandAttempt = NonNullable<
	ArtifactTurn["commandAttempts"]
>[number];
type SideTurnEntry = { idx: number; state: ParsedState };
type SideTurnIndex = Record<"A" | "B", SideTurnEntry[]>;
type PhaseSpend = Record<"early" | "mid" | "late", number>;

type UpgradeTracking = {
	hasUpgrade: boolean;
	firstUpgradeTurn: number | null;
	upgradesAccepted: number;
	estimatedGoldSpend: number;
	estimatedWoodSpend: number;
};

type AttackSnapshotOutcome = {
	finisherOpportunities: number;
	finisherSuccesses: number;
	favorableTrade: boolean;
	setback: boolean;
	attackShare: number;
};

function listArtifactFiles(artifactsDir: string): string[] {
	return readdirSync(artifactsDir)
		.filter((fileName) => fileName.endsWith(".json"))
		.map((fileName) => path.join(artifactsDir, fileName));
}

function parseArtifactFile(filePath: string): Artifact | null {
	try {
		return JSON.parse(readFileSync(filePath, "utf-8")) as Artifact;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(
			`Failed to parse artifact JSON (${filePath}): ${message}. Skipping file.`,
		);
		return null;
	}
}

function getAcceptedAttempts(
	attempts: ArtifactCommandAttempt[],
): ArtifactCommandAttempt[] {
	return attempts.filter((attempt) => attempt.accepted);
}

function countAttemptsByAction(
	attempts: ArtifactCommandAttempt[],
	action: string,
): number {
	return attempts.filter((attempt) => attempt.move.action === action).length;
}

function hasAnyReasoning(attempts: ArtifactCommandAttempt[]): boolean {
	return attempts.some(
		(attempt) =>
			typeof attempt.move?.reasoning === "string" &&
			attempt.move.reasoning.length > 0,
	);
}

function addStateResourceAndNodeSamples(
	state: ParsedState,
	bankedGoldSamples: number[],
	bankedWoodSamples: number[],
	nodeControlShares: number[],
): void {
	if (state.gold !== null) bankedGoldSamples.push(state.gold);
	if (state.wood !== null) bankedWoodSamples.push(state.wood);
	if (state.ownUnits.length === 0) return;
	let unitsOnEconomyNodes = 0;
	for (const unit of state.ownUnits) {
		const terrain = state.terrainByHex[unit.position];
		if (terrain && ECON_NODE_TERRAINS.has(terrain)) {
			unitsOnEconomyNodes++;
		}
	}
	nodeControlShares.push(unitsOnEconomyNodes / state.ownUnits.length);
}

function addTurnResourceSpend(
	turn: ArtifactTurn,
	turnIndex: number,
	totalTurns: number,
	resourceSpendByPhase: PhaseSpend,
): void {
	const resourceGoldSpend = Math.max(
		0,
		-(turn.metricsV2?.resources?.ownGoldDelta ?? 0),
	);
	const resourceWoodSpend = Math.max(
		0,
		-(turn.metricsV2?.resources?.ownWoodDelta ?? 0),
	);
	const resourceSpend = resourceGoldSpend + resourceWoodSpend;
	if (resourceSpend <= 0) return;
	const phase = toPhase(turnIndex, totalTurns);
	resourceSpendByPhase[phase] += resourceSpend;
}

function accumulateTerrainInitiationMetrics(
	before: ParsedState,
	attackAttempts: ArtifactCommandAttempt[],
): { fightsWithTerrainData: number; advantagedInitiations: number } {
	if (attackAttempts.length === 0) {
		return { fightsWithTerrainData: 0, advantagedInitiations: 0 };
	}
	let fightsWithTerrainData = 0;
	let advantagedInitiations = 0;
	const ownById = new Map(before.ownUnits.map((unit) => [unit.id, unit]));
	const enemyByPosition = new Map(
		before.enemyUnits.map((unit) => [unit.position, unit]),
	);
	for (const attack of attackAttempts) {
		const attacker = attack.move.unitId
			? ownById.get(attack.move.unitId)
			: undefined;
		const targetPosition = attack.move.target;
		if (!attacker || !targetPosition) continue;
		const defender = enemyByPosition.get(targetPosition);
		if (!defender) continue;
		const attackerTerrain = before.terrainByHex[attacker.position];
		const defenderTerrain = before.terrainByHex[defender.position];
		if (!attackerTerrain || !defenderTerrain) continue;
		fightsWithTerrainData++;
		if (terrainScore(attackerTerrain) > terrainScore(defenderTerrain)) {
			advantagedInitiations++;
		}
	}
	return { fightsWithTerrainData, advantagedInitiations };
}

function analyzeAttackSnapshotOutcome(
	before: ParsedState,
	after: ParsedState,
	attackAttempts: ArtifactCommandAttempt[],
	acceptedAttempts: ArtifactCommandAttempt[],
): AttackSnapshotOutcome {
	let finisherOpportunities = 0;
	let finisherSuccesses = 0;
	const enemyByPosition = new Map(
		before.enemyUnits.map((unit) => [unit.position, unit]),
	);
	const survivingEnemyIds = new Set(after.enemyUnits.map((unit) => unit.id));

	for (const attack of attackAttempts) {
		const targetPosition = attack.move.target;
		if (!targetPosition) continue;
		const targetUnit = enemyByPosition.get(targetPosition);
		if (!targetUnit) continue;
		if (targetUnit.hp <= 1) {
			finisherOpportunities++;
			if (!survivingEnemyIds.has(targetUnit.id)) {
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
	const enemyUnitLoss = before.enemyUnits.length - after.enemyUnits.length;
	const ownUnitLoss = before.ownUnits.length - after.ownUnits.length;

	return {
		finisherOpportunities,
		finisherSuccesses,
		favorableTrade: enemyHpLoss > ownHpLoss || enemyUnitLoss > ownUnitLoss,
		setback: ownHpLoss > enemyHpLoss || ownUnitLoss > enemyUnitLoss,
		attackShare: attackAttempts.length / Math.max(1, acceptedAttempts.length),
	};
}

function findNextSideTurnIndex(
	entries: SideTurnEntry[],
	currentIndex: number,
): number | undefined {
	return entries.find((entry) => entry.idx > currentIndex)?.idx;
}

function isAdaptedFollowup(
	nextAcceptedAttempts: ArtifactCommandAttempt[],
	currentAttackShare: number,
): boolean {
	const nextAttackShare =
		countAttemptsByAction(nextAcceptedAttempts, "attack") /
		Math.max(1, nextAcceptedAttempts.length);
	const usedRecoveryAction = nextAcceptedAttempts.some(
		(attempt) =>
			attempt.move.action === "recruit" || attempt.move.action === "fortify",
	);
	return usedRecoveryAction || nextAttackShare <= currentAttackShare - 0.25;
}

function maybeRecordUpgradeTurn(
	turn: ArtifactTurn,
	acceptedAttempts: ArtifactCommandAttempt[],
	turnNumber: number,
	tracking: UpgradeTracking,
): void {
	const upgradeMetrics = turn.metricsV2?.upgrade;
	const upgradesAcceptedFromMetrics = upgradeMetrics?.upgradesAccepted ?? 0;
	if (upgradesAcceptedFromMetrics > 0) {
		tracking.hasUpgrade = true;
		tracking.upgradesAccepted += upgradesAcceptedFromMetrics;
		tracking.estimatedGoldSpend += upgradeMetrics?.estimatedGoldSpend ?? 0;
		tracking.estimatedWoodSpend += upgradeMetrics?.estimatedWoodSpend ?? 0;
		if (tracking.firstUpgradeTurn === null) {
			tracking.firstUpgradeTurn = turnNumber;
		}
		return;
	}

	const upgradesAcceptedFromAttempts = countAttemptsByAction(
		acceptedAttempts,
		"upgrade",
	);
	if (upgradesAcceptedFromAttempts <= 0) return;
	tracking.hasUpgrade = true;
	tracking.upgradesAccepted += upgradesAcceptedFromAttempts;
	if (tracking.firstUpgradeTurn === null) {
		tracking.firstUpgradeTurn = turnNumber;
	}
}

function collectPositionalProgressionDeltas(sideTurnIndex: SideTurnIndex): {
	A: number | null;
	B: number | null;
} {
	const computeDelta = (side: "A" | "B"): number | null => {
		const targetCol = side === "A" ? 20 : 2;
		const series = sideTurnIndex[side]
			.sort((left, right) => left.idx - right.idx)
			.map((entry) => {
				const distances = entry.state.ownUnits
					.map((unit) => parseCol(unit.position))
					.filter((value): value is number => value !== null)
					.map((col) => Math.abs(col - targetCol));
				return distances.length > 0 ? mean(distances) : null;
			})
			.filter((value): value is number => value !== null);
		if (series.length < 2) return null;
		const first = series[0];
		const last = series[series.length - 1];
		if (first === undefined || last === undefined) return null;
		return last - first;
	};

	return {
		A: computeDelta("A"),
		B: computeDelta("B"),
	};
}

function sortedActionEntries(
	acceptedActionCounts: Map<string, number>,
): Array<[string, number]> {
	return Array.from(acceptedActionCounts.entries()).sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
}

export function analyzeBehaviorFromArtifacts(input: string): BehaviorSummary {
	const artifactsDir = resolveArtifactsDir(input);
	const files = listArtifactFiles(artifactsDir);

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
		const artifact = parseArtifactFile(file);
		if (!artifact) continue;
		parsedGames++;

		const parsedIllegalMoves = artifact.result?.illegalMoves;
		if (
			typeof parsedIllegalMoves === "number" &&
			Number.isFinite(parsedIllegalMoves)
		) {
			illegalMoves += parsedIllegalMoves;
		}
		const upgradeTracking: UpgradeTracking = {
			hasUpgrade: false,
			firstUpgradeTurn: null,
			upgradesAccepted: 0,
			estimatedGoldSpend: 0,
			estimatedWoodSpend: 0,
		};
		let gameFirstRecruitTurn: number | null = null;
		const lastTurnUsedFortifyBySide: Partial<Record<"A" | "B", boolean>> = {};

		const gameActionCounts = new Map<string, number>();
		for (const acceptedMove of artifact.acceptedMoves ?? []) {
			const action = acceptedMove.engineMove?.action ?? "unknown";
			gameActionCounts.set(action, (gameActionCounts.get(action) ?? 0) + 1);
			acceptedActionCounts.set(
				action,
				(acceptedActionCounts.get(action) ?? 0) + 1,
			);
		}
		if (gameActionCounts.size > 0) {
			gamesWithAcceptedMoves++;
			uniqueActionCounts.push(gameActionCounts.size);
			entropies.push(shannonEntropy(gameActionCounts));
		}

		const sideTurns: SideTurnIndex = {
			A: [],
			B: [],
		};
		const parsedStates: Array<ParsedState | null> = artifact.turns.map((turn) =>
			parseStateFromPrompt(turn.prompt),
		);
		for (let stateIndex = 0; stateIndex < parsedStates.length; stateIndex++) {
			const state = parsedStates[stateIndex];
			if (!state) continue;
			sideTurns[state.side].push({ idx: stateIndex, state });
		}

		for (let turnIndex = 0; turnIndex < artifact.turns.length; turnIndex++) {
			const turn = artifact.turns[turnIndex];
			if (!turn) continue;
			const attempts = turn.commandAttempts ?? [];
			const acceptedAttempts = getAcceptedAttempts(attempts);

			turns++;
			if (turn.prompt) turnsWithPrompt++;
			if (turn.rawOutput?.trim()) turnsWithRawOutput++;
			if (hasAnyReasoning(attempts)) {
				turnsWithReasoningField++;
			}

			maybeRecordUpgradeTurn(
				turn,
				acceptedAttempts,
				turnIndex + 1,
				upgradeTracking,
			);

			const before = parsedStates[turnIndex];
			const after =
				turnIndex + 1 < parsedStates.length
					? parsedStates[turnIndex + 1]
					: null;
			const sideKey = before?.side ?? turn.metricsV2?.side;
			const ownHpLoss =
				typeof turn.metricsV2?.combat?.ownHpDelta === "number"
					? Math.max(0, -turn.metricsV2.combat.ownHpDelta)
					: null;

			if (before) {
				addStateResourceAndNodeSamples(
					before,
					bankedGoldSamples,
					bankedWoodSamples,
					nodeControlShares,
				);
			}

			const acceptedFortifyCount = countAttemptsByAction(
				acceptedAttempts,
				"fortify",
			);
			fortifyActionsAccepted += acceptedFortifyCount;
			if (gameFirstRecruitTurn === null) {
				const hasRecruit = acceptedAttempts.some(
					(attempt) => attempt.move.action === "recruit",
				);
				if (hasRecruit) gameFirstRecruitTurn = turnIndex + 1;
			}

			addTurnResourceSpend(
				turn,
				turnIndex,
				artifact.turns.length,
				resourceSpendByPhase,
			);

			const turnAttackAttempts = acceptedAttempts.filter(
				(attempt) => attempt.move.action === "attack",
			);
			attacks += turnAttackAttempts.length;
			terrainFightsInitiated += turnAttackAttempts.length;

			if (before && turnAttackAttempts.length > 0) {
				const terrainMetrics = accumulateTerrainInitiationMetrics(
					before,
					turnAttackAttempts,
				);
				terrainFightsWithData += terrainMetrics.fightsWithTerrainData;
				terrainAdvantagedInitiations += terrainMetrics.advantagedInitiations;
			}

			if (before && after && turnAttackAttempts.length > 0) {
				attackTurnsWithSnapshot++;
				const snapshotOutcome = analyzeAttackSnapshotOutcome(
					before,
					after,
					turnAttackAttempts,
					acceptedAttempts,
				);
				finisherOpportunities += snapshotOutcome.finisherOpportunities;
				finisherSuccesses += snapshotOutcome.finisherSuccesses;
				if (snapshotOutcome.favorableTrade) favorableTradeTurns++;

				if (snapshotOutcome.setback) {
					setbackTurns++;
					const nextSameSideIdx = findNextSideTurnIndex(
						sideTurns[before.side],
						turnIndex,
					);
					if (nextSameSideIdx !== undefined) {
						followupTurns++;
						const nextTurn = artifact.turns[nextSameSideIdx];
						if (!nextTurn) continue;
						const nextAcceptedAttempts = getAcceptedAttempts(
							nextTurn.commandAttempts ?? [],
						);
						if (
							isAdaptedFollowup(
								nextAcceptedAttempts,
								snapshotOutcome.attackShare,
							)
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
				lastTurnUsedFortifyBySide[sideKey] = acceptedFortifyCount > 0;
			}
		}

		if (upgradeTracking.hasUpgrade) {
			gamesWithUpgrade++;
			totalUpgradesAccepted += upgradeTracking.upgradesAccepted;
			totalEstimatedUpgradeGoldSpend += upgradeTracking.estimatedGoldSpend;
			totalEstimatedUpgradeWoodSpend += upgradeTracking.estimatedWoodSpend;
			if (upgradeTracking.firstUpgradeTurn !== null) {
				firstUpgradeTurns.push(upgradeTracking.firstUpgradeTurn);
			}
		}
		if (gameFirstRecruitTurn !== null) {
			firstRecruitTurns.push(gameFirstRecruitTurn);
		}

		const progressionDelta = collectPositionalProgressionDeltas(sideTurns);
		if (progressionDelta.A !== null) progressionA.push(progressionDelta.A);
		if (progressionDelta.B !== null) progressionB.push(progressionDelta.B);
	}

	const acceptedActionTotal = Array.from(acceptedActionCounts.values()).reduce(
		(sum, value) => sum + value,
		0,
	);
	const sortedActionCounts = sortedActionEntries(acceptedActionCounts);
	const acceptedActionCountsObj = Object.fromEntries(sortedActionCounts);
	const normalizedAcceptedActions = Object.fromEntries(
		sortedActionCounts.map(([action, count]) => [
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
