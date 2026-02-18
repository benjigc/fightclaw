import { describe, expect, test } from "bun:test";
import {
	escapeHtml,
	formatTurn,
	formatTurnWithPrefix,
} from "../src/reporting/htmlUtils";

describe("reporting html utils", () => {
	test("escapeHtml escapes ampersands and angle brackets", () => {
		expect(escapeHtml("<div>&</div>")).toBe("&lt;div&gt;&amp;&lt;/div&gt;");
	});

	test("escapeHtml escapes quotes", () => {
		expect(escapeHtml(`"quoted" and 'single'`)).toBe(
			"&quot;quoted&quot; and &#39;single&#39;",
		);
	});

	test("escapeHtml handles empty and long input", () => {
		expect(escapeHtml("")).toBe("");
		const longInput = `${"a".repeat(1_024)}<tag>&`;
		expect(escapeHtml(longInput)).toBe(`${"a".repeat(1_024)}&lt;tag&gt;&amp;`);
	});

	test("formatTurn handles number, NaN, and null", () => {
		expect(formatTurn(12)).toBe("12.0");
		expect(formatTurn(Number.NaN)).toBe("n/a");
		expect(formatTurn(null)).toBe("n/a");
	});

	test("formatTurnWithPrefix only prefixes numeric values", () => {
		expect(formatTurnWithPrefix(7.25)).toBe("T7.3");
		expect(formatTurnWithPrefix(null)).toBe("n/a");
	});
});
