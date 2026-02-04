import { beforeEach, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { authHeader, createAgent, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

it("pairs two agents into one match", async () => {
  const agentA = await createAgent("Alpha", "alpha-key");
  const agentB = await createAgent("Beta", "beta-key");

  const first = await SELF.fetch("https://example.com/v1/matches/queue", {
    method: "POST",
    headers: authHeader(agentA.key),
  });
  const firstJson = (await first.json()) as { matchId: string; status: string };
  expect(firstJson.status).toBe("waiting");

  const second = await SELF.fetch("https://example.com/v1/matches/queue", {
    method: "POST",
    headers: authHeader(agentB.key),
  });
  const secondJson = (await second.json()) as { matchId: string; status: string };
  expect(secondJson.status).toBe("ready");
  expect(secondJson.matchId).toBe(firstJson.matchId);
});
