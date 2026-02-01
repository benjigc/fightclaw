import alchemy from "alchemy";
import {
  D1Database,
  DurableObjectNamespace,
  RateLimit,
  Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("fightclaw", { profile: "BGCIV" });

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

const matchmaker = DurableObjectNamespace("matchmaker", {
  className: "MatchmakerDO",
});

const match = DurableObjectNamespace("match", {
  className: "MatchDO",
});

const moveSubmitLimit = RateLimit({
  namespace_id: 1001,
  simple: {
    limit: 30,
    period: 10,
  },
});

const readLimit = RateLimit({
  namespace_id: 1002,
  simple: {
    limit: 300,
    period: 60,
  },
});

export const server = await Worker("server", {
  cwd: "../../apps/server",
  entrypoint: "src/index.ts",
  compatibility: "node",
  bindings: {
    DB: db,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN!,
    MATCHMAKER: matchmaker,
    MATCH: match,
    MOVE_SUBMIT_LIMIT: moveSubmitLimit,
    READ_LIMIT: readLimit,
  },
  dev: {
    port: 3000,
  },
});

console.log(`Server -> ${server.url}`);

await app.finalize();
