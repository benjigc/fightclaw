import { EventSchema, initialState } from "@fightclaw/engine";
import { describe, expect, it } from "vitest";
import {
	buildGameEndedAliasEvent,
	buildMatchEndedEvent,
	buildMatchFoundEvent,
	buildNoEventsEvent,
	buildStateEvent,
	buildYourTurnEvent,
} from "../src/protocol/events";
import { formatSse } from "../src/protocol/sse";

describe("event builders", () => {
	it("builds match_found with version", () => {
		const event = buildMatchFoundEvent("match-1", "agent-2");
		expect(event.eventVersion).toBe(1);
		expect(event.event).toBe("match_found");
		expect(EventSchema.safeParse(event).success).toBe(true);
	});

	it("builds match_ended with version", () => {
		const event = buildMatchEndedEvent("match-1", "winner", "loser", "forfeit");
		expect(event.eventVersion).toBe(1);
		expect(event.event).toBe("match_ended");
		expect(event.reasonCode).toBe(event.reason);
		expect(EventSchema.safeParse(event).success).toBe(true);
	});

	it("builds game_ended alias from canonical payload", () => {
		const canonical = buildMatchEndedEvent(
			"match-1",
			"winner",
			"loser",
			"forfeit",
		);
		const alias = buildGameEndedAliasEvent(canonical);
		expect(alias.event).toBe("game_ended");
		expect(alias.reasonCode).toBe(alias.reason);
		expect(EventSchema.safeParse(alias).success).toBe(true);
	});

	it("builds your_turn with version", () => {
		const event = buildYourTurnEvent("match-1", 3);
		expect(event.eventVersion).toBe(1);
		expect(event.event).toBe("your_turn");
		expect(EventSchema.safeParse(event).success).toBe(true);
	});

	it("builds state with version", () => {
		const state = initialState(1, ["a", "b"]);
		const event = buildStateEvent("match-1", state);
		expect(event.eventVersion).toBe(1);
		expect(event.event).toBe("state");
		expect(EventSchema.safeParse(event).success).toBe(true);
	});

	it("builds no_events with version", () => {
		const event = buildNoEventsEvent();
		expect(event.eventVersion).toBe(1);
		expect(event.event).toBe("no_events");
		expect(EventSchema.safeParse(event).success).toBe(true);
	});
});

describe("sse format", () => {
	it("formats event frames", () => {
		const payload = { ok: true };
		const frame = formatSse("game_ended", payload);
		expect(frame).toContain("event: game_ended");
		expect(frame).toContain(`data: ${JSON.stringify(payload)}`);
		expect(frame.endsWith("\n\n")).toBe(true);
	});
});
