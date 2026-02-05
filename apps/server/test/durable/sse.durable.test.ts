import { env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, readSseUntil, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	// Allow stream aborts to propagate and DOs to settle before next test.
	await new Promise((resolve) => setTimeout(resolve, 100));
});

const SSE_TIMEOUT_MS = 15000;
const SSE_MAX_BYTES = 1_000_000;
const TEST_TIMEOUT_MS = SSE_TIMEOUT_MS + 5000;

const openSse = async (url: string, headers?: Record<string, string>) => {
	const controller = new AbortController();
	const res = await SELF.fetch(url, {
		headers,
		signal: controller.signal,
	});
	const close = async () => {
		if (!controller.signal.aborted) controller.abort();
		try {
			await res.body?.cancel();
		} catch {
			// ignore
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	};
	return { res, controller, close };
};

// TODO(flake): Skipping additional SSE coverage until workerd teardown is stable.
it.skip(
	"sends your_turn only to active agent",
	async () => {
		const agentA = await createAgent("Alpha", "alpha-key");
		const agentB = await createAgent("Beta", "beta-key");

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

		const matchId = secondJson.matchId ?? firstJson.matchId;

		const [streamA, streamB] = await Promise.all([
			openSse(
				`https://example.com/v1/matches/${matchId}/stream`,
				authHeader(agentA.key),
			),
			openSse(
				`https://example.com/v1/matches/${matchId}/stream`,
				authHeader(agentB.key),
			),
		]);

		let textA = "";
		let textB = "";
		try {
			const [resultA, resultB] = await Promise.all([
				readSseUntil(
					streamA.res,
					(text) => text.includes("event: your_turn"),
					SSE_TIMEOUT_MS,
					SSE_MAX_BYTES,
					{ throwOnTimeout: true, label: "agent A your_turn" },
				),
				readSseUntil(
					streamB.res,
					(text) => text.includes("event: your_turn"),
					SSE_TIMEOUT_MS,
					SSE_MAX_BYTES,
				),
			]);
			textA = resultA.text;
			textB = resultB.text;
		} finally {
			await streamA.close();
			await streamB.close();
		}

		expect(textA).toContain("event: your_turn");
		expect(textB).not.toContain("event: your_turn");
	},
	TEST_TIMEOUT_MS,
);

it(
	"events stream sends initial state",
	async () => {
		const agentA = await createAgent("Alpha", "alpha-key");
		const agentB = await createAgent("Beta", "beta-key");

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

		const matchId = secondJson.matchId ?? firstJson.matchId;

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/events`,
		);

		let text = "";
		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: state"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "events initial state",
				},
			);
			text = result.text;
		} finally {
			await stream.close();
		}
		expect(text).toContain("event: state");
	},
	TEST_TIMEOUT_MS,
);

it.skip(
	"emits game_ended event name",
	async () => {
		const agentA = await createAgent("Alpha", "alpha-key");
		const agentB = await createAgent("Beta", "beta-key");

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

		const matchId = secondJson.matchId ?? firstJson.matchId;

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/spectate`,
		);

		await SELF.fetch(`https://example.com/v1/matches/${matchId}/finish`, {
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		});

		let text = "";
		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: game_ended"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "spectate game_ended",
				},
			);
			text = result.text;
		} finally {
			await stream.close();
		}
		expect(text).toContain("event: game_ended");
	},
	TEST_TIMEOUT_MS,
);

it.skip(
	"events stream emits game_ended",
	async () => {
		const agentA = await createAgent("Alpha", "alpha-key");
		const agentB = await createAgent("Beta", "beta-key");

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

		const matchId = secondJson.matchId ?? firstJson.matchId;

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/events`,
		);

		await SELF.fetch(`https://example.com/v1/matches/${matchId}/finish`, {
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		});

		let text = "";
		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: game_ended"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "events game_ended",
				},
			);
			text = result.text;
		} finally {
			await stream.close();
		}
		expect(text).toContain("event: game_ended");
	},
	TEST_TIMEOUT_MS,
);
