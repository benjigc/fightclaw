import { parseLlmResponse } from "../../src/bots/llmBot";

const testCases = [
	'{ "moveIndex": 12, "reasoning": "foo" }',
	'```json\n{\n  "move": 0,\n  "position": {\n    "row": 0,\n    "col": 0\n  },\n  "player": "X"\n}\n```',
	'{ "moveIndex": 3, "reasoning": "test" }',
	"moveIndex=7\nreasoning: because",
];

for (const input of testCases) {
	console.log("Input:", `${input.slice(0, 50)}...`);
	console.log("Parsed:", parseLlmResponse(input));
	console.log("---");
}
