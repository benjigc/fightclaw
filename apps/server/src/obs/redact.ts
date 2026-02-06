const REDACTED = "<redacted>";

const isSensitiveKey = (key: string) => {
	const lower = key.toLowerCase();
	if (lower === "authorization") return true;
	if (lower === "cookie") return true;
	if (lower === "set-cookie") return true;
	if (lower === "x-runner-key") return true;
	if (lower === "x-admin-key") return true;
	// Non-negotiable: redact any "*key*" fields.
	if (lower.includes("key")) return true;
	if (lower.includes("token")) return true;
	if (lower.includes("secret")) return true;
	if (lower.includes("password")) return true;
	return false;
};

export const redactValue = (key: string, value: unknown) => {
	if (isSensitiveKey(key)) return REDACTED;
	return value;
};

export const redactRecord = (record: Record<string, unknown>) => {
	const out: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(record)) {
		out[key] = redactValue(key, value);
	}
	return out;
};

export const redactHeaders = (headers: Headers) => {
	const out: Record<string, string> = {};
	for (const [key, value] of headers.entries()) {
		out[key] = String(redactValue(key, value));
	}
	return out;
};
