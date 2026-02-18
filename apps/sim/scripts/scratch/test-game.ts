import { makeLlmBot } from "../../src/bots/llmBot";
import { Engine } from "../../src/engineAdapter";

const bot = makeLlmBot("P1", {
	model: "arcee-ai/trinity-large-preview:free",
	apiKey: process.env.OPENROUTER_API_KEY || "",
	systemPrompt: "Prioritize aggressive attacks",
	delayMs: 0,
});

async function run() {
	const state = Engine.createInitialState(1, ["P1", "P2"]);
	const legalMoves = Engine.listLegalMoves(state);

	console.log("Legal moves count:", legalMoves.length);
	console.log("First 5 legal moves:", legalMoves.slice(0, 5));

	const move = await bot.chooseMove({
		state,
		legalMoves,
		turn: 1,
		rng: () => Math.random(),
	});

	console.log("Bot chose:", move);
}

run().catch(console.error);
