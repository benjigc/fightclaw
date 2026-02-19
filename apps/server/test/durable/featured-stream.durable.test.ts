import { SELF } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { readSseUntil, resetDb, setupMatch } from "../helpers";

beforeEach(async () => {
	await resetDb();
});

it("streams featured_changed and state events", async () => {
	await setupMatch();

	const controller = new AbortController();
	const response = await SELF.fetch("https://example.com/v1/featured/stream", {
		signal: controller.signal,
	});
	expect(response.status).toBe(200);

	try {
		const result = await readSseUntil(
			response,
			(text) =>
				text.includes("event: featured_changed") &&
				text.includes("event: state"),
			5000,
			200_000,
			{ throwOnTimeout: true, label: "featured stream" },
		);
		expect(result.text).toContain("event: featured_changed");
		expect(result.text).toContain("event: state");
	} finally {
		controller.abort();
	}
});
