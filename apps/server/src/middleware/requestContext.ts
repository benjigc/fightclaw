import type { Context, Next } from "hono";
import type { AppBindings, AppVariables } from "../appTypes";

type AppContext = Context<{ Bindings: AppBindings; Variables: AppVariables }>;

export const requestContext = async (c: AppContext, next: Next) => {
	const requestId = crypto.randomUUID();
	const startedAtMs = Date.now();
	c.set("requestId", requestId);
	c.set("requestContext", { requestId, startedAtMs });
	// Set early so it applies even when handlers throw and onError returns a response.
	c.header("x-request-id", requestId);

	try {
		await next();
	} finally {
		// Ensure the header is present even when handlers return a Response directly
		// (e.g. Durable Object stub.fetch passthrough responses).
		const res = c.res;
		if (res) {
			const headers = new Headers(res.headers);
			headers.set("x-request-id", requestId);
			c.res = new Response(res.body, {
				status: res.status,
				statusText: res.statusText,
				headers,
			});
		}
	}
};

export const withRequestId = (
	c: Pick<AppContext, "get">,
	headers?: HeadersInit,
) => {
	const next = new Headers(headers);
	const requestId = c.get("requestId");
	if (requestId) next.set("x-request-id", requestId);
	return next;
};
