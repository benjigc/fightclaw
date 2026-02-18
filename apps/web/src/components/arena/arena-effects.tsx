import { AnimatePresence, motion } from "framer-motion";
import { memo } from "react";
import type { ArenaEffect } from "@/lib/arena-animator";
import { EFFECT_COLORS } from "@/lib/arena-theme";
import { hexIdToPixel, hexPoints } from "@/lib/hex-geo";

export type ArenaEffectsProps = {
	effects: ArenaEffect[];
	hexRadius: number;
};

export const ArenaEffects = memo(function ArenaEffects({
	effects,
	hexRadius,
}: ArenaEffectsProps) {
	return (
		<AnimatePresence>
			{effects.map((fx) => {
				// Ranged attack tracer line
				if (fx.type === "attack-tracer" && fx.targetHexId) {
					const from = hexIdToPixel(fx.hexId, hexRadius);
					const to = hexIdToPixel(fx.targetHexId, hexRadius);
					const lineLength = Math.sqrt(
						(to.x - from.x) ** 2 + (to.y - from.y) ** 2,
					);
					return (
						<motion.line
							key={fx.id}
							x1={from.x}
							y1={from.y}
							x2={to.x}
							y2={to.y}
							stroke={EFFECT_COLORS["attack-tracer"]}
							strokeWidth={1}
							strokeDasharray={lineLength}
							strokeOpacity={0.6}
							initial={{ strokeDashoffset: lineLength, opacity: 0 }}
							animate={{ strokeDashoffset: 0, opacity: 0.6 }}
							exit={{ opacity: 0, transition: { duration: 0.15 } }}
							transition={{ duration: 0.2, ease: "easeOut" }}
							style={{ pointerEvents: "none" }}
						/>
					);
				}

				const { x, y } = hexIdToPixel(fx.hexId, hexRadius);
				const points = hexPoints(x, y, hexRadius);
				const color = EFFECT_COLORS[fx.type];

				return (
					<motion.polygon
						key={fx.id}
						points={points}
						fill={color}
						stroke={color}
						strokeWidth={1.5}
						initial={{ opacity: 0 }}
						animate={{ opacity: 1 }}
						exit={{ opacity: 0, transition: { duration: 0.15 } }}
						transition={{ duration: 0.1 }}
						style={{ pointerEvents: "none" }}
					/>
				);
			})}
		</AnimatePresence>
	);
});
