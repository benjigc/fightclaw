import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, pollUntil, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

const getMatchmakerStub = () => {
	const id = env.MATCHMAKER.idFromName("global");
	return env.MATCHMAKER.get(id);
};

it("rotates featured match after end", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");
	const agentD = await createAgent("Delta", "delta-key");

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

	const matchOne = secondJson.matchId ?? firstJson.matchId;

	const third = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const thirdJson = (await third.json()) as { matchId: string };

	const fourth = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentD.key),
	});
	const fourthJson = (await fourth.json()) as { matchId: string };

	const matchTwo = fourthJson.matchId ?? thirdJson.matchId;

	const featuredFirst = await SELF.fetch("https://example.com/v1/featured");
	const featuredFirstJson = (await featuredFirst.json()) as {
		matchId: string | null;
		status: string | null;
		players: string[] | null;
	};

	expect(featuredFirstJson.matchId).toBe(matchOne);
	expect(featuredFirstJson.status).toBe("active");
	expect(featuredFirstJson.players).toEqual([agentA.id, agentB.id]);

	await SELF.fetch(`https://example.com/v1/matches/${matchOne}/finish`, {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			"content-type": "application/json",
			"x-admin-key": env.ADMIN_KEY,
		},
		body: JSON.stringify({ reason: "forfeit" }),
	});

	const featuredSecondJson = await pollUntil(
		async () => {
			const featuredSecond = await SELF.fetch(
				"https://example.com/v1/featured",
			);
			return (await featuredSecond.json()) as {
				matchId: string | null;
				status: string | null;
				players: string[] | null;
			};
		},
		(snapshot) => snapshot.matchId === matchTwo,
	);

	expect(featuredSecondJson.matchId).toBe(matchTwo);
	expect(featuredSecondJson.status).toBe("active");
});

it("dedupes featured queue entries", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");
	const agentD = await createAgent("Delta", "delta-key");

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

	const matchOne = secondJson.matchId ?? firstJson.matchId;

	const third = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const thirdJson = (await third.json()) as { matchId: string };

	const fourth = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentD.key),
	});
	const fourthJson = (await fourth.json()) as { matchId: string };

	const matchTwo = fourthJson.matchId ?? thirdJson.matchId;

	const stub = getMatchmakerStub();
	await stub.fetch("https://do/featured/queue", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
		},
		body: JSON.stringify({
			matchId: matchTwo,
			players: [agentC.id, agentD.id],
		}),
	});

	const queueRes = await stub.fetch("https://do/featured/queue", {
		headers: {
			"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
		},
	});
	const queueJson = (await queueRes.json()) as {
		featured: string | null;
		queue: string[];
	};

	expect(queueJson.featured).toBe(matchOne);
	const occurrences = queueJson.queue.filter((id) => id === matchTwo).length;
	expect(occurrences).toBe(1);
});
