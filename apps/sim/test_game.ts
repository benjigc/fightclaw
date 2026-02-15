import { makeLlmBot } from "./src/bots/llmBot";
import { Engine } from "./src/engineAdapter";

const bot = makeLlmBot("P1", {
	model: "arcee-ai/trinity-large-preview:free",
	apiKey:
		"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",
	systemPrompt: "Prioritize aggressive attacks",
	delayMs: 0,
});

async function test() {
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

test().catch(console.error);
