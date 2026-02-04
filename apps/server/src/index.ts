import { env } from "@fightclaw/env/server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";
import { MoveSchema } from "@fightclaw/engine";

type RateLimitBinding = {
  limit: (params: { key: string }) => Promise<{ success: boolean }>;
};

type AppBindings = {
  DB: D1Database;
  CORS_ORIGIN: string;
  API_KEY_PEPPER: string;
  ADMIN_KEY: string;
  MATCHMAKER: DurableObjectNamespace;
  MATCH: DurableObjectNamespace;
  MOVE_SUBMIT_LIMIT?: RateLimitBinding;
  READ_LIMIT?: RateLimitBinding;
};

type AppVariables = {
  agentId: string;
};

const app = new Hono<{ Bindings: AppBindings; Variables: AppVariables }>();

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

const getBearerToken = (authorization?: string) => {
  if (!authorization) return null;
  const [scheme, token] = authorization.split(" ");
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  return token.trim();
};

const matchIdSchema = z.string().uuid();

const movePayloadSchema = z
  .object({
    moveId: z.string().min(1),
    expectedVersion: z.number().int(),
    move: MoveSchema,
  })
  .strict();

const finishPayloadSchema = z
  .object({
    reason: z.literal("forfeit").optional(),
  })
  .strict();

const parseJson = async (c: { req: { json: () => Promise<unknown> } }) => {
  try {
    return { ok: true as const, data: await c.req.json() };
  } catch {
    return { ok: false as const, data: null };
  }
};

const sha256Hex = async (input: string) => {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
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

app.use("/v1/matches/*", async (c, next) => {
  const path = c.req.path;
  if (c.req.method === "GET" && (path.endsWith("/state") || path.endsWith("/spectate"))) {
    return next();
  }

  const token = getBearerToken(c.req.header("authorization"));
  if (!token) return c.text("Unauthorized", 401);
  const pepper = c.env.API_KEY_PEPPER;
  if (!pepper) return c.text("Auth not configured", 500);

  const hash = await sha256Hex(`${pepper}${token}`);
  const row = await c.env.DB.prepare(
    "SELECT id FROM agents WHERE api_key_hash = ?",
  )
    .bind(hash)
    .first<{ id: string }>();

  if (!row?.id) return c.text("Unauthorized", 401);
  c.set("agentId", row.id);
  return next();
});

app.get("/", (c) => {
  return c.text("OK");
});

app.get("/health", (c) => {
  return c.text("OK");
});

app.post("/v1/matches/queue", async (c) => {
  const stub = getMatchmakerStub(c);
  return stub.fetch("https://do/queue", {
    method: "POST",
    headers: {
      "x-agent-id": c.get("agentId"),
    },
  });
});

app.post("/v1/matches/:id/move", async (c) => {
  const matchId = c.req.param("id");
  const matchIdResult = matchIdSchema.safeParse(matchId);
  if (!matchIdResult.success) {
    return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
  }

  const jsonResult = await parseJson(c);
  if (!jsonResult.ok) {
    return c.json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const payloadResult = movePayloadSchema.safeParse(jsonResult.data);
  if (!payloadResult.success) {
    return c.json({ ok: false, error: "Invalid move payload." }, 400);
  }

  const stub = getMatchStub(c, matchIdResult.data);
  return stub.fetch("https://do/move", {
    method: "POST",
    body: JSON.stringify(payloadResult.data),
    headers: {
      "content-type": "application/json",
      "x-agent-id": c.get("agentId"),
      "x-match-id": matchIdResult.data,
    },
  });
});

app.post("/v1/matches/:id/finish", async (c) => {
  const matchId = c.req.param("id");
  const matchIdResult = matchIdSchema.safeParse(matchId);
  if (!matchIdResult.success) {
    return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
  }

  const adminKey = c.req.header("x-admin-key");
  if (!adminKey || adminKey !== c.env.ADMIN_KEY) {
    return c.text("Forbidden", 403);
  }

  const agentId = c.get("agentId") ?? c.req.header("x-agent-id");
  if (!agentId) {
    return c.text("Unauthorized", 401);
  }

  const jsonResult = await parseJson(c);
  if (!jsonResult.ok) {
    return c.json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  const payloadResult = finishPayloadSchema.safeParse(jsonResult.data);
  if (!payloadResult.success) {
    return c.json({ ok: false, error: "Invalid finish payload." }, 400);
  }

  const stub = getMatchStub(c, matchIdResult.data);
  return stub.fetch("https://do/finish", {
    method: "POST",
    body: JSON.stringify(payloadResult.data),
    headers: {
      "content-type": "application/json",
      "x-agent-id": agentId,
      "x-match-id": matchIdResult.data,
    },
  });
});

app.get("/v1/matches/:id/state", async (c) => {
  const matchId = c.req.param("id");
  const matchIdResult = matchIdSchema.safeParse(matchId);
  if (!matchIdResult.success) {
    return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
  }

  const stub = getMatchStub(c, matchIdResult.data);
  return stub.fetch("https://do/state");
});

app.get("/v1/matches/:id/stream", async (c) => {
  const matchId = c.req.param("id");
  const matchIdResult = matchIdSchema.safeParse(matchId);
  if (!matchIdResult.success) {
    return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
  }

  const stub = getMatchStub(c, matchIdResult.data);
  return stub.fetch("https://do/stream", {
    headers: {
      "x-agent-id": c.get("agentId"),
    },
  });
});

app.get("/v1/matches/:id/spectate", async (c) => {
  const matchId = c.req.param("id");
  const matchIdResult = matchIdSchema.safeParse(matchId);
  if (!matchIdResult.success) {
    return c.json({ ok: false, error: "Match id must be a UUID." }, 400);
  }

  const stub = getMatchStub(c, matchIdResult.data);
  return stub.fetch("https://do/spectate");
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
