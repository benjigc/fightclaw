import { SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("exposes match_events log for active featured match with engineEvents payload", async () => {
	const { matchId, agentA } = await setupMatch();

	const featuredRes = await SELF.fetch("https://example.com/v1/featured");
	expect(featuredRes.ok).toBe(true);
	const featuredJson = (await featuredRes.json()) as { matchId: string | null };
	expect(featuredJson.matchId).toBe(matchId);

	const stateRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/state`,
	);
	expect(stateRes.ok).toBe(true);
	const stateJson = (await stateRes.json()) as {
		state: { stateVersion: number } | null;
	};
	const expectedVersion = stateJson.state?.stateVersion ?? 0;

	await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
		method: "POST",
		headers: {
			authorization: `Bearer ${agentA.key}`,
			"content-type": "application/json",
		},
		body: JSON.stringify({
			moveId: crypto.randomUUID(),
			expectedVersion,
			move: { action: "fortify", unitId: "A-1" },
		}),
	});

	const logRes = await SELF.fetch(
		`https://example.com/v1/matches/${matchId}/log`,
	);
	expect(logRes.ok).toBe(true);
	const logJson = (await logRes.json()) as {
		matchId: string;
		events: Array<{ eventType: string; payload: unknown }>;
	};
	expect(logJson.matchId).toBe(matchId);

	const moveApplied = logJson.events.find(
		(event) => event.eventType === "move_applied",
	);
	expect(moveApplied).toBeTruthy();
	const payload = moveApplied?.payload as
		| {
				payloadVersion?: unknown;
				moveId?: unknown;
				engineEvents?: unknown;
		  }
		| undefined;

	expect(payload?.payloadVersion).toBe(2);
	expect(typeof payload?.moveId).toBe("string");
	expect(Array.isArray(payload?.engineEvents)).toBe(true);
});
