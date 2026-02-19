import { SELF } from "cloudflare:test";
import { expect, it } from "vitest";

it("responds to GET /health", async () => {
	const res = await SELF.fetch("https://example.com/health");
	expect(res.status).toBe(200);
});

it("responds to GET /v1/system/version", async () => {
	const res = await SELF.fetch("https://example.com/v1/system/version");
	expect(res.status).toBe(200);
	const json = (await res.json()) as {
		contractsVersion?: unknown;
		protocolVersion?: unknown;
		engineVersion?: unknown;
	};
	expect(typeof json.contractsVersion).toBe("string");
	expect(typeof json.protocolVersion).toBe("number");
	expect(typeof json.engineVersion).toBe("string");
});
