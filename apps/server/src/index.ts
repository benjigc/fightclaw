import { env } from "@fightclaw/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";

type RateLimitBinding = {
  limit: (params: { key: string }) => Promise<{ success: boolean }>;
};

type AppBindings = {
  DB: D1Database;
  CORS_ORIGIN: string;
  MATCHMAKER: DurableObjectNamespace;
  MATCH: DurableObjectNamespace;
  MOVE_SUBMIT_LIMIT?: RateLimitBinding;
  READ_LIMIT?: RateLimitBinding;
};

const app = new Hono<{ Bindings: AppBindings }>();

app.use(logger());
const allowedOrigins = (env.CORS_ORIGIN ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

const readMethods = new Set(["GET", "HEAD"]);

const getIpKey = (c: { req: { header: (name: string) => string | undefined } }) => {
  const ip =
    c.req.header("cf-connecting-ip") ??
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  return `ip:${ip ?? "unknown"}`;
};

const getAgentKey = (c: { req: { header: (name: string) => string | undefined } }) => {
  const agentId = c.req.header("x-agent-id");
  if (agentId) return `agent:${agentId}`;
  const auth = c.req.header("authorization");
  if (auth) return `auth:${auth}`;
  return getIpKey(c);
};

const getMatchmakerStub = (c: { env: AppBindings }) => {
  const id = c.env.MATCHMAKER.idFromName("global");
  return c.env.MATCHMAKER.get(id);
};

const getMatchStub = (c: { env: AppBindings }, matchId: string) => {
  const id = c.env.MATCH.idFromName(matchId);
  return c.env.MATCH.get(id);
};

app.use(
  "/*",
  cors({
    origin: (origin) => {
      if (!origin) return undefined;
      return allowedOrigins.includes(origin) ? origin : undefined;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.use("/*", async (c, next) => {
  const isRead = readMethods.has(c.req.method);
  const limiter = isRead ? c.env.READ_LIMIT : c.env.MOVE_SUBMIT_LIMIT;
  if (!limiter) return next();

  const key = isRead ? getIpKey(c) : getAgentKey(c);
  const outcome = await limiter.limit({ key });
  if (!outcome.success) return c.text("Too Many Requests", 429);

  return next();
});

app.get("/", (c) => {
  return c.text("OK");
});

app.post("/v1/matches/queue", async (c) => {
  const stub = getMatchmakerStub(c);
  return stub.fetch("https://do/queue", { method: "POST" });
});

app.post("/v1/matches/:id/move", async (c) => {
  const matchId = c.req.param("id");
  if (!matchId) return c.json({ ok: false, error: "Match id is required." }, 400);

  const body = await c.req.text();
  const stub = getMatchStub(c, matchId);
  return stub.fetch("https://do/move", {
    method: "POST",
    body,
    headers: {
      "content-type": c.req.header("content-type") ?? "application/json",
    },
  });
});

app.get("/v1/leaderboard", async (c) => {
  try {
    const { results } = await c.env.DB.prepare(
      "SELECT agent_id, rating, wins, losses, updated_at FROM leaderboard ORDER BY rating DESC LIMIT 100",
    ).all();
    return c.json({ leaderboard: results ?? [] });
  } catch (error) {
    console.error("Failed to load leaderboard", error);
    return c.json({ error: "Leaderboard unavailable" }, 500);
  }
});

app.get("/v1/live", async (c) => {
  const stub = getMatchmakerStub(c);
  return stub.fetch("https://do/live");
});

export { MatchDO } from "./do/MatchDO";
export { MatchmakerDO } from "./do/MatchmakerDO";

export default app;
