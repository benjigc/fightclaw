import { SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

const setupMatch = async () => {
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

	return {
		matchId: secondJson.matchId ?? firstJson.matchId,
		agentA,
		agentB,
	};
};

beforeEach(async () => {
	await resetDb();
});

it("rejects stale versions", async () => {
	const { matchId, agentA } = await setupMatch();

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: 999,
				move: { type: "gather" },
			}),
		},
	);

	expect(res.status).toBe(409);
	const json = (await res.json()) as { ok: boolean; stateVersion?: number };
	expect(json.ok).toBe(false);
	expect(typeof json.stateVersion).toBe("number");
});

it("rejects wrong agent turn", async () => {
	const { matchId, agentB } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentB.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { type: "gather" },
			}),
		},
	);

	expect(res.status).toBe(409);
	const json = (await res.json()) as { ok: boolean };
	expect(json.ok).toBe(false);
});

it("forfeits on invalid move schema", async () => {
	const { matchId, agentA, agentB } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { type: "cheat" },
			}),
		},
	);

	expect(res.status).toBe(400);
	const json = (await res.json()) as {
		forfeited?: boolean;
		matchStatus?: string;
		reason?: string;
		reasonCode?: string;
	};
	expect(json.forfeited).toBe(true);
	expect(json.matchStatus).toBe("ended");
	expect(json.reason).toBe("invalid_move_schema");
	expect(json.reasonCode).toBe("invalid_move_schema");

	const endRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const endPayload = (await endRes.json()) as {
		state: { status: string; winnerAgentId?: string | null } | null;
	};
	expect(endPayload.state?.status).toBe("ended");
	expect(endPayload.state?.winnerAgentId).toBe(agentB.id);
});

it("applies valid move and increments version", async () => {
	const { matchId, agentA } = await setupMatch();

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	const payload = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};

	const res = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/move`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
			},
			body: JSON.stringify({
				moveId: crypto.randomUUID(),
				expectedVersion: payload.state?.stateVersion ?? 0,
				move: { type: "gather" },
			}),
		},
	);

	expect(res.status).toBe(200);
	const json = (await res.json()) as {
		ok: boolean;
		state?: { stateVersion: number };
	};
	expect(json.ok).toBe(true);
	expect(json.state?.stateVersion).toBe((payload.state?.stateVersion ?? 0) + 1);
});
