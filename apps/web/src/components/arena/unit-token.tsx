import type { PlayerSide, Unit, UnitType } from "@fightclaw/engine";
import { motion } from "framer-motion";
import { memo } from "react";
import { PLAYER_COLORS, UNIT_ASCII } from "@/lib/arena-theme";

export type UnitAnimState =
	| "idle"
	| "moving"
	| "attacking"
	| "spawning"
	| "dying"
	| "fortifying";

export type UnitTokenProps = {
	unit: Unit;
	x: number;
	y: number;
	radius: number;
	animState: UnitAnimState;
};

const attackKeyframes = [1, 1.3, 1];

export const UnitToken = memo(function UnitToken({
	unit,
	x,
	y,
	radius,
	animState,
}: UnitTokenProps) {
	const color = PLAYER_COLORS[unit.owner as PlayerSide] ?? PLAYER_COLORS.A;
	const lines = UNIT_ASCII[unit.type as UnitType] ?? UNIT_ASCII.infantry;
	const fontSize = radius * 0.28;
	const lineHeight = fontSize * 1.2;
	const startY = -((lines.length - 1) * lineHeight) / 2;

	return (
		<motion.g
			initial={
				animState === "spawning"
					? { x, y, scale: 0, opacity: 0 }
					: { x, y, scale: 1, opacity: 1 }
			}
			animate={
				animState === "attacking"
					? { x, y, scale: attackKeyframes, opacity: 1 }
					: { x, y, scale: 1, opacity: 1 }
			}
			exit={{ scale: 0, opacity: 0, transition: { duration: 0.25 } }}
			transition={{ type: "tween", duration: 0.3, ease: "easeInOut" }}
		>
			{/* ASCII art unit */}
			{lines.map((line, i) => (
				<text
					key={line}
					x={0}
					y={startY + i * lineHeight}
					textAnchor="middle"
					dominantBaseline="central"
					fontFamily="monospace"
					fontSize={fontSize}
					fill={color.fill}
					style={{ pointerEvents: "none" }}
				>
					{line}
				</text>
			))}

			{/* Fortify indicator */}
			{unit.isFortified ? (
				<circle
					r={radius * 0.5}
					fill="none"
					stroke="#ffffff"
					strokeWidth={1.2}
					strokeOpacity={0.6}
					strokeDasharray="3 2"
				/>
			) : null}
		</motion.g>
	);
});
