import { describe, expect, it } from "vitest";
import { SELF } from "cloudflare:test";
import { readSseText } from "./helpers";

const matchId = "11111111-1111-1111-1111-111111111111";

describe("auth", () => {
  it("requires auth for queue", async () => {
    const res = await SELF.fetch("https://example.com/v1/matches/queue", { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("requires auth for stream", async () => {
    const res = await SELF.fetch(`https://example.com/v1/matches/${matchId}/stream`);
    expect(res.status).toBe(401);
  });

  it("requires auth for move submission", async () => {
    const res = await SELF.fetch(`https://example.com/v1/matches/${matchId}/move`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        moveId: "test",
        expectedVersion: 0,
        move: { type: "gather" },
      }),
    });
    expect(res.status).toBe(401);
  });

  it("allows public state and spectate", async () => {
    const stateRes = await SELF.fetch(`https://example.com/v1/matches/${matchId}/state`);
    expect(stateRes.status).toBe(200);

    const spectateRes = await SELF.fetch(`https://example.com/v1/matches/${matchId}/spectate`);
    expect(spectateRes.status).toBe(200);
    await readSseText(spectateRes);
  });
});
