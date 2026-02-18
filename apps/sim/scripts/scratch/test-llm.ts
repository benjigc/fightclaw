import OpenAI from "openai";

const client = new OpenAI({
	apiKey: process.env.OPENROUTER_API_KEY || "",
	baseURL: "https://openrouter.ai/api/v1",
});

async function run() {
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
	} catch (error) {
		console.error("Error:", error);
	}
}

run();
