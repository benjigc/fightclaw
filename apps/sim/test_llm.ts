import OpenAI from "openai";

const client = new OpenAI({
	apiKey:
		"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",
	baseURL: "https://openrouter.ai/api/v1",
});

async function test() {
	try {
		const completion = await client.chat.completions.create({
			model: "arcee-ai/trinity-large-preview:free",
			temperature: 0.3,
			messages: [
				{
					role: "system",
					content: "You are playing a game. Reply with JSON only.",
				},
				{ role: "user", content: "Choose move index 0" },
			],
			max_tokens: 100,
		});
		console.log("Response:", JSON.stringify(completion, null, 2));
	} catch (e) {
		console.error("Error:", e);
	}
}

test();
