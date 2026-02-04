import alchemy from "alchemy";
import { D1Database, DurableObjectNamespace, Worker } from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("fightclaw");

const db = await D1Database("database", {
  migrationsDir: "../../packages/db/src/migrations",
});

const matchmaker = DurableObjectNamespace("matchmaker", {
  className: "MatchmakerDO",
});

const match = DurableObjectNamespace("match", {
  className: "MatchDO",
});

export const server = await Worker("server", {
  cwd: "../../apps/server",
  entrypoint: "src/index.ts",
  compatibility: "node",
  bindings: {
    DB: db,
    CORS_ORIGIN: alchemy.env.CORS_ORIGIN!,
    API_KEY_PEPPER: alchemy.secret(process.env.API_KEY_PEPPER!),
    ADMIN_KEY: alchemy.secret(process.env.ADMIN_KEY!),
    MATCHMAKER: matchmaker,
    MATCH: match,
  },
  dev: {
    port: 3000,
  },
});

console.log(`Server -> ${server.url}`);

await app.finalize();
