import { describe, expect, it } from "vitest";
import {
	agentWsInboundSchema,
	agentWsOutboundSchema,
} from "../src/protocol/ws";

describe("ws protocol schemas", () => {
	it("accepts ranked queue_join and rejects casual", () => {
		expect(
			agentWsInboundSchema.safeParse({ type: "queue_join", mode: "ranked" })
				.success,
		).toBe(true);
		expect(
			agentWsInboundSchema.safeParse({ type: "queue_join", mode: "casual" })
				.success,
		).toBe(false);
	});

	it("accepts canonical match_ended outbound envelope", () => {
		const parsed = agentWsOutboundSchema.safeParse({
			type: "match_ended",
			matchId: crypto.randomUUID(),
			winnerAgentId: crypto.randomUUID(),
			endReason: "forfeit",
			finalStateVersion: 12,
		});
		expect(parsed.success).toBe(true);
	});
});
