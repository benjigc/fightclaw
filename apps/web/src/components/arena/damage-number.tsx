import { motion } from "framer-motion";
import { memo } from "react";

export type DamageNumberProps = {
	id: string;
	x: number;
	y: number;
	value: number;
};

export const DamageNumber = memo(function DamageNumber({
	x,
	y,
	value,
}: DamageNumberProps) {
	return (
		<motion.text
			x={x}
			initial={{ y, opacity: 1 }}
			animate={{ y: y - 20, opacity: 0 }}
			exit={{ opacity: 0 }}
			transition={{ duration: 0.6, ease: "easeOut" }}
			textAnchor="middle"
			fontFamily="monospace"
			fontSize={8}
			fill="#ef4444"
			fontWeight="bold"
			style={{ pointerEvents: "none" }}
		>
			-{value}
		</motion.text>
	);
});
