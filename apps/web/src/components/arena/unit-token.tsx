import type { PlayerSide, Unit, UnitType } from "@fightclaw/engine";
import { motion } from "framer-motion";
import { memo, useMemo } from "react";
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
	lungeTarget?: { x: number; y: number };
	activePlayer?: "A" | "B";
};

export const UnitToken = memo(function UnitToken({
	unit,
	x,
	y,
	radius,
	animState,
	stackCount,
	lungeTarget,
	activePlayer,
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

	const lungeOffsets = useMemo(() => {
		if (animState !== "attacking" || !lungeTarget) return null;
		const dx = lungeTarget.x - x;
		const dy = lungeTarget.y - y;
		const dist = Math.sqrt(dx * dx + dy * dy);
		const scale = Math.min(8, dist * 0.3) / (dist || 1);
		return {
			x: [x, x + dx * scale, x],
			y: [y, y + dy * scale, y],
		};
	}, [animState, lungeTarget, x, y]);
	const lungeX = lungeOffsets?.x ?? x;
	const lungeY = lungeOffsets?.y ?? y;

	// Stable random offsets for death dissolve effect
	const dissolveOffsets = useMemo(() => {
		if (animState !== "dying") return null;
		const offsets: { randX: number; randY: number }[] = [];
		for (const line of lines) {
			for (const _char of line) {
				offsets.push({
					randX: (Math.random() - 0.5) * radius * 1.5,
					randY: (Math.random() - 0.5) * radius * 1.5,
				});
			}
		}
		return offsets;
	}, [animState, lines, radius]);

	const isDying = animState === "dying";
	const isIdleActive = animState === "idle" && unit.owner === activePlayer;

	return (
		<motion.g
			initial={
				animState === "spawning"
					? { x, y, scale: 0, opacity: 0 }
					: { x, y, scale: 1, opacity: 1 }
			}
			animate={
				lungeOffsets
					? { x: lungeX, y: lungeY, scale: 1, opacity: 1 }
					: {
							x,
							y,
							scale: 1,
							opacity: isIdleActive ? [0.85, 1, 0.85] : 1,
						}
			}
			exit={
				isDying
					? { opacity: 0, transition: { duration: 0.5 } }
					: { scale: 0, opacity: 0, transition: { duration: 0.25 } }
			}
			transition={
				lungeOffsets
					? {
							x: { type: "tween", duration: 0.25, ease: "easeInOut" },
							y: { type: "tween", duration: 0.25, ease: "easeInOut" },
							scale: { type: "tween", duration: 0.25, ease: "easeInOut" },
							opacity: { type: "tween", duration: 0.25, ease: "easeInOut" },
						}
					: {
							x: { type: "spring", stiffness: 200, damping: 20 },
							y: { type: "spring", stiffness: 200, damping: 20 },
							scale: { type: "tween", duration: 0.3, ease: "easeInOut" },
							opacity: isIdleActive
								? {
										duration: 3.5,
										repeat: Number.POSITIVE_INFINITY,
										ease: "easeInOut",
									}
								: { type: "tween", duration: 0.3, ease: "easeInOut" },
						}
			}
		>
			{/* ASCII art unit — dissolve individual chars when dying */}
			{isDying && dissolveOffsets
				? (() => {
						let runningIdx = 0;
						return lines.flatMap((line, lineIdx) =>
							line.split("").map((char, charIdx) => {
								const currentIdx = runningIdx++;
								if (char === " ") return null;
								const charX = (charIdx - line.length / 2) * (fontSize * 0.6);
								const charY = startY + lineIdx * lineHeight;
								const offsets = dissolveOffsets[currentIdx];
								if (!offsets) return null;
								return (
									<motion.text
										key={`d-${unit.id}-${lineIdx}-${currentIdx}`}
										initial={{ x: charX, y: charY, opacity: 1 }}
										animate={{
											x: charX + offsets.randX,
											y: charY + offsets.randY,
											opacity: 0,
										}}
										transition={{
											duration: 0.4,
											delay: currentIdx * 0.03,
											ease: "easeOut",
										}}
										textAnchor="middle"
										dominantBaseline="central"
										fontFamily="monospace"
										fontSize={fontSize}
										fill={color.fill}
										style={{ pointerEvents: "none" }}
									>
										{char}
									</motion.text>
								);
							}),
						);
					})()
				: lines.map((line, i) => (
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
					<motion.rect
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
						animate={{ width: hpBarWidth * hpFraction }}
						transition={{ type: "tween", duration: 0.4, ease: "easeOut" }}
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
				<motion.circle
					r={radius * 0.5}
					fill="none"
					stroke={color.stroke}
					strokeWidth={1.2}
					strokeDasharray="3 2"
					animate={{ strokeOpacity: [0.6, 1, 0.6] }}
					transition={{
						duration: 2,
						repeat: Number.POSITIVE_INFINITY,
						ease: "easeInOut",
					}}
				/>
			) : null}
		</motion.g>
	);
});
