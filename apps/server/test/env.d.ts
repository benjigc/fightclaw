declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
		DB: D1Database;
		API_KEY_PEPPER: string;
		ADMIN_KEY: string;
		INTERNAL_RUNNER_KEY?: string;
		TEST_MODE?: string;
		MATCHMAKER: DurableObjectNamespace;
	}
}
