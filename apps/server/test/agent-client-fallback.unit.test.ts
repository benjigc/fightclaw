import { describe, expect, it, vi } from "vitest";
import {
	HttpLongPollEventSource,
	WsEventSource,
} from "../../../packages/agent-client/src/eventSources";
import { runMatch } from "../../../packages/agent-client/src/runner";
import type { MatchEventHandler } from "../../../packages/agent-client/src/types";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("agent-client runMatch transport fallback", () => {
	it("ignores websocket turn events after HTTP fallback starts", async () => {
		const wsStop = vi.fn();
		const httpStop = vi.fn();

		const wsStart = vi
			.spyOn(WsEventSource.prototype, "start")
			.mockImplementation(async (handler: MatchEventHandler) => {
				queueMicrotask(() => {
					void handler({ type: "error", error: "ws_closed" });
					queueMicrotask(() => {
						void handler({ type: "your_turn", stateVersion: 0 });
					});
				});
				return wsStop;
			});

		const httpStart = vi
			.spyOn(HttpLongPollEventSource.prototype, "start")
			.mockImplementation(async (handler: MatchEventHandler) => {
				setTimeout(() => {
					void handler({ type: "your_turn", stateVersion: 1 });
				}, 5);
				return httpStop;
			});

		const submitMove = vi.fn(
			async (_matchId: string, request: { expectedVersion: number }) => {
				if (request.expectedVersion === 0) {
					return {
						ok: false as const,
						error: "state_version_mismatch",
					};
				}
				return {
					ok: true as const,
					state: {
						stateVersion: 2,
						status: "ended" as const,
						winnerAgentId: "agent-a",
						endReason: "terminal",
					},
				};
			},
		);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "pass" })),
		};

		try {
			const result = await runMatch(client as never, {
				moveProvider,
				allowTransportFallback: true,
			});

			expect(result.matchId).toBe("match-1");
			expect(result.transport).toBe("http");
			expect(submitMove).toHaveBeenCalledTimes(1);
			expect(submitMove).toHaveBeenCalledWith(
				"match-1",
				expect.objectContaining({ expectedVersion: 1 }),
			);
			expect(wsStop).toHaveBeenCalledTimes(1);
			expect(httpStop).toHaveBeenCalledTimes(1);
			await flush();
		} finally {
			wsStart.mockRestore();
			httpStart.mockRestore();
		}
	});

	it("continues submitting actions within the same turn when still active", async () => {
		const wsStop = vi.fn();
		const wsStart = vi
			.spyOn(WsEventSource.prototype, "start")
			.mockImplementation(async (handler: MatchEventHandler) => {
				queueMicrotask(() => {
					void handler({ type: "your_turn", stateVersion: 0 });
				});
				setTimeout(() => {
					void handler({
						type: "match_ended",
						reason: "terminal",
						winnerAgentId: "agent-a",
						loserAgentId: "agent-b",
					});
				}, 15);
				return wsStop;
			});

		const httpStart = vi
			.spyOn(HttpLongPollEventSource.prototype, "start")
			.mockImplementation(async () => {
				throw new Error("http fallback should not start");
			});

		const submitMove = vi
			.fn()
			.mockResolvedValueOnce({
				ok: true as const,
				state: {
					stateVersion: 1,
					status: "active" as const,
					game: {
						activePlayer: "A",
						players: {
							A: { id: "agent-a" },
							B: { id: "agent-b" },
						},
					},
				},
			})
			.mockResolvedValueOnce({
				ok: true as const,
				state: {
					stateVersion: 2,
					status: "active" as const,
					game: {
						activePlayer: "B",
						players: {
							A: { id: "agent-a" },
							B: { id: "agent-b" },
						},
					},
				},
			});

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
		};

		const moveProvider = {
			nextMove: vi.fn(async () => ({ action: "move", unitId: "u1", to: "B2" })),
		};

		try {
			await runMatch(client as never, {
				moveProvider,
				allowTransportFallback: true,
			});

			expect(submitMove).toHaveBeenCalledTimes(2);
			expect(submitMove).toHaveBeenNthCalledWith(
				1,
				"match-1",
				expect.objectContaining({ expectedVersion: 0 }),
			);
			expect(submitMove).toHaveBeenNthCalledWith(
				2,
				"match-1",
				expect.objectContaining({ expectedVersion: 1 }),
			);
			expect(moveProvider.nextMove).toHaveBeenCalledTimes(2);
			expect(wsStop).toHaveBeenCalledTimes(1);
		} finally {
			wsStart.mockRestore();
			httpStart.mockRestore();
		}
	});

	it("falls back to pass when move provider exceeds timeout", async () => {
		const wsStop = vi.fn();
		const wsStart = vi
			.spyOn(WsEventSource.prototype, "start")
			.mockImplementation(async (handler: MatchEventHandler) => {
				queueMicrotask(() => {
					void handler({ type: "your_turn", stateVersion: 0 });
				});
				return wsStop;
			});

		const httpStart = vi
			.spyOn(HttpLongPollEventSource.prototype, "start")
			.mockImplementation(async () => {
				throw new Error("http fallback should not start");
			});

		const submitMove = vi.fn(
			async (_matchId: string, payload: { move: { action: string } }) => {
				expect(payload.move.action).toBe("pass");
				return {
					ok: true as const,
					state: {
						stateVersion: 1,
						status: "ended" as const,
						winnerAgentId: "agent-a",
						endReason: "terminal",
					},
				};
			},
		);

		const client = {
			me: vi.fn(async () => ({ agentId: "agent-a" })),
			queueJoin: vi.fn(async () => ({
				status: "ready" as const,
				matchId: "match-1",
				opponentId: "agent-b",
			})),
			waitForMatch: vi.fn(),
			submitMove,
		};

		const slowMoveProvider = {
			nextMove: vi.fn(
				() =>
					new Promise((resolve) => {
						setTimeout(() => resolve({ action: "end_turn" }), 50);
					}),
			),
		};

		try {
			await runMatch(client as never, {
				moveProvider: slowMoveProvider,
				allowTransportFallback: true,
				moveProviderTimeoutMs: 5,
			});

			expect(submitMove).toHaveBeenCalledTimes(1);
			expect(slowMoveProvider.nextMove).toHaveBeenCalledTimes(1);
			expect(wsStop).toHaveBeenCalledTimes(1);
		} finally {
			wsStart.mockRestore();
			httpStart.mockRestore();
		}
	});
});
