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
	stackCount?: number;
};

const attackKeyframes = [1, 1.3, 1];

export const UnitToken = memo(function UnitToken({
	unit,
	x,
	y,
	radius,
	animState,
	stackCount,
}: UnitTokenProps) {
	const color = PLAYER_COLORS[unit.owner as PlayerSide] ?? PLAYER_COLORS.A;
	const lines = UNIT_ASCII[unit.type as UnitType] ?? UNIT_ASCII.infantry;
	const fontSize = radius * 0.28;
	const lineHeight = fontSize * 1.2;
	const startY = -((lines.length - 1) * lineHeight) / 2;

	const hpFraction =
		unit.maxHp > 0 ? Math.max(0, Math.min(1, unit.hp / unit.maxHp)) : 1;
	const showHpBar = unit.hp < unit.maxHp;
	const hpBarWidth = radius * 0.8;
	const hpBarHeight = radius * 0.08;
	const hpBarY = radius * 0.42;

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

			{/* HP bar (only shown when damaged) */}
			{showHpBar ? (
				<g>
					<rect
						x={-hpBarWidth / 2}
						y={hpBarY}
						width={hpBarWidth}
						height={hpBarHeight}
						fill="rgba(255,255,255,0.15)"
						rx={hpBarHeight / 2}
					/>
					<rect
						x={-hpBarWidth / 2}
						y={hpBarY}
						width={hpBarWidth * hpFraction}
						height={hpBarHeight}
						fill={
							hpFraction > 0.5
								? "#4ade80"
								: hpFraction > 0.25
									? "#fbbf24"
									: "#ef4444"
						}
						rx={hpBarHeight / 2}
					/>
				</g>
			) : null}

			{/* Stack count badge */}
			{stackCount != null && stackCount > 1 ? (
				<g>
					<circle
						cx={radius * 0.35}
						cy={-radius * 0.35}
						r={radius * 0.16}
						fill="#000000"
						stroke={color.fill}
						strokeWidth={0.8}
					/>
					<text
						x={radius * 0.35}
						y={-radius * 0.35}
						textAnchor="middle"
						dominantBaseline="central"
						fontFamily="monospace"
						fontSize={radius * 0.16}
						fill={color.fill}
						style={{ pointerEvents: "none" }}
					>
						{stackCount}
					</text>
				</g>
			) : null}

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
