declare module "cloudflare:test" {
	interface ProvidedEnv extends Env {
		TEST_MIGRATIONS: D1Migration[];
		DB: D1Database;
		API_KEY_PEPPER: string;
		ADMIN_KEY: string;
		INTERNAL_RUNNER_KEY?: string;
		PROMPT_ENCRYPTION_KEY?: string;
		SENTRY_DSN?: string;
		SENTRY_ENVIRONMENT?: string;
		TEST_MODE?: string;
		MATCHMAKER: DurableObjectNamespace;
	}

	export const env: ProvidedEnv;
	export const SELF: Fetcher;
	export const applyD1Migrations: (
		db: D1Database,
		migrations: D1Migration[],
	) => Promise<void>;
	export const runInDurableObject: (
		stub: DurableObjectStub,
		fn: (
			instance: unknown,
			state: DurableObjectState,
		) => Response | Promise<Response>,
	) => Promise<Response>;
}
