export type HexCoord = {
	q: number;
	r: number;
};

export type Unit = {
	id: string;
	type: "infantry" | "cavalry" | "archer";
	owner: "A" | "B";
	position: HexCoord;
	isFortified: boolean;
	movedThisTurn: boolean;
};

export type HexState = {
	coord: HexCoord;
	type: "capital" | "gold_mine" | "tower" | "plains";
	controlledBy: "A" | "B" | null;
	unit: Unit | null;
};

export type PlayerState = {
	gold: number;
	supply: number;
	supplyCap: number;
	units: Unit[];
	controlledHexes: HexCoord[];
};

export type BoardInput = HexState[] | Record<string, HexState>;

export type GameState = {
	turn: number;
	phase?: "action" | "resolution";
	activePlayer: "A" | "B";
	actionsRemaining: number;
	players: {
		A: PlayerState;
		B: PlayerState;
	};
	board: BoardInput;
};

export type BoardGridResult = {
	header: string;
	grid: string[][];
	warnings: string[];
	errorText?: string;
};

const BOARD_MIN = -3;
const BOARD_MAX = 3;
const BOARD_SIZE = 7;
const ROW_LABELS = ["A", "B", "C", "D", "E", "F", "G"];
const UNIT_LETTERS: Record<Unit["type"], string> = {
	infantry: "i",
	cavalry: "c",
	archer: "a",
};
const TERRAIN_LETTERS: Record<HexState["type"], string> = {
	capital: "K",
	gold_mine: "M",
	tower: "T",
	plains: ".",
};

export type RenderInput = unknown;

export function renderBoardGridWithWarnings(
	input: RenderInput,
): BoardGridResult {
	const warnings = new Set<string>();
	const board = normalizeBoardInput(input, warnings);
	if (!board) {
		return {
			header: "",
			grid: [],
			warnings: [...warnings],
			errorText: "Invalid board data",
		};
	}
	if (board.length === 0) {
		warnings.add("Board empty");
		return {
			header: "",
			grid: [],
			warnings: [...warnings],
			errorText: "No board data",
		};
	}
	if (board.length !== BOARD_SIZE * BOARD_SIZE) {
		warnings.add(`Board size ${board.length} (expected 49)`);
	}

	const players = extractPlayers(input);
	const unitIndex = buildUnitIndex(players, warnings);

	const grid = Array.from({ length: BOARD_SIZE }, () =>
		Array.from({ length: BOARD_SIZE }, () => "  "),
	);
	const occupied = new Set<string>();

	for (const hex of board) {
		const coord = hex.coord;
		if (!coord) {
			warnings.add("Hex missing coord");
			continue;
		}
		const { q, r } = coord;
		if (!isInBounds(q, r)) {
			warnings.add(`Hex out of bounds at ${q},${r}`);
			continue;
		}

		const row = r + 3;
		const col = q + 3;
		const key = coordKey(q, r);
		const overlayUnit = unitIndex.get(key) ?? null;
		if (hex.unit && overlayUnit) {
			warnings.add(`Overlay conflict at ${key}`);
		}
		const unit = hex.unit ?? overlayUnit;
		const owner = unit?.owner ?? hex.controlledBy ?? ".";
		const symbol = unit ? UNIT_LETTERS[unit.type] : TERRAIN_LETTERS[hex.type];

		grid[row][col] = `${owner}${symbol}`;
		if (unit) {
			occupied.add(key);
		}
	}

	for (const [key, unit] of unitIndex.entries()) {
		if (occupied.has(key)) continue;
		const { q, r } = unit.position;
		if (!isInBounds(q, r)) continue;
		const row = r + 3;
		const col = q + 3;
		grid[row][col] = `${unit.owner}${UNIT_LETTERS[unit.type]}`;
	}

	const header = `   ${Array.from(
		{ length: BOARD_SIZE },
		(_, index) => index + 1,
	).join("  ")}`;

	return { header, grid, warnings: [...warnings] };
}

export function renderBoardWithWarnings(input: RenderInput): {
	text: string;
	warnings: string[];
} {
	const result = renderBoardGridWithWarnings(input);
	if (result.errorText) {
		return { text: result.errorText, warnings: result.warnings };
	}

	const lines = [result.header];
	for (let row = 0; row < BOARD_SIZE; row += 1) {
		const rowLabel = ROW_LABELS[row] ?? "?";
		const indent = row % 2 === 1 ? "  " : "";
		lines.push(`${rowLabel} ${indent}${result.grid[row]?.join(" ") ?? ""}`);
	}

	return { text: lines.join("\n"), warnings: result.warnings };
}

export function renderBoard(input: RenderInput): string {
	return renderBoardWithWarnings(input).text;
}

function isHexState(value: unknown): value is HexState {
	if (!value || typeof value !== "object") return false;
	const candidate = value as HexState;
	return (
		typeof candidate.coord?.q === "number" &&
		typeof candidate.coord?.r === "number" &&
		typeof candidate.type === "string"
	);
}

function isHexStateLike(
	value: unknown,
): value is Omit<HexState, "coord"> & { coord?: HexCoord } {
	if (!value || typeof value !== "object") return false;
	const candidate = value as Partial<HexState>;
	return (
		typeof candidate.type === "string" &&
		Object.hasOwn(TERRAIN_LETTERS, candidate.type)
	);
}

function normalizeBoardInput(
	input: RenderInput | unknown,
	warnings: Set<string>,
): HexState[] | null {
	if (Array.isArray(input)) {
		const hexes = input.filter(isHexState);
		if (hexes.length !== input.length) {
			warnings.add("Some board entries missing coord/type");
		}
		return hexes;
	}

	if (input && typeof input === "object") {
		if ("board" in input) {
			return normalizeBoardInput(
				(input as { board?: unknown }).board,
				warnings,
			);
		}

		const entries = Object.entries(input as Record<string, unknown>);
		const hexes: HexState[] = [];
		for (const [key, value] of entries) {
			if (isHexState(value)) {
				hexes.push(value);
				continue;
			}
			if (isHexStateLike(value)) {
				const coord = value.coord ?? parseCoordKey(key);
				if (!coord) {
					warnings.add(`Unrecognized board key "${key}"`);
					continue;
				}
				hexes.push({ ...(value as HexState), coord });
			}
		}
		return hexes;
	}

	return null;
}

function extractPlayers(input: RenderInput | unknown) {
	if (!input || typeof input !== "object") return null;
	if ("players" in input) {
		return (
			(input as { players?: { A?: PlayerState; B?: PlayerState } }).players ??
			null
		);
	}
	return null;
}

function buildUnitIndex(
	players: { A?: PlayerState; B?: PlayerState } | null,
	warnings: Set<string>,
) {
	const index = new Map<string, Unit>();
	if (!players) return index;

	const addUnits = (units: Unit[] | undefined) => {
		if (!units) return;
		for (const unit of units) {
			if (!unit?.position) continue;
			const { q, r } = unit.position;
			if (!isInBounds(q, r)) continue;
			const key = coordKey(q, r);
			if (index.has(key)) {
				warnings.add(`Unit conflict at ${key}`);
				continue;
			}
			index.set(key, unit);
		}
	};

	addUnits(players.A?.units);
	addUnits(players.B?.units);
	return index;
}

function coordKey(q: number, r: number) {
	return `${q},${r}`;
}

function parseCoordKey(rawKey: string): HexCoord | null {
	const key = rawKey.trim();
	if (!key) return null;
	const matches = key.match(/-?\\d+/g);
	if (!matches || matches.length < 2) return null;
	const q = Number(matches[0]);
	const r = Number(matches[1]);
	if (!Number.isFinite(q) || !Number.isFinite(r)) return null;
	return { q, r };
}

function isInBounds(q: number, r: number) {
	return (
		typeof q === "number" &&
		typeof r === "number" &&
		q >= BOARD_MIN &&
		q <= BOARD_MAX &&
		r >= BOARD_MIN &&
		r <= BOARD_MAX
	);
}

export function renderBoardSelfTest() {
	const board: HexState[] = [];
	for (let r = BOARD_MIN; r <= BOARD_MAX; r += 1) {
		for (let q = BOARD_MIN; q <= BOARD_MAX; q += 1) {
			board.push({
				coord: { q, r },
				type: "plains",
				controlledBy: null,
				unit: null,
			});
		}
	}

	board[0] = { ...board[0], type: "capital", controlledBy: "A" };
	board[board.length - 1] = {
		...board[board.length - 1],
		type: "capital",
		controlledBy: "B",
	};
	board[10] = { ...board[10], type: "gold_mine", controlledBy: "A" };
	board[20] = { ...board[20], type: "tower", controlledBy: "B" };

	const sample: GameState = {
		turn: 1,
		activePlayer: "A",
		actionsRemaining: 3,
		players: {
			A: { gold: 10, supply: 2, supplyCap: 5, units: [], controlledHexes: [] },
			B: { gold: 9, supply: 2, supplyCap: 5, units: [], controlledHexes: [] },
		},
		board,
	};

	const output = renderBoard(sample);
	return (
		output.includes("K") &&
		output.includes("M") &&
		output.includes("T") &&
		output.includes(".")
	);
}
