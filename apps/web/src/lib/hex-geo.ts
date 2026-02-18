import { type HexId, parseHexId as parseHexIdEngine } from "@fightclaw/engine";
export { parseHexIdEngine as parseHexId };

export type PixelPoint = { x: number; y: number };

export const STACK_OFFSET_Y = 4; // SVG units per elevation layer

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
	const { row, col } = parseHexIdEngine(id);
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

/** viewBox string that fits a board of given dimensions with padding.
 *
 * Even rows: hex centers span [W/2 .. (cols-1)*W + W/2]
 * Odd rows:  hex centers span [W .. (cols-1)*W + W]
 *
 * Polygon half-width = W/2, so full content spans:
 *   left  = 0  (even row col-0 center W/2 minus half-width W/2)
 *   right = (cols-1)*W + W + W/2 = cols*W + W/2  (odd row last col plus half-width)
 *
 * The visual midpoint of all that content is ((cols*W + W/2) / 2).
 * We build the viewBox centred on that midpoint.
 */
export function boardViewBox(
	R: number,
	pad = 4,
	cols = BOARD_COLS,
	rows = BOARD_ROWS,
): string {
	const W = Math.sqrt(3) * R;
	// Content extents (polygon outer edges)
	const contentLeft = 0;
	const contentRight = cols * W + W / 2; // odd-row last col right edge
	const contentMid = (contentLeft + contentRight) / 2;
	const contentH = (rows - 1) * R * 1.5 + 2 * R;
	// ViewBox: centred on content mid, padded equally on all sides
	const vbW = contentRight - contentLeft + pad * 2;
	const vbH = contentH + pad * 2;
	return `${(contentMid - vbW / 2).toFixed(2)} ${-pad} ${vbW.toFixed(2)} ${vbH.toFixed(2)}`;
}
