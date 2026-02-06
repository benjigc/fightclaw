import type { ReactNode } from "react";
import { memo } from "react";

type CellFx = {
	classes?: string[];
	overrideText?: string | null;
};

export type AsciiBoardProps = {
	header: string;
	grid: string[][];
	cellFx?: Record<string, CellFx>;
};

const ROW_LETTERS = "ABCDEFGHI";

const normalizeToken = (value: string) => {
	// Always render exactly 2 chars to preserve alignment.
	return value.slice(0, 2).padEnd(2, " ");
};

export const AsciiBoard = memo(function AsciiBoard(props: AsciiBoardProps) {
	const children: ReactNode[] = [];
	children.push(props.header, "\n");

	for (let row = 0; row < props.grid.length; row += 1) {
		const rowCells = props.grid[row] ?? [];
		const rowLabel = ROW_LETTERS[row] ?? "?";
		const indent = row % 2 === 1 ? " " : "";

		children.push(rowLabel, " ", indent);

		for (let col = 0; col < rowCells.length; col += 1) {
			const token = rowCells[col] ?? "  ";
			const key = `${ROW_LETTERS[row]}${col + 1}`;
			const fx = props.cellFx?.[key];
			const overrideText = fx?.overrideText ?? null;
			const display = normalizeToken(overrideText ?? token);
			const className = ["ascii-cell", ...(fx?.classes ?? [])].join(" ");

			children.push(
				<span key={key} className={className} data-coord={key}>
					{display}
				</span>,
			);
			if (col < rowCells.length - 1) {
				children.push(" ");
			}
		}

		if (row < props.grid.length - 1) {
			children.push("\n");
		}
	}

	return (
		<pre className="ascii-board" role="img" aria-label="ASCII arena">
			{children}
		</pre>
	);
});
