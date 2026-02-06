import { redactRecord } from "./redact";

export type LogLevel = "debug" | "info" | "warn" | "error";

export const log = (
	level: LogLevel,
	message: string,
	fields?: Record<string, unknown>,
) => {
	const payload = {
		timestamp: new Date().toISOString(),
		level,
		message,
		...(fields ? redactRecord(fields) : {}),
	};

	// eslint-disable-next-line no-console
	const fn = console[level] ?? console.log;
	fn(JSON.stringify(payload));
};
