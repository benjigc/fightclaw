import type { AppBindings } from "../appTypes";

export type MetricEvent =
	| "api_request"
	| "queue_join"
	| "queue_leave"
	| "match_created"
	| "match_found"
	| "match_started"
	| "match_ended"
	| "turn_timeout_forfeit"
	| "prompt_version_attached"
	| "prompt_injected"
	| "agent_model_seen"
	| "agent_inference";

export type MetricScope = "worker" | "match_do" | "matchmaker_do" | "web";

export const emitMetric = (
	env: Pick<AppBindings, "OBS" | "SENTRY_ENVIRONMENT">,
	event: MetricEvent,
	args: {
		scope: MetricScope;
		requestId?: string;
		route?: string;
		method?: string;
		status?: number;
		agentId?: string;
		matchId?: string;
		promptVersionId?: string;
		modelId?: string;
		modelProvider?: string;
		doubles?: number[];
	},
) => {
	if (!env.OBS) return;

	const blobs: (string | null)[] = [
		env.SENTRY_ENVIRONMENT ?? null,
		args.scope,
		args.route ?? null,
		args.method ?? null,
		typeof args.status === "number" ? String(args.status) : null,
		args.requestId ?? null,
		args.agentId ?? null,
		args.matchId ?? null,
		args.promptVersionId ?? null,
		args.modelProvider ?? null,
		args.modelId ?? null,
	];

	try {
		env.OBS.writeDataPoint({
			indexes: [event],
			blobs,
			doubles: args.doubles ?? [],
		});
	} catch {
		// Observability must never crash the request path.
	}
};
