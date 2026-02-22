import { env, SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("pairs two agents into one match", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");

	const first = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string; status: string };
	expect(firstJson.status).toBe("waiting");

	const second = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("ready");
	expect(secondJson.matchId).toBe(firstJson.matchId);
});

it("supports join/status/leave", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");

	const join = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	expect(join.status).toBe(200);
	const joinJson = (await join.json()) as { matchId: string; status: string };
	expect(joinJson.status).toBe("waiting");

	const statusWaiting = await SELF.fetch(
		"https://example.com/v1/queue/status",
		{
			headers: authHeader(agentA.key),
		},
	);
	expect(statusWaiting.status).toBe(200);
	const statusWaitingJson = (await statusWaiting.json()) as {
		status: string;
		matchId?: string;
	};
	expect(statusWaitingJson.status).toBe("waiting");
	expect(statusWaitingJson.matchId).toBe(joinJson.matchId);

	const leave = await SELF.fetch("https://example.com/v1/queue/leave", {
		method: "DELETE",
		headers: authHeader(agentA.key),
	});
	expect(leave.status).toBe(200);
	const leaveJson = (await leave.json()) as { ok: boolean };
	expect(leaveJson.ok).toBe(true);

	const statusIdle = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentA.key),
	});
	expect(statusIdle.status).toBe(200);
	const statusIdleJson = (await statusIdle.json()) as { status: string };
	expect(statusIdleJson.status).toBe("idle");
});

it("rejects unsupported queue modes", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");

	const join = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: {
			...authHeader(agentA.key),
			"content-type": "application/json",
		},
		body: JSON.stringify({ mode: "casual" }),
	});
	expect(join.status).toBe(400);
	const payload = (await join.json()) as { error?: string };
	expect(payload.error).toContain("ranked");
});

it("enforces ELO range for matchmaking", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");

	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentB.id, 1700),
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentC.id, 2000),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1700,
			agentB.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			2000,
			agentC.id,
		),
	]);

	const first = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const firstJson = (await first.json()) as { matchId: string; status: string };
	expect(firstJson.status).toBe("waiting");

	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("waiting");

	const third = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const thirdJson = (await third.json()) as {
		matchId: string;
		status: string;
		opponentId?: string;
	};
	expect(thirdJson.status).toBe("ready");
	expect(thirdJson.matchId).toBe(firstJson.matchId);
	expect(thirdJson.opponentId).toBe(agentA.id);

	const cStatus = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentC.key),
	});
	const cStatusJson = (await cStatus.json()) as {
		status: string;
		matchId?: string;
	};
	expect(cStatusJson.status).toBe("waiting");
	expect(cStatusJson.matchId).toBe(secondJson.matchId);
});

it("avoids immediate rematches when alternatives exist", async () => {
	const agentA = await createAgent("Alpha", "alpha-key");
	const agentB = await createAgent("Beta", "beta-key");
	const agentC = await createAgent("Gamma", "gamma-key");

	await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const second = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const secondJson = (await second.json()) as {
		matchId: string;
		status: string;
	};
	expect(secondJson.status).toBe("ready");

	await SELF.fetch(
		`https://example.com/v1/matches/${secondJson.matchId}/finish`,
		{
			method: "POST",
			headers: {
				...authHeader(agentA.key),
				"content-type": "application/json",
				"x-admin-key": env.ADMIN_KEY,
			},
			body: JSON.stringify({ reason: "forfeit" }),
		},
	);

	// Seed ratings so B and C cannot match each other, but A can match both.
	await env.DB.batch([
		env.DB.prepare(
			"INSERT OR IGNORE INTO leaderboard(agent_id, rating, wins, losses, games_played) VALUES (?, ?, 0, 0, 0)",
		).bind(agentC.id, 1900),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1700,
			agentA.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1500,
			agentB.id,
		),
		env.DB.prepare("UPDATE leaderboard SET rating=? WHERE agent_id=?").bind(
			1900,
			agentC.id,
		),
	]);

	const bJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const bJoinJson = (await bJoin.json()) as { matchId: string; status: string };
	expect(bJoinJson.status).toBe("waiting");

	const cJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const cJoinJson = (await cJoin.json()) as { matchId: string; status: string };
	expect(cJoinJson.status).toBe("waiting");

	const aJoin = await SELF.fetch("https://example.com/v1/queue/join", {
		method: "POST",
		headers: authHeader(agentA.key),
	});
	const aJoinJson = (await aJoin.json()) as {
		matchId: string;
		status: string;
		opponentId?: string;
	};
	expect(aJoinJson.status).toBe("ready");
	expect(aJoinJson.matchId).toBe(cJoinJson.matchId);
	expect(aJoinJson.opponentId).toBe(agentC.id);

	const bStatus = await SELF.fetch("https://example.com/v1/queue/status", {
		headers: authHeader(agentB.key),
	});
	const bStatusJson = (await bStatus.json()) as {
		status: string;
		matchId?: string;
	};
	expect(bStatusJson.status).toBe("waiting");
	expect(bStatusJson.matchId).toBe(bJoinJson.matchId);
});

it("blocks disabled agents and prunes their waiting queue entries", async () => {
	const disabled = await createAgent("OldKai", "old-kai-key");
	const agentB = await createAgent("AgentSmith", "agent-smith-key");
	const agentC = await createAgent("Neo", "neo-key");

	const disabledJoin = await SELF.fetch(
		"https://example.com/v1/matches/queue",
		{
			method: "POST",
			headers: authHeader(disabled.key),
		},
	);
	const disabledJoinJson = (await disabledJoin.json()) as {
		status: string;
		matchId: string;
	};
	expect(disabledJoinJson.status).toBe("waiting");

	const disableRes = await SELF.fetch(
		`https://example.com/v1/admin/agents/${disabled.id}/disable`,
		{
			method: "POST",
			headers: {
				"x-admin-key": env.ADMIN_KEY,
			},
		},
	);
	expect(disableRes.status).toBe(200);

	const blockedJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(disabled.key),
	});
	expect(blockedJoin.status).toBe(403);
	const blockedBody = (await blockedJoin.json()) as { code?: string };
	expect(blockedBody.code).toBe("agent_disabled");

	const bJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentB.key),
	});
	const bJoinJson = (await bJoin.json()) as { status: string; matchId: string };
	expect(bJoinJson.status).toBe("waiting");

	const cJoin = await SELF.fetch("https://example.com/v1/matches/queue", {
		method: "POST",
		headers: authHeader(agentC.key),
	});
	const cJoinJson = (await cJoin.json()) as {
		status: string;
		matchId: string;
		opponentId?: string;
	};
	expect(cJoinJson.status).toBe("ready");
	expect(cJoinJson.matchId).toBe(bJoinJson.matchId);
	expect(cJoinJson.opponentId).toBe(agentB.id);
	expect(cJoinJson.matchId).not.toBe(disabledJoinJson.matchId);
});
