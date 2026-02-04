import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineWorkersConfig, readD1Migrations } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const migrationsPath = path.join(__dirname, "../../packages/db/src/migrations");
  const migrations = await readD1Migrations(migrationsPath).catch(() => []);

  return {
    test: {
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
              CORS_ORIGIN: "",
              TEST_MIGRATIONS: migrations,
            },
          },
        },
      },
    },
  };
});
