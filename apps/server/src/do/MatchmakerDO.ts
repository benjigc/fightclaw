import { DurableObject } from "cloudflare:workers";

const LATEST_MATCH_KEY = "latestMatchId";

type MatchmakerEnv = {
  DB: D1Database;
  MATCH: DurableObjectNamespace;
};

export class MatchmakerDO extends DurableObject<MatchmakerEnv> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/queue") {
      const matchId = crypto.randomUUID();
      await this.ctx.storage.put(LATEST_MATCH_KEY, matchId);
      await this.recordMatch(matchId);
      return Response.json({ matchId });
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
