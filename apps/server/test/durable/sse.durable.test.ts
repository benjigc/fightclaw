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
