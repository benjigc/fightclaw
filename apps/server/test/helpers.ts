import { env } from "cloudflare:test";

export type TestAgent = { id: string; key: string; name: string };

export const createAgent = async (
	name: string,
	key: string,
	id = crypto.randomUUID(),
): Promise<TestAgent> => {
	const pepper = env.API_KEY_PEPPER;
	const hash = await sha256Hex(`${pepper}${key}`);
	await env.DB.prepare(
		"INSERT INTO agents (id, name, api_key_hash) VALUES (?, ?, ?)",
	)
		.bind(id, name, hash)
		.run();
	return { id, key, name };
};

export const resetDb = async () => {
	await env.DB.prepare("DELETE FROM match_events").run();
	await env.DB.prepare("DELETE FROM match_players").run();
	await env.DB.prepare("DELETE FROM match_results").run();
	await env.DB.prepare("DELETE FROM leaderboard").run();
	await env.DB.prepare("DELETE FROM matches").run();
	await env.DB.prepare("DELETE FROM agents").run();
};

export const authHeader = (key: string) => ({
	authorization: `Bearer ${key}`,
});

export const readSseUntil = async (
	res: Response,
	predicate: (text: string) => boolean,
	timeoutMs = 1500,
	maxBytes = 4096,
): Promise<string> => {
	const body = res.body;
	if (!body) return "";
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	const endAt = Date.now() + timeoutMs;

	while (Date.now() < endAt && text.length < maxBytes) {
		const remaining = Math.max(endAt - Date.now(), 0);
		let timeoutId: ReturnType<typeof setTimeout> | null = null;
		const result = await Promise.race([
			reader.read(),
			new Promise<{ timeout: true }>((resolve) => {
				timeoutId = setTimeout(() => resolve({ timeout: true }), remaining);
			}),
		]);
		if (timeoutId !== null) clearTimeout(timeoutId);

		if ("timeout" in result) break;
		if (result.done) break;
		if (result.value) {
			text += decoder.decode(result.value);
			if (predicate(text)) break;
		}
	}

	await reader.cancel().catch(() => {});
	await body.cancel().catch(() => {});
	return text;
};

export const readSseText = async (
	res: Response,
	maxBytes = 1024,
): Promise<string> => {
	const text = await readSseUntil(res, () => true, 1000, maxBytes);
	return text;
};

const sha256Hex = async (input: string) => {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};
