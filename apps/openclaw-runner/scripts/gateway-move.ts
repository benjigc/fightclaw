import {
	listLegalMoves,
	type MatchState,
	type Move,
	parseHexId,
} from "@fightclaw/engine";

type GatewayInput = {
	agentId?: string;
	state?: unknown;
};

const readStdin = async () => {
	const chunks: Buffer[] = [];
	for await (const chunk of process.stdin) {
		chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
	}
	return Buffer.concat(chunks).toString("utf8").trim();
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isMatchState = (value: unknown): value is MatchState => {
	if (!isRecord(value)) return false;
	return Array.isArray(value.board) && isRecord(value.players);
};

const extractState = (value: unknown): MatchState | null => {
	if (isMatchState(value)) return value;
	if (!isRecord(value)) return null;

	const topState = value.state;
	if (isMatchState(topState)) return topState;
	if (isRecord(topState) && isMatchState(topState.game)) return topState.game;

	return null;
};

const toCube = (hexId: string) => {
	const { row, col } = parseHexId(hexId);
	const x = col - (row - (row & 1)) / 2;
	const z = row;
	const y = -x - z;
	return { x, y, z };
};

const hexDistance = (a: string, b: string) => {
	const ca = toCube(a);
	const cb = toCube(b);
	return Math.max(
		Math.abs(ca.x - cb.x),
		Math.abs(ca.y - cb.y),
		Math.abs(ca.z - cb.z),
	);
};

const chooseStyle = (agentId: string): "pressure" | "economy" => {
	let sum = 0;
	for (const ch of agentId) sum += ch.charCodeAt(0);
	return sum % 2 === 0 ? "pressure" : "economy";
};

const selectMove = (state: MatchState, agentId: string) => {
	const legal = listLegalMoves(state);
	if (legal.length === 0) {
		return {
			move: { action: "end_turn" } as Move,
			publicThought: "No legal tactical action; ending turn.",
		};
	}

	const side =
		state.players.A.id === agentId
			? "A"
			: state.players.B.id === agentId
				? "B"
				: state.activePlayer;
	const style = chooseStyle(agentId);
	const enemyStrongholdType = side === "A" ? "stronghold_b" : "stronghold_a";
	const enemyStrongholds = state.board
		.filter((hex) => hex.type === enemyStrongholdType)
		.map((hex) => hex.id);
	const targetStronghold = enemyStrongholds[0] ?? null;

	let best = legal[0] as Move;
	let bestScore = Number.NEGATIVE_INFINITY;

	for (const move of legal) {
		let score = 0;
		switch (move.action) {
			case "attack":
				score += 1000;
				if (targetStronghold && move.target === targetStronghold) {
					score += 500;
				}
				if (style === "pressure") score += 120;
				break;
			case "move":
				score += 180;
				if (targetStronghold) {
					score += 100 - hexDistance(move.to, targetStronghold) * 8;
				}
				if (style === "pressure") score += 60;
				break;
			case "recruit":
				score += 260;
				if (
					style === "pressure" &&
					(move.unitType === "cavalry" || move.unitType === "archer")
				) {
					score += 40;
				}
				if (style === "economy") score += 80;
				break;
			case "upgrade":
				score += style === "economy" ? 350 : 280;
				break;
			case "fortify":
				score += 40;
				break;
			case "end_turn":
				score -= 10;
				break;
			case "pass":
				score -= 30;
				break;
		}
		if (score > bestScore) {
			bestScore = score;
			best = move;
		}
	}

	const summary =
		style === "pressure"
			? "Public-safe summary: applying pressure and prioritizing tempo."
			: "Public-safe summary: consolidating board control and efficiency.";

	return { move: best, publicThought: summary };
};

const main = async () => {
	const raw = await readStdin();
	if (!raw) {
		process.stdout.write(
			JSON.stringify({
				move: { action: "end_turn" },
				publicThought: "Public-safe summary unavailable.",
			}),
		);
		return;
	}

	let parsed: unknown = null;
	try {
		parsed = JSON.parse(raw);
	} catch {
		process.stdout.write(
			JSON.stringify({
				move: { action: "end_turn" },
				publicThought: "Invalid gateway input; ending turn safely.",
			}),
		);
		return;
	}

	const payload = isRecord(parsed) ? (parsed as GatewayInput) : {};
	const state = extractState(payload.state);
	const agentId =
		typeof payload.agentId === "string" && payload.agentId.length > 0
			? payload.agentId
			: "agent";

	if (!state) {
		process.stdout.write(
			JSON.stringify({
				move: { action: "end_turn" },
				publicThought: "State unavailable; ending turn safely.",
			}),
		);
		return;
	}

	const selected = selectMove(state, agentId);
	process.stdout.write(JSON.stringify(selected));
};

void main();
