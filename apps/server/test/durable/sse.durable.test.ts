import { SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readSseUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

afterEach(async () => {
	// Allow stream aborts to propagate and DOs to settle before next test.
	await new Promise((resolve) => setTimeout(resolve, 100));
});

const SSE_TIMEOUT_MS = 15000;
const SSE_MAX_BYTES = 1_000_000;
const TEST_TIMEOUT_MS = SSE_TIMEOUT_MS + 5000;

const openSse = async (url: string, headers?: Record<string, string>) => {
	const controller = new AbortController();
	const res = await SELF.fetch(url, {
		headers,
		signal: controller.signal,
	});
	const close = async () => {
		if (!controller.signal.aborted) controller.abort();
		try {
			await res.body?.cancel();
		} catch {
			// ignore
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	};
	return { res, controller, close };
};

// Note: Additional SSE tests (your_turn isolation, game_ended events) were removed
// due to workerd teardown instability. See TEST_SUITE_REVISION.md Priority 4.
// This smoke test verifies basic SSE functionality.

it(
	"events stream sends initial state",
	async () => {
		const { matchId } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/events`,
		);

		let text = "";
		try {
			const result = await readSseUntil(
				stream.res,
				(value) => value.includes("event: state"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{
					throwOnTimeout: true,
					label: "events initial state",
				},
			);
			text = result.text;
		} finally {
			await stream.close();
		}
		expect(text).toContain("event: state");
	},
	TEST_TIMEOUT_MS,
);

it(
	"events stream emits engine_events after successful move",
	async () => {
		const { matchId, agentA } = await setupMatch();

		const stream = await openSse(
			`https://example.com/v1/matches/${matchId}/events`,
		);

		try {
			// Begin consuming the SSE stream before applying the move so DO writes don't
			// backpressure and hit the SSE write timeout.
			const waitForEngineEvents = readSseUntil(
				stream.res,
				(value) => value.includes("event: engine_events"),
				SSE_TIMEOUT_MS,
				SSE_MAX_BYTES,
				{ throwOnTimeout: true, label: "engine_events" },
			);

			const stateRes = await SELF.fetch(
				`https://example.com/v1/matches/${matchId}/state`,
			);
			const stateJson = (await stateRes.json()) as {
				state: { stateVersion: number } | null;
			};
			const expectedVersion = stateJson.state?.stateVersion ?? 0;

			await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
				method: "POST",
				headers: {
					...{ authorization: `Bearer ${agentA.key}` },
					"content-type": "application/json",
				},
				body: JSON.stringify({
					moveId: crypto.randomUUID(),
					expectedVersion,
					move: { action: "fortify", unitId: "A-1" },
				}),
			});

			const result = await waitForEngineEvents;

			const frame =
				result.framesPreview.find((value) =>
					value.includes("event: engine_events"),
				) ?? null;
			expect(frame).toBeTruthy();

			const dataLine =
				frame?.split("\n").find((line) => line.startsWith("data: ")) ?? null;
			expect(dataLine).toBeTruthy();

			const payload = JSON.parse(String(dataLine).slice("data: ".length)) as {
				event?: string;
				engineEvents?: unknown[];
			};

			expect(payload.event).toBe("engine_events");
			const engineEvents = Array.isArray(payload.engineEvents)
				? payload.engineEvents
				: [];
			expect(
				engineEvents.some((event) => {
					if (!event || typeof event !== "object") return false;
					const record = event as { type?: unknown; at?: unknown };
					return record.type === "fortify" && typeof record.at === "string";
				}),
			).toBe(true);
		} finally {
			await stream.close();
		}
	},
	TEST_TIMEOUT_MS,
);
