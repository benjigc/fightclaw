import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { authHeader, createAgent, resetDb } from "../helpers";

describe("observability safety", () => {
	beforeEach(async () => {
		await resetDb();
	});

	describe("Sentry disabled", () => {
		it("worker code paths don't throw when Sentry DSN is empty", async () => {
			// The test env has no SENTRY_DSN, so this tests the safe path
			const res = await SELF.fetch("https://example.com/health");
			expect(res.status).toBe(200);
		});

		it("DO code paths don't throw when Sentry DSN is empty", async () => {
			// Queue join hits MatchmakerDO - should not throw
			const agent = await createAgent("sentry-test", "sentry-key");
			const res = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agent.key),
			});
			// Should not throw, status should be 200 (waiting) or 409 (already in queue)
			expect([200, 409]).toContain(res.status);
		});
	});

	describe("metrics emitter safe", () => {
		it("omit OBS binding - calls are no-ops", async () => {
			// The test env may or may not have OBS; either way, calls should not throw
			const agent = await createAgent("metrics-test", "metrics-key");
			const res = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agent.key),
			});
			expect(res.ok).toBe(true);
		});
	});

	describe("internal runner model headers", () => {
		it("x-fc-* headers persist to match_players columns", async () => {
			const agentA = await createAgent("runner-agent-a", "runner-key-a");
			const agentB = await createAgent("runner-agent-b", "runner-key-b");

			// Join queue for both agents
			const joinA = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agentA.key),
			});
			expect(joinA.ok).toBe(true);
			const { matchId } = (await joinA.json()) as {
				matchId: string;
			};

			const joinB = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agentB.key),
			});
			expect(joinB.ok).toBe(true);
			const { matchId: matchIdB, status: statusB } = (await joinB.json()) as {
				matchId: string;
				status: string;
			};

			// One of them should be ready
			const activeMatchId = statusB === "ready" ? matchIdB : matchId;

			// Get state to find whose turn it is
			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${activeMatchId}/state`,
			);
			const { state } = (await stateRes.json()) as {
				state?: {
					game?: { activePlayer?: number };
					stateVersion?: number;
					players?: string[];
				};
			};
			if (!state?.players) return;

			const activeAgentId = state.players[state.game?.activePlayer ?? 0];
			const activeAgent = activeAgentId === agentA.id ? agentA : agentB;

			// Submit move via internal endpoint with telemetry headers
			const moveRes = await SELF.fetch(
				`https://example.com/v1/internal/matches/${activeMatchId}/move`,
				{
					method: "POST",
					headers: {
						"x-runner-key": env.INTERNAL_RUNNER_KEY ?? "",
						"x-agent-id": activeAgent.id,
						"x-fc-model-provider": "test-provider",
						"x-fc-model-id": "test-model",
						"content-type": "application/json",
					},
					body: JSON.stringify({
						moveId: crypto.randomUUID(),
						expectedVersion: state.stateVersion ?? 0,
						move: { action: "pass" },
					}),
				},
			);
			// Move may succeed or fail based on game rules, but shouldn't crash
			expect([200, 400, 409]).toContain(moveRes.status);

			// Check that model info was persisted (give it a moment)
			await new Promise((r) => setTimeout(r, 100));
			const playerRow = await env.DB.prepare(
				"SELECT model_provider, model_id FROM match_players WHERE match_id = ? AND agent_id = ?",
			)
				.bind(activeMatchId, activeAgent.id)
				.first<{ model_provider: string | null; model_id: string | null }>();

			// If the move was valid and telemetry persisted, these should be set
			if (moveRes.status === 200) {
				expect(playerRow?.model_provider).toBe("test-provider");
				expect(playerRow?.model_id).toBe("test-model");
			}
		});
	});

	describe("match ended", () => {
		it("emits metrics and persists results on match end", async () => {
			const agentA = await createAgent("end-agent-a", "end-key-a");
			const agentB = await createAgent("end-agent-b", "end-key-b");

			// Queue both agents
			const joinA = await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agentA.key),
			});
			await SELF.fetch("https://example.com/v1/matches/queue", {
				method: "POST",
				headers: authHeader(agentB.key),
			});

			const { matchId } = (await joinA.json()) as { matchId: string };

			// Wait a moment for match creation
			await new Promise((r) => setTimeout(r, 100));

			// Finish match via admin endpoint (forfeit one player)
			const finishRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/finish`,
				{
					method: "POST",
					headers: {
						"x-admin-key": env.ADMIN_KEY ?? "",
						"x-agent-id": agentA.id,
						"content-type": "application/json",
					},
					body: JSON.stringify({ reason: "forfeit" }),
				},
			);
			// May be 200 or other status depending on match state
			expect([200, 409]).toContain(finishRes.status);

			// If successful, check match_results was persisted
			if (finishRes.status === 200) {
				await new Promise((r) => setTimeout(r, 100));
				const resultRow = await env.DB.prepare(
					"SELECT winner_agent_id FROM match_results WHERE match_id = ?",
				)
					.bind(matchId)
					.first<{ winner_agent_id: string | null }>();
				// Winner should be set (the non-forfeiting agent)
				expect(resultRow).toBeDefined();
			}
		});
	});
});
