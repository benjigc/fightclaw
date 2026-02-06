import type { AuthIdentity } from "./contracts/auth";
import type { RequestContext } from "./contracts/request";

export type RateLimitBinding = {
	limit: (params: { key: string }) => Promise<{ success: boolean }>;
};

export type AnalyticsEngineDataset = {
	// Keep this intentionally loose; in local/test envs the binding may be absent.
	writeDataPoint: (point: {
		indexes: string[];
		blobs?: (string | null)[];
		doubles?: (number | null)[];
	}) => void;
};

export type AppBindings = {
	DB: D1Database;
	CORS_ORIGIN: string;
	API_KEY_PEPPER: string;
	ADMIN_KEY: string;
	INTERNAL_RUNNER_KEY?: string;
	MATCHMAKING_ELO_RANGE?: string;
	TURN_TIMEOUT_SECONDS?: string;
	TEST_MODE?: string;
	MATCHMAKER: DurableObjectNamespace;
	MATCH: DurableObjectNamespace;
	MOVE_SUBMIT_LIMIT?: RateLimitBinding;
	READ_LIMIT?: RateLimitBinding;

	// Workstream A
	PROMPT_ENCRYPTION_KEY?: string;

	// Workstream B (optional bindings; must be safe when absent)
	OBS?: AnalyticsEngineDataset;
	SENTRY_DSN?: string;
	SENTRY_ENVIRONMENT?: string;
	SENTRY_TRACES_SAMPLE_RATE?: string;
};

export type AppVariables = {
	requestContext: RequestContext;
	requestId: string;
	auth?: AuthIdentity;
	// Back-compat bridge while other code still reads agentId directly.
	agentId?: string;
};
