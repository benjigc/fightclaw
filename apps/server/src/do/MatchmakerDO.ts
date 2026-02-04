import { DurableObject } from "cloudflare:workers";

const LATEST_MATCH_KEY = "latestMatchId";
const PENDING_MATCH_KEY = "pendingMatchId";
const PENDING_AGENT_KEY = "pendingAgentId";

type MatchmakerEnv = {
  DB: D1Database;
  MATCH: DurableObjectNamespace;
};

type QueueResponse = { matchId: string; status: "waiting" | "ready" };

export class MatchmakerDO extends DurableObject<MatchmakerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/queue") {
      const agentId = request.headers.get("x-agent-id");
      if (!agentId) {
        return Response.json({ error: "Agent id is required." }, { status: 400 });
      }

      const pendingMatchId = await this.ctx.storage.get<string>(PENDING_MATCH_KEY);
      const pendingAgentId = await this.ctx.storage.get<string>(PENDING_AGENT_KEY);

      if (pendingMatchId && pendingAgentId) {
        if (pendingAgentId === agentId) {
          const response: QueueResponse = { matchId: pendingMatchId, status: "waiting" };
          return Response.json(response);
        }

        await this.ctx.storage.delete(PENDING_MATCH_KEY);
        await this.ctx.storage.delete(PENDING_AGENT_KEY);
        await this.ctx.storage.put(LATEST_MATCH_KEY, pendingMatchId);

        const id = this.env.MATCH.idFromName(pendingMatchId);
        const stub = this.env.MATCH.get(id);
        await stub.fetch("https://do/init", {
          method: "POST",
          body: JSON.stringify({
            players: [pendingAgentId, agentId],
            seed: Math.floor(Math.random() * 1_000_000),
          }),
          headers: {
            "content-type": "application/json",
          },
        });

        const response: QueueResponse = { matchId: pendingMatchId, status: "ready" };
        return Response.json(response);
      }

      const matchId = crypto.randomUUID();
      await this.ctx.storage.put(PENDING_MATCH_KEY, matchId);
      await this.ctx.storage.put(PENDING_AGENT_KEY, agentId);
      await this.ctx.storage.put(LATEST_MATCH_KEY, matchId);
      await this.recordMatch(matchId);

      const response: QueueResponse = { matchId, status: "waiting" };
      return Response.json(response);
    }

    if (request.method === "GET" && url.pathname === "/live") {
      const matchId = await this.ctx.storage.get<string>(LATEST_MATCH_KEY);
      if (!matchId) {
        return Response.json({ matchId: null, state: null });
      }

      const id = this.env.MATCH.idFromName(matchId);
      const stub = this.env.MATCH.get(id);
      const resp = await stub.fetch("https://do/state");
      if (!resp.ok) {
        return Response.json({ matchId, state: null });
      }

      const payload = (await resp.json()) as { state?: unknown };
      return Response.json({ matchId, state: payload.state ?? null });
    }

    return new Response("Not found", { status: 404 });
  }

  private async recordMatch(matchId: string) {
    try {
      await this.env.DB.prepare(
        "INSERT INTO matches(id, status, created_at) VALUES (?, 'active', datetime('now'))",
      )
        .bind(matchId)
        .run();
    } catch (error) {
      console.error("Failed to record match", error);
    }
  }
}
