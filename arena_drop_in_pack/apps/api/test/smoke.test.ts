import { it, expect } from "vitest";
import { SELF } from "cloudflare:test";

it("responds to GET /health", async () => {
  const res = await SELF.fetch("https://example.com/health");
  expect(res.status).toBe(200);
});
