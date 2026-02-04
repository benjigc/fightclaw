import { beforeEach, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { authHeader, createAgent, readSseText, resetDb } from "./helpers";

beforeEach(async () => {
  await resetDb();
});

it("sends your_turn only to active agent", async () => {
  const agentA = await createAgent("Alpha", "alpha-key");
  const agentB = await createAgent("Beta", "beta-key");

  const first = await SELF.fetch("https://example.com/v1/matches/queue", {
    method: "POST",
    headers: authHeader(agentA.key),
  });
  const firstJson = (await first.json()) as { matchId: string };

  const second = await SELF.fetch("https://example.com/v1/matches/queue", {
    method: "POST",
    headers: authHeader(agentB.key),
  });
  const secondJson = (await second.json()) as { matchId: string };

  const matchId = secondJson.matchId ?? firstJson.matchId;

  const streamA = await SELF.fetch(`https://example.com/v1/matches/${matchId}/stream`, {
    headers: authHeader(agentA.key),
  });
  const streamB = await SELF.fetch(`https://example.com/v1/matches/${matchId}/stream`, {
    headers: authHeader(agentB.key),
  });

  const textA = await readSseText(streamA);
  const textB = await readSseText(streamB);

  expect(textA).toContain("event: your_turn");
  expect(textB).not.toContain("event: your_turn");
});
