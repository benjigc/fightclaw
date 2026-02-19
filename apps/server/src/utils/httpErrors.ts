import type { Context } from "hono";

type AnyContext = Context;
const reservedEnvelopeKeys = new Set(["ok", "error", "code", "requestId"]);

const readRequestId = (c: AnyContext) => {
	try {
		const getter = (c as { get?: (key: string) => unknown }).get;
		if (!getter) return undefined;
		const value = getter("requestId");
		return typeof value === "string" ? value : undefined;
	} catch {
		return undefined;
	}
};

const sanitizeExtra = (extra?: Record<string, unknown>) => {
	if (!extra) return undefined;
	const entries = Object.entries(extra).filter(
		([key]) => !reservedEnvelopeKeys.has(key),
	);
	if (entries.length === 0) return undefined;
	return Object.fromEntries(entries);
};

const readCodeFromExtra = (extra?: Record<string, unknown>) => {
	if (!extra) return undefined;
	return typeof extra.code === "string" ? extra.code : undefined;
};

const errorBody = (
	c: AnyContext,
	error: string,
	code?: string,
	extra?: Record<string, unknown>,
) => {
	const requestId = readRequestId(c);
	const safeExtra = sanitizeExtra(extra);
	const safeCode = code ?? readCodeFromExtra(extra);
	return {
		...(safeExtra ?? {}),
		ok: false,
		error,
		...(safeCode ? { code: safeCode } : {}),
		...(requestId ? { requestId } : {}),
	};
};

export const badRequest = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json(errorBody(c, error, undefined, extra), 400);
};

export const notFound = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json(errorBody(c, error, undefined, extra), 404);
};

export const conflict = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json(errorBody(c, error, undefined, extra), 409);
};

export const unauthorized = (c: AnyContext) => {
	return c.json(errorBody(c, "Unauthorized.", "unauthorized"), 401);
};

export const forbidden = (c: AnyContext) => {
	return c.json(errorBody(c, "Forbidden.", "forbidden"), 403);
};

export const tooManyRequests = (c: AnyContext) => {
	return c.json(errorBody(c, "Too Many Requests.", "rate_limited"), 429);
};

export const internalServerError = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json(errorBody(c, error, undefined, extra), 500);
};

export const serviceUnavailable = (
	c: AnyContext,
	error: string,
	extra?: Record<string, unknown>,
) => {
	return c.json(errorBody(c, error, undefined, extra), 503);
};

export const upgradeRequired = (c: AnyContext, error: string) => {
	return c.json(errorBody(c, error, "websocket_upgrade_required"), 426);
};
