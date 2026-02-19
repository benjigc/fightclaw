import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
	authHeader,
	bindRunnerAgent,
	createAgent,
	resetDb,
	runnerHeaders,
} from "../helpers";

const expectErrorEnvelope = (body: unknown) => {
	const record = body as Record<string, unknown>;
	expect(record.ok).toBe(false);
	expect(typeof record.error).toBe("string");
	expect((record.error as string).length).toBeGreaterThan(0);
};

beforeEach(async () => {
	await resetDb();
});

describe("error envelope contracts", () => {
	it("auth-protected endpoints return { ok: false, error } when missing auth", async () => {
		const res = await SELF.fetch("https://example.com/v1/queue/join", {
			method: "POST",
		});

		expect(res.status).toBe(401);
		const body = await res.json();
		expectErrorEnvelope(body);
		expect((body as Record<string, unknown>).code).toBe("unauthorized");
	});

	it("auth endpoints return { ok: false, error } on validation failures", async () => {
		const res = await SELF.fetch("https://example.com/v1/auth/register", {
			method: "POST",
			headers: {
				"content-type": "application/json",
			},
			body: JSON.stringify({}),
		});

		expect(res.status).toBe(400);
		const body = await res.json();
		expectErrorEnvelope(body);
	});

	it("queue endpoints return { ok: false, error } for unverified agents", async () => {
		const agent = await createAgent("NoVerify", "no-verify-key", undefined, {
			verified: false,
		});

		const res = await SELF.fetch("https://example.com/v1/queue/join", {
			method: "POST",
			headers: authHeader(agent.key),
		});

		expect(res.status).toBe(403);
		const body = await res.json();
		expectErrorEnvelope(body);
		expect((body as Record<string, unknown>).code).toBe("agent_not_verified");
	});

	it("matches endpoints return { ok: false, error } for invalid match id", async () => {
		const res = await SELF.fetch(
			"https://example.com/v1/matches/not-a-uuid/state",
		);

		expect(res.status).toBe(400);
		const body = await res.json();
		expectErrorEnvelope(body);
	});

	it("internal endpoints return { ok: false, error } for invalid match id", async () => {
		expect(env.INTERNAL_RUNNER_KEY).toBeTruthy();
		const boundAgent = await createAgent("Bound", "bound-key");
		await bindRunnerAgent(boundAgent.id);

		const res = await SELF.fetch(
			"https://example.com/v1/internal/matches/not-a-uuid/move",
			{
				method: "POST",
				headers: {
					...runnerHeaders(),
					"content-type": "application/json",
					"x-agent-id": boundAgent.id,
				},
				body: JSON.stringify({
					moveId: "m-1",
					expectedVersion: 0,
					move: { action: "pass" },
				}),
			},
		);

		expect(res.status).toBe(400);
		const body = await res.json();
		expectErrorEnvelope(body);
	});
});
