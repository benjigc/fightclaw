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
