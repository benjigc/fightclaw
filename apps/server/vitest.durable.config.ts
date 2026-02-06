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
			include: process.env.VITEST_INCLUDE
				? process.env.VITEST_INCLUDE.split(",")
				: ["test/**/*.durable.test.ts"],
			setupFiles: ["./test/setup.ts"],
			fileParallelism: false,
			maxConcurrency: 1,
			poolOptions: {
				workers: {
					// vpw currently trips over SQLite sidecar files (`.sqlite-shm`/`.sqlite-wal`)
					// when using isolated storage + SQLite-backed Durable Objects.
					// Durable tests in this repo already reset state explicitly.
					isolatedStorage: false,
					singleWorker: true,
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
