import type { CloudflareOptions, ErrorEvent, Event } from "@sentry/cloudflare";
import { redactRecord } from "./redact";

type SentryEnv = {
	SENTRY_DSN?: string;
	SENTRY_ENVIRONMENT?: string;
	SENTRY_TRACES_SAMPLE_RATE?: string;
};

const scrubEvent = <T extends Event>(event: T): T => {
	const next = { ...event };

	if (next.request?.headers && typeof next.request.headers === "object") {
		next.request = {
			...next.request,
			headers: redactRecord(
				next.request.headers as Record<string, unknown>,
			) as Record<string, string>,
		};
	}

	if (next.extra && typeof next.extra === "object") {
		// Non-negotiable: never send prompt plaintext or strategy text.
		const extra = { ...(next.extra as Record<string, unknown>) };
		for (const [key, value] of Object.entries(extra)) {
			const lower = key.toLowerCase();
			if (lower.includes("prompt") || lower.includes("strategy")) {
				extra[key] = "<redacted>";
				continue;
			}
			extra[key] = value;
		}
		next.extra = extra;
	}

	return next;
};

export const sentryOptions = (env: SentryEnv): CloudflareOptions => {
	const dsn = env.SENTRY_DSN?.trim();
	const rawRate = env.SENTRY_TRACES_SAMPLE_RATE?.trim();
	const parsedRate =
		rawRate && rawRate.length > 0 ? Number.parseFloat(rawRate) : Number.NaN;
	const tracesSampleRate = Number.isFinite(parsedRate) ? parsedRate : undefined;

	return {
		dsn,
		enabled: Boolean(dsn),
		environment: env.SENTRY_ENVIRONMENT?.trim() || undefined,
		tracesSampleRate,
		beforeSend(event: ErrorEvent) {
			return scrubEvent(event);
		},
	};
};
