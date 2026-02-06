import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	defineWorkersConfig,
	readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
	const __dirname = path.dirname(fileURLToPath(import.meta.url));
	const migrationsPath = path.join(
		__dirname,
		"../../packages/db/src/migrations",
	);
	const migrations = await readD1Migrations(migrationsPath).catch(() => []);

	return {
		test: {
			exclude: ["**/*.durable.test.ts"],
			setupFiles: ["./test/setup.ts"],
			poolOptions: {
				workers: {
					wrangler: { configPath: "./wrangler.toml" },
					miniflare: {
						compatibilityFlags: ["nodejs_compat"],
						d1Databases: ["DB"],
						bindings: {
							API_KEY_PEPPER: "test-pepper",
							ADMIN_KEY: "test-admin",
							INTERNAL_RUNNER_KEY: "test-runner",
							PROMPT_ENCRYPTION_KEY:
								"AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
							SENTRY_DSN: "",
							SENTRY_ENVIRONMENT: "test",
							MATCHMAKING_ELO_RANGE: "200",
							TURN_TIMEOUT_SECONDS: "60",
							TEST_MODE: "true",
							CORS_ORIGIN: "",
							TEST_MIGRATIONS: migrations,
						},
					},
				},
			},
		},
	};
});
