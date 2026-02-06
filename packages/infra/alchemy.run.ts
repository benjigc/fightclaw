import alchemy from "alchemy";
import {
	AnalyticsEngineDataset,
	D1Database,
	DurableObjectNamespace,
	RateLimit,
	VersionMetadata,
	Worker,
} from "alchemy/cloudflare";
import { config } from "dotenv";

config({ path: "./.env" });
config({ path: "../../apps/server/.env" });

const app = await alchemy("fightclaw");

const db = await D1Database("database", {
	migrationsDir: "../../packages/db/src/migrations",
});

const matchmaker = DurableObjectNamespace("matchmaker", {
	className: "MatchmakerDO",
	sqlite: true,
});

const match = DurableObjectNamespace("match", {
	className: "MatchDO",
	sqlite: true,
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

const obs = AnalyticsEngineDataset("obs", {
	dataset: "FIGHTCLAW_METRICS",
});

const versionMetadata = VersionMetadata();

export const server = await Worker("server", {
	cwd: "../../apps/server",
	entrypoint: "src/index.ts",
	compatibility: "node",
	bindings: {
		DB: db,
		CORS_ORIGIN: alchemy.env.CORS_ORIGIN ?? "",
		API_KEY_PEPPER: alchemy.secret(process.env.API_KEY_PEPPER ?? ""),
		ADMIN_KEY: alchemy.secret(process.env.ADMIN_KEY ?? ""),
		INTERNAL_RUNNER_KEY: alchemy.secret(process.env.INTERNAL_RUNNER_KEY ?? ""),
		PROMPT_ENCRYPTION_KEY: alchemy.secret(
			process.env.PROMPT_ENCRYPTION_KEY ?? "",
		),
		SENTRY_DSN: alchemy.secret(process.env.SENTRY_DSN ?? ""),
		SENTRY_ENVIRONMENT: app.stage,
		SENTRY_TRACES_SAMPLE_RATE:
			process.env.SENTRY_TRACES_SAMPLE_RATE ??
			(app.stage === "production" ? "0.1" : "1.0"),
		CF_VERSION_METADATA: versionMetadata,
		OBS: obs,
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
