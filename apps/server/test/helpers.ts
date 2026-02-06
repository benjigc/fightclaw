import { env, SELF } from "cloudflare:test";

export type TestAgent = { id: string; key: string; name: string };

export const createAgent = async (
	name: string,
	key: string,
	id = crypto.randomUUID(),
	options?: { verified?: boolean; apiKeyId?: string },
): Promise<TestAgent> => {
	const pepper = env.API_KEY_PEPPER;
	const hash = await sha256Hex(`${pepper}${key}`);

	const apiKeyId = options?.apiKeyId ?? crypto.randomUUID();
	const verifiedAt =
		options?.verified === false ? null : new Date().toISOString();

	await env.DB.batch([
		env.DB.prepare(
			"INSERT INTO agents (id, name, api_key_hash, verified_at) VALUES (?, ?, ?, ?)",
		).bind(id, name, hash, verifiedAt),
		env.DB.prepare(
			"INSERT INTO api_keys (id, agent_id, key_hash, key_prefix) VALUES (?, ?, ?, ?)",
		).bind(apiKeyId, id, hash, key.slice(0, 8)),
	]);
	return { id, key, name };
};

export const resetDb = async () => {
	// Order matters: tables with FKs must be deleted before their referenced tables.
	// FK chain: match_events/match_players/match_results → matches
	//           agent_prompt_active/prompt_versions/api_keys → agents
	await env.DB.prepare("DELETE FROM match_events").run();
	await env.DB.prepare("DELETE FROM match_players").run();
	await env.DB.prepare("DELETE FROM match_results").run();
	await env.DB.prepare("DELETE FROM leaderboard").run();
	await env.DB.prepare("DELETE FROM matches").run();
	await env.DB.prepare("DELETE FROM agent_prompt_active").run();
	await env.DB.prepare("DELETE FROM prompt_versions").run();
	await env.DB.prepare("DELETE FROM api_keys").run();
	await env.DB.prepare("DELETE FROM agents").run();

	// With `isolatedStorage: false` in the durable lane, DO state persists across tests.
	// Clear MatchmakerDO so queue/featured state doesn't leak and create flakiness.
	if (env.INTERNAL_RUNNER_KEY) {
		for (let attempt = 1; attempt <= 10; attempt += 1) {
			const res = await SELF.fetch(
				"https://example.com/v1/internal/__test__/reset",
				{
					method: "POST",
					headers: { "x-runner-key": env.INTERNAL_RUNNER_KEY },
				},
			);
			if (res.ok) break;
			await new Promise((resolve) => setTimeout(resolve, 25 * attempt));
		}
	}
};

export const authHeader = (key: string) => ({
	authorization: `Bearer ${key}`,
});

export const readSseUntil = async (
	res: Response,
	predicate: (text: string) => boolean,
	timeoutMs = 1500,
	maxBytes = 4096,
	options?: {
		throwOnTimeout?: boolean;
		label?: string;
		maxEventsPreview?: number;
	},
): Promise<{ text: string; matched: boolean; framesPreview: string[] }> => {
	const body = res.body;
	if (!body) return { text: "", matched: false, framesPreview: [] };
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let pending = "";
	const previewLimit = options?.maxEventsPreview ?? 6;
	const frames: string[] = [];
	const endAt = Date.now() + timeoutMs;
	let matched = false;
	let totalBytes = 0;
	const windowSize = Math.min(maxBytes, 100_000);

	while (Date.now() < endAt && totalBytes < maxBytes) {
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
			const chunk = decoder.decode(result.value);
			totalBytes += chunk.length;
			text = (text + chunk).slice(-windowSize);
			pending += chunk;
			let idx = pending.indexOf("\n\n");
			while (idx >= 0) {
				const frame = pending.slice(0, idx);
				pending = pending.slice(idx + 2);
				if (frame.trim().length > 0) {
					frames.push(frame.trim());
					if (frames.length > previewLimit) frames.shift();
				}
				idx = pending.indexOf("\n\n");
			}
			if (predicate(text)) {
				matched = true;
				break;
			}
		}
	}

	await reader.cancel().catch(() => {});
	try {
		reader.releaseLock();
	} catch {
		// ignore
	}
	if (!matched && options?.throwOnTimeout) {
		const label = options.label ? ` (${options.label})` : "";
		const preview =
			frames.length > 0
				? frames.join("\n\n")
				: text.length > 0
					? text.slice(-2000)
					: "<empty>";
		throw new Error(`SSE wait timed out${label}. Received:\n${preview}`);
	}
	return { text, matched, framesPreview: frames };
};

export const readSseText = async (
	res: Response,
	maxBytes = 1024,
): Promise<string> => {
	const result = await readSseUntil(res, () => true, 1000, maxBytes);
	return result.text;
};

const sha256Hex = async (input: string) => {
	const data = new TextEncoder().encode(input);
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
};

export const pollUntil = async <T>(
	fn: () => Promise<T>,
	predicate: (value: T) => boolean,
	timeoutMs = 2000,
	intervalMs = 50,
): Promise<T> => {
	const endAt = Date.now() + timeoutMs;
	let last = await fn();
	while (Date.now() < endAt) {
		if (predicate(last)) return last;
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
		last = await fn();
	}
	return last;
};

/**
 * Creates two agents, queues them both, and returns the matched game.
 * Reduces boilerplate in tests that just need a ready match.
 */
export const setupMatch = async (
	agentAName = "Alpha",
	agentAKey = "alpha-key",
	agentBName = "Beta",
	agentBKey = "beta-key",
): Promise<{ matchId: string; agentA: TestAgent; agentB: TestAgent }> => {
	const agentA = await createAgent(agentAName, agentAKey);
	const agentB = await createAgent(agentBName, agentBKey);

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string };

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as { matchId: string };

	return {
		matchId: secondJson.matchId ?? firstJson.matchId,
		agentA,
		agentB,
	};
};
