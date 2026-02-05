import { readFileSync, writeFileSync } from "node:fs";
import minimist from "minimist";
import { makeGreedyBot } from "./bots/greedyBot";
import { makeRandomLegalBot } from "./bots/randomBot";
import { playMatch, replayMatch } from "./match";
import { runTournament } from "./tournament";

type Args = ReturnType<typeof minimist>;

async function main() {
	const argv: Args = minimist(process.argv.slice(2));
	const cmd = argv._[0];

	const seed = num(argv.seed, 1);
	const maxTurns = num(argv.maxTurns, 200);
	const verbose = !!argv.verbose;
	const log = !!argv.log;
	const logFile = typeof argv.logFile === "string" ? argv.logFile : undefined;
	const autofix = !!argv.autofix;

	// Player ids must match what your engine expects.
	const p1 = makeGreedyBot("P1");
	const p2 = makeRandomLegalBot("P2");

	if (cmd === "single") {
		const result = await playMatch({
			seed,
			maxTurns,
			players: [p1, p2],
			verbose,
			record: log || !!logFile,
			autofixIllegal: autofix,
		});
		if (logFile && result.log) {
			writeFileSync(logFile, JSON.stringify(result.log));
		}
		if (log && result.log) {
			console.log(JSON.stringify(result.log));
			return;
		}
		console.log(JSON.stringify(result, null, 2));
		return;
	}

	if (cmd === "replay") {
		if (!logFile) {
			console.error("replay requires --logFile path");
			process.exit(1);
		}
		const payload = JSON.parse(readFileSync(logFile, "utf-8"));
		const result = replayMatch(payload);
		console.log(JSON.stringify(result, null, 2));
		process.exit(result.ok ? 0 : 1);
	}

	if (cmd === "tourney") {
		const games = num(argv.games, 200);
		const { summary } = await runTournament({
			games,
			seed,
			maxTurns,
			players: [p1, p2],
			autofixIllegal: autofix,
		});
		console.log(JSON.stringify(summary, null, 2));
		console.log(
			`games=${summary.games} avgTurns=${summary.avgTurns} draws=${summary.draws} illegalMoveRate=${summary.illegalMoveRate}`,
		);
		return;
	}

	console.error("Usage:");
	console.error(
		"  tsx src/cli.ts single  --seed 1 --maxTurns 200 --verbose --log --logFile ./match.json",
	);
	console.error("  tsx src/cli.ts single  --autofix");
	console.error("  tsx src/cli.ts replay  --logFile ./match.json");
	console.error(
		"  tsx src/cli.ts tourney --games 200 --seed 1 --maxTurns 200 --autofix",
	);
	process.exit(1);
}

function num(v: unknown, def: number) {
	const n =
		typeof v === "string" ? Number(v) : typeof v === "number" ? v : Number.NaN;
	return Number.isFinite(n) ? n : def;
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
