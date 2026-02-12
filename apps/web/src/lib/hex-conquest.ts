import type {
	HexType,
	MatchState,
	PlayerSide,
	Unit,
	UnitType,
} from "@fightclaw/engine";
import { parseHexId } from "@fightclaw/engine";

export type BoardGridResult = {
	header: string;
	grid: string[][];
	warnings: string[];
	errorText?: string;
};

const ROWS = 9;
const COLS = 21;

const UNIT_LETTERS: Record<UnitType, string> = {
	infantry: "i",
	cavalry: "c",
	archer: "a",
};

const TERRAIN_LETTERS: Record<HexType, string> = {
	plains: ".",
	forest: "F",
	hills: "h",
	high_ground: "H",
	gold_mine: "G",
	lumber_camp: "L",
	crown: "C",
	stronghold_a: "S",
	stronghold_b: "S",
	deploy_a: "D",
	deploy_b: "D",
};

export type RenderInput = unknown;

export function renderBoardGridWithWarnings(
	input: RenderInput,
): BoardGridResult {
	const warnings: string[] = [];
	const state = extractMatchState(input);
	if (!state) {
		return {
			header: "",
			grid: [],
			warnings: ["Invalid board data"],
			errorText: "Invalid board data",
		};
	}

	const board = Array.isArray(state.board) ? state.board : [];
	if (board.length === 0) {
		return {
			header: "",
			grid: [],
			warnings: ["Board empty"],
			errorText: "No board data",
		};
	}
	if (board.length !== ROWS * COLS) {
		warnings.push(`Board size ${board.length} (expected ${ROWS * COLS})`);
	}

	const unitByPos = new Map<string, Unit>();
	for (const side of ["A", "B"] as PlayerSide[]) {
		const units = state.players?.[side]?.units;
		if (units) {
			for (const unit of units) {
				if (unit?.position) unitByPos.set(unit.position, unit);
			}
		}
	}

	const grid: string[][] = Array.from({ length: ROWS }, () =>
		Array.from({ length: COLS }, () => "  "),
	);

	for (const hex of board) {
		if (!hex?.id) {
			warnings.push("Hex missing id");
			continue;
		}
		const { row, col } = parseHexId(hex.id);
		if (row < 0 || row >= ROWS || col < 0 || col >= COLS) {
			warnings.push(`Hex out of bounds: ${hex.id}`);
			continue;
		}

		const unit =
			hex.unitIds?.length > 0 ? (unitByPos.get(hex.id) ?? null) : null;
		const owner = unit?.owner ?? hex.controlledBy ?? ".";
		const symbol = unit
			? (UNIT_LETTERS[unit.type] ?? "?")
			: (TERRAIN_LETTERS[hex.type] ?? "?");
		grid[row]![col] = `${owner}${symbol}`;
	}

	const headerNums = Array.from({ length: COLS }, (_, i) =>
		String(i + 1).padStart(2),
	);
	const header = `  ${headerNums.join(" ")}`;

	return { header, grid, warnings };
}

export function renderBoardWithWarnings(input: RenderInput): {
	text: string;
	warnings: string[];
} {
	const result = renderBoardGridWithWarnings(input);
	if (result.errorText) {
		return { text: result.errorText, warnings: result.warnings };
	}
	const rowLabels = "ABCDEFGHI";
	const lines = [result.header];
	for (let row = 0; row < ROWS; row++) {
		const rowLabel = rowLabels[row] ?? "?";
		lines.push(`${rowLabel} ${(result.grid[row] ?? []).join(" ")}`);
	}

	return { text: lines.join("\n"), warnings: result.warnings };
}

export function renderBoard(input: RenderInput): string {
	return renderBoardWithWarnings(input).text;
}

function extractMatchState(input: unknown): MatchState | null {
	if (!input || typeof input !== "object") return null;
	const record = input as Record<string, unknown>;
	if (Array.isArray(record.board) && record.players) {
		return input as MatchState;
	}
	if (record.state && typeof record.state === "object") {
		return extractMatchState(record.state);
	}
	return null;
}
