export function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

export function formatTurn(value: number | null): string {
	if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
	return value.toFixed(1);
}

export function formatTurnWithPrefix(
	value: number | null,
	prefix = "T",
): string {
	const formatted = formatTurn(value);
	return /^\d+(\.\d+)?$/.test(formatted) ? `${prefix}${formatted}` : formatted;
}
