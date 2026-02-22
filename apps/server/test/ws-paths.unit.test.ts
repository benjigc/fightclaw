import { describe, expect, it } from "vitest";
import { isWsEndpointPath } from "../src/utils/wsPaths";

describe("isWsEndpointPath", () => {
	it("matches direct ws endpoint paths", () => {
		expect(isWsEndpointPath("/ws")).toBe(true);
		expect(isWsEndpointPath("/v1/matches/123/ws")).toBe(true);
	});

	it("rejects non-ws paths", () => {
		expect(isWsEndpointPath("/v1/matches/123/state")).toBe(false);
		expect(isWsEndpointPath("/v1/matches/123/spectate")).toBe(false);
		expect(isWsEndpointPath("/v1/matches/123/wss")).toBe(false);
	});
});
