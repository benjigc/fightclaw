import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs";
import path from "node:path";
import {
	createInitialState,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import minimist from "minimist";
import type { MatchArtifact, ScenarioName } from "../src/boardgameio/types";
import { createCombatScenario } from "../src/scenarios/combatScenarios";

type ReplayStep = {
	ply: number;
	playerID: string;
	move: Move;
	preHash: string;
	postHash: string;
};

type ReplayMatch = {
	id: string;
	label: string;
	scenario: ScenarioName | null;
	seed: number;
	participants: [string, string];
	result: MatchArtifact["result"];
	initialState: MatchState;
	steps: ReplayStep[];
};

type ReplayBundle = {
	version: 1;
	generatedAt: string;
	runDir: string;
	summaryPath: string | null;
	matchCount: number;
	matches: ReplayMatch[];
};

type Args = {
	run?: string;
	output?: string;
	latest?: boolean;
	quiet?: boolean;
};

function resolveRunDir(args: Args): string {
	if (args.run) {
		const resolved = path.resolve(process.cwd(), args.run);
		if (!existsSync(resolved)) {
			throw new Error(`Run directory not found: ${resolved}`);
		}
		return resolved;
	}

	const resultsDir = path.resolve(process.cwd(), "results");
	if (!existsSync(resultsDir)) {
		throw new Error(`Results directory not found: ${resultsDir}`);
	}

	const candidates = readdirSync(resultsDir, { withFileTypes: true })
		.filter(
			(entry) => entry.isDirectory() && entry.name.startsWith("benchmark_v2_"),
		)
		.map((entry) => path.join(resultsDir, entry.name))
		.filter((dir) => existsSync(path.join(dir, "api_lane")))
		.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);

	const latest = candidates[0];
	if (!latest) {
		throw new Error(
			"No benchmark_v2 run with api_lane found in apps/sim/results",
		);
	}
	return latest;
}

function findArtifactFiles(runDir: string): string[] {
	const apiLaneDir = path.join(runDir, "api_lane");
	if (!existsSync(apiLaneDir)) {
		throw new Error(`api_lane directory not found in run: ${runDir}`);
	}

	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				walk(full);
				continue;
			}
			if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
			if (!full.includes(`${path.sep}artifacts${path.sep}`)) continue;
			out.push(full);
		}
	};

	walk(apiLaneDir);
	return out.sort((a, b) => a.localeCompare(b));
}

function createInitialStateForArtifact(artifact: MatchArtifact): MatchState {
	const boardColumns =
		artifact.boardColumns ?? artifact.engineConfig?.boardColumns ?? 17;
	const engineConfig = {
		...(artifact.engineConfig ?? {}),
		boardColumns,
	};

	if (artifact.scenario) {
		return createCombatScenario(
			artifact.seed,
			artifact.participants,
			artifact.scenario,
			engineConfig,
		);
	}
	return createInitialState(artifact.seed, engineConfig, artifact.participants);
}

function toReplayMatch(file: string): ReplayMatch {
	const artifact = JSON.parse(readFileSync(file, "utf8")) as MatchArtifact;
	const matchupDir = path.basename(path.dirname(path.dirname(file)));
	const fileName = path.basename(file, ".json");
	const id = `${matchupDir}::${fileName}`;
	const label = `${matchupDir} [seed ${artifact.seed}]`;
	const steps: ReplayStep[] = artifact.acceptedMoves.map((entry) => ({
		ply: entry.ply,
		playerID: entry.playerID,
		move: entry.engineMove,
		preHash: entry.preHash,
		postHash: entry.postHash,
	}));

	return {
		id,
		label,
		scenario: artifact.scenario ?? null,
		seed: artifact.seed,
		participants: artifact.participants,
		result: artifact.result,
		initialState: createInitialStateForArtifact(artifact),
		steps,
	};
}

function main() {
	const rawArgs = process.argv.slice(2);
	const divider = rawArgs.indexOf("--");
	const normalizedArgs =
		divider >= 0
			? [...rawArgs.slice(0, divider), ...rawArgs.slice(divider + 1)]
			: rawArgs;

	const argv = minimist(normalizedArgs, {
		boolean: ["latest", "quiet"],
		string: ["run", "output"],
		default: {
			latest: true,
			quiet: false,
		} satisfies Args,
	}) as Args;

	const runDir = resolveRunDir(argv);
	const outputPath = path.resolve(
		process.cwd(),
		argv.output ?? "../web/public/dev-replay/latest.json",
	);
	const summaryPath = path.join(runDir, "benchmark-summary.json");

	const artifactFiles = findArtifactFiles(runDir);
	const matches = artifactFiles.map((file) => toReplayMatch(file));

	const payload: ReplayBundle = {
		version: 1,
		generatedAt: new Date().toISOString(),
		runDir,
		summaryPath: existsSync(summaryPath) ? summaryPath : null,
		matchCount: matches.length,
		matches,
	};

	mkdirSync(path.dirname(outputPath), { recursive: true });
	writeFileSync(outputPath, JSON.stringify(payload, null, 2));

	if (!argv.quiet) {
		console.log(`Replay export complete: ${outputPath}`);
		console.log(`Run: ${runDir}`);
		console.log(`Matches: ${matches.length}`);
	}
}

main();
