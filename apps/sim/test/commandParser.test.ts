import { describe, expect, test } from "bun:test";
import {
	matchCommand,
	parseCommands,
	parseCommandsWithReasoning,
} from "../src/bots/commandParser";
import type { Move } from "../src/types";

describe("parseCommands", () => {
	test("parses basic commands", () => {
		const input = "move A-4 E10\nattack A-1 F11\nrecruit infantry B2\nend_turn";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([
			{ action: "move", unitId: "A-4", target: "E10" },
			{ action: "attack", unitId: "A-1", target: "F11" },
			{ action: "recruit", unitType: "infantry", target: "B2" },
			{ action: "end_turn" },
		]);
	});

	test("ignores reasoning after ---", () => {
		const input = "move A-1 E10\nend_turn\n---\nPushing forward to attack.";
		const cmds = parseCommands(input);
		expect(cmds).toHaveLength(2);
		expect(cmds[0]?.action).toBe("move");
	});

	test("handles fortify command", () => {
		const input = "fortify A-1";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([{ action: "fortify", unitId: "A-1" }]);
	});

	test("handles upgrade command", () => {
		const input = "upgrade A-1";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([{ action: "upgrade", unitId: "A-1" }]);
	});

	test("skips blank lines and comments", () => {
		const input = "move A-1 E10\n\n# comment\nend_turn";
		const cmds = parseCommands(input);
		expect(cmds).toHaveLength(2);
	});

	test("handles pass as end_turn", () => {
		const input = "pass";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([{ action: "end_turn" }]);
	});

	test("is case-insensitive for action names", () => {
		const input = "MOVE A-1 E10\nATTACK A-2 F11";
		const cmds = parseCommands(input);
		expect(cmds[0]?.action).toBe("move");
		expect(cmds[1]?.action).toBe("attack");
	});

	test("strips markdown code fences", () => {
		const input = "```\nmove A-1 E10\nend_turn\n```";
		const cmds = parseCommands(input);
		expect(cmds).toHaveLength(2);
	});

	test("parses numbered and bulleted commands", () => {
		const input =
			"1. attack A-1 E11 (target: B-2 inf hp=1/3)\n- move A-4 D10,\n3) end turn";
		const cmds = parseCommands(input);
		expect(cmds).toEqual([
			{ action: "attack", unitId: "A-1", target: "E11" },
			{ action: "move", unitId: "A-4", target: "D10" },
			{ action: "end_turn" },
		]);
	});
});

describe("parseCommandsWithReasoning", () => {
	test("extracts reasoning after ---", () => {
		const input = "move A-1 E10\n---\nMy reasoning here.";
		const result = parseCommandsWithReasoning(input);
		expect(result.commands).toHaveLength(1);
		expect(result.reasoning).toBe("My reasoning here.");
	});

	test("handles no reasoning", () => {
		const input = "move A-1 E10\nend_turn";
		const result = parseCommandsWithReasoning(input);
		expect(result.commands).toHaveLength(2);
		expect(result.reasoning).toBeUndefined();
	});

	test("handles multi-line reasoning", () => {
		const input = "end_turn\n---\nLine 1.\nLine 2.";
		const result = parseCommandsWithReasoning(input);
		expect(result.reasoning).toBe("Line 1.\nLine 2.");
	});
});

describe("matchCommand", () => {
	test("matches move command to legal move", () => {
		const legalMoves: Move[] = [
			{ action: "move", unitId: "A-1", to: "E10" },
			{ action: "move", unitId: "A-1", to: "D10" },
			{ action: "end_turn" },
		];
		const cmd = { action: "move" as const, unitId: "A-1", target: "E10" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "move", unitId: "A-1", to: "E10" });
	});

	test("matches attack command", () => {
		const legalMoves: Move[] = [
			{ action: "attack", unitId: "A-1", target: "F11" },
			{ action: "end_turn" },
		];
		const cmd = { action: "attack" as const, unitId: "A-1", target: "F11" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "attack", unitId: "A-1", target: "F11" });
	});

	test("matches recruit command", () => {
		const legalMoves: Move[] = [
			{ action: "recruit", unitType: "infantry", at: "B2" },
			{ action: "end_turn" },
		];
		const cmd = {
			action: "recruit" as const,
			unitType: "infantry",
			target: "B2",
		};
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({
			action: "recruit",
			unitType: "infantry",
			at: "B2",
		});
	});

	test("matches fortify command", () => {
		const legalMoves: Move[] = [
			{ action: "fortify", unitId: "A-1" },
			{ action: "end_turn" },
		];
		const cmd = { action: "fortify" as const, unitId: "A-1" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "fortify", unitId: "A-1" });
	});

	test("matches upgrade command", () => {
		const legalMoves: Move[] = [
			{ action: "upgrade", unitId: "A-1" },
			{ action: "end_turn" },
		];
		const cmd = { action: "upgrade" as const, unitId: "A-1" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "upgrade", unitId: "A-1" });
	});

	test("returns null for unmatched command", () => {
		const legalMoves: Move[] = [{ action: "end_turn" }];
		const cmd = { action: "move" as const, unitId: "A-1", target: "E10" };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toBeNull();
	});

	test("matches end_turn", () => {
		const legalMoves: Move[] = [{ action: "end_turn" }];
		const cmd = { action: "end_turn" as const };
		const match = matchCommand(cmd, legalMoves);
		expect(match).toEqual({ action: "end_turn" });
	});
});
