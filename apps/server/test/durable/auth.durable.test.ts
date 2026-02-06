import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { readSseText } from "../helpers";

const matchId = "11111111-1111-4111-8111-111111111111";

// Auth test consolidation: Keeping one test per auth type.
// Removed redundant middleware checks (queue join/status/leave, stream, events wait)
// since they all verify the same Hono middleware wiring.
// See TEST_SUITE_REVISION.md Priority 6.

describe("auth", () => {
	it("requires auth for queue", async () => {
		const res = await SELF.fetch("https://example.com/v1/matches/queue", {
			method: "POST",
		});
		expect(res.status).toBe(401);
	});

	it("requires auth for move submission", async () => {
		const res = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/move`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: "test",
					expectedVersion: 0,
					move: { action: "pass" },
				}),
			},
		);
		expect(res.status).toBe(401);
	});

	it("allows public state and spectate", async () => {
		const stateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/state`,
		);
		expect(stateRes.status).toBe(200);

		const controller = new AbortController();
		const spectateRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/spectate`,
			{
				signal: controller.signal,
			},
		);
		expect(spectateRes.status).toBe(200);
		await readSseText(spectateRes);
		controller.abort();
	});

	it("allows public events stream", async () => {
		const controller = new AbortController();
		const eventsRes = await SELF.fetch(
			`https://example.com/v1/matches/${matchId}/events`,
			{
				signal: controller.signal,
			},
		);
		expect(eventsRes.status).toBe(200);
		await readSseText(eventsRes);
		controller.abort();
	});
});
