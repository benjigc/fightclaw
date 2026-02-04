import minimist from "minimist";
import { makeRandomLegalBot } from "./bots/randomBot";
import { makeGreedyBot } from "./bots/greedyBot";
import { playMatch } from "./match";
import { runTournament } from "./tournament";

type Args = ReturnType<typeof minimist>;

async function main() {
  const argv: Args = minimist(process.argv.slice(2));
  const cmd = argv._[0];

  const seed = num(argv.seed, 1);
  const maxTurns = num(argv.maxTurns, 200);
  const verbose = !!argv.verbose;

  // Player ids must match what your engine expects.
  const p1 = makeGreedyBot("P1");
  const p2 = makeRandomLegalBot("P2");

  if (cmd === "single") {
    const result = await playMatch({ seed, maxTurns, players: [p1, p2], verbose });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (cmd === "tourney") {
    const games = num(argv.games, 200);
    const { summary } = await runTournament({ games, seed, maxTurns, players: [p1, p2] });
    console.log(JSON.stringify(summary, null, 2));
    console.log(
      `games=${summary.games} avgTurns=${summary.avgTurns} draws=${summary.draws} illegalMoveRate=${summary.illegalMoveRate}`
    );
    return;
  }

  console.error("Usage:");
  console.error("  tsx src/cli.ts single  --seed 1 --maxTurns 200 --verbose");
  console.error("  tsx src/cli.ts tourney --games 200 --seed 1 --maxTurns 200");
  process.exit(1);
}

function num(v: unknown, def: number) {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : def;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
