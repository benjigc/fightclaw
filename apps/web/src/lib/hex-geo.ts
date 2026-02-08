import { type HexId, parseHexId } from "@fightclaw/engine";

export type PixelPoint = { x: number; y: number };

export const BOARD_ROWS = 9;
export const BOARD_COLS = 21;
export const HEX_RADIUS = 20;

/**
 * Pointy-top hex: odd-r offset layout.
 * Odd rows (B=1, D=3, …) shift right by half a hex width.
 */
export function hexToPixel(row: number, col: number, R: number): PixelPoint {
	const W = Math.sqrt(3) * R;
	const oddShift = row % 2 === 1 ? W / 2 : 0;
	return {
		x: col * W + W / 2 + oddShift,
		y: row * R * 1.5 + R,
	};
}

export function hexIdToPixel(id: HexId, R: number): PixelPoint {
	const { row, col } = parseHexId(id);
	return hexToPixel(row, col, R);
}

/** SVG polygon points for a pointy-top hexagon centred at (cx, cy). */
export function hexPoints(cx: number, cy: number, R: number): string {
	const pts: string[] = [];
	for (let i = 0; i < 6; i++) {
		const angle = (Math.PI / 180) * (60 * i - 30);
		pts.push(
			`${(cx + R * Math.cos(angle)).toFixed(2)},${(cy + R * Math.sin(angle)).toFixed(2)}`,
		);
	}
	return pts.join(" ");
}

/** viewBox string that fits the entire 21×9 board with padding. */
export function boardViewBox(R: number, pad = 4): string {
	const W = Math.sqrt(3) * R;
	const totalW = BOARD_COLS * W + W / 2 + pad * 2;
	const totalH = (BOARD_ROWS - 1) * R * 1.5 + 2 * R + pad * 2;
	return `${-pad} ${-pad} ${totalW.toFixed(1)} ${totalH.toFixed(1)}`;
}
