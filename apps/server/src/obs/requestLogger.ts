import type { Context, Next } from "hono";
import type { AppBindings, AppVariables } from "../appTypes";
import { log } from "./log";
import { emitMetric } from "./metrics";

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

const UUID_RE =
	/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi;

export const normalizePath = (path: string) => path.replace(UUID_RE, ":id");

const getMatchIdFromPath = (path: string) => {
	const match = path.match(UUID_RE);
	return match?.[0] ?? null;
};

const truncateStack = (stack: string, max = 4000) =>
	stack.length > max ? `${stack.slice(0, max)}…` : stack;

export const requestLogger = async (c: AppContext, next: Next) => {
	const reqCtx = c.get("requestContext");
	const startedAt = reqCtx.startedAtMs;
	const requestId = reqCtx.requestId;
	const method = c.req.method;
	const path = c.req.path;
	const route = normalizePath(path);
	const matchId = getMatchIdFromPath(path);

	const auth = c.get("auth");
	const agentIdAtStart = auth?.agentId ?? c.get("agentId") ?? null;

	log("info", "request_start", {
		requestId,
		method,
		route,
		agentId: agentIdAtStart,
		matchId,
	});

	let ended = false;
	const end = (reason?: string) => {
		if (ended) return;
		ended = true;

		const authNow = c.get("auth");
		const agentId = authNow?.agentId ?? c.get("agentId") ?? null;
		const durationMs = Date.now() - startedAt;
		const status = c.res.status;

		log("info", "request_end", {
			requestId,
			method,
			route,
			status,
			durationMs,
			agentId,
			matchId,
			reason,
		});

		emitMetric(c.env, "api_request", {
			scope: "worker",
			requestId,
			route,
			method,
			status,
			agentId: agentId ?? undefined,
			matchId: matchId ?? undefined,
			doubles: [durationMs],
		});
	};

	try {
		await next();
	} catch (error) {
		const authNow = c.get("auth");
		const agentId = authNow?.agentId ?? c.get("agentId") ?? null;
		const durationMs = Date.now() - startedAt;
		const err = error as Error;
		log("error", "request_error", {
			requestId,
			method,
			route,
			durationMs,
			agentId,
			matchId,
			error: {
				name: err?.name ?? "Error",
				message: err?.message ?? String(error),
				stack: typeof err?.stack === "string" ? truncateStack(err.stack) : null,
			},
		});
		throw error;
	}

	const contentType = c.res.headers.get("content-type") ?? "";
	if (contentType.includes("text/event-stream") && c.res.body) {
		const signal = c.req.raw.signal;
		if (signal) {
			signal.addEventListener(
				"abort",
				() => {
					end("aborted");
				},
				{ once: true },
			);
		}

		const body = c.res.body.pipeThrough(
			new TransformStream<Uint8Array, Uint8Array>({
				transform(chunk, controller) {
					controller.enqueue(chunk);
				},
				flush() {
					end("stream_closed");
				},
			}),
		);
		const headers = new Headers(c.res.headers);
		c.res = new Response(body, {
			status: c.res.status,
			statusText: c.res.statusText,
			headers,
		});
		return;
	}

	end();
};
