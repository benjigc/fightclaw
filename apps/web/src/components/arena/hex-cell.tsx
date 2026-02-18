import type { HexType, PlayerSide } from "@fightclaw/engine";
import { memo } from "react";
import {
	ELEVATION_STYLE,
	PLAYER_COLORS,
	TERRAIN_ACCENT,
	TERRAIN_ASCII,
	TERRAIN_ELEVATION,
} from "@/lib/arena-theme";
import { hexPoints, STACK_OFFSET_Y } from "@/lib/hex-geo";

export type HexCellProps = {
	hexId: string;
	cx: number;
	cy: number;
	radius: number;
	terrain: HexType;
	controlledBy: PlayerSide | null;
	hasUnit: boolean;
};

export const HexCell = memo(function HexCell({
	cx,
	cy,
	radius,
	terrain,
	controlledBy,
	hasUnit,
}: HexCellProps) {
	const tier = TERRAIN_ELEVATION[terrain];
	const style = ELEVATION_STYLE[tier];
	const terrainAscii = TERRAIN_ASCII[terrain];
	const accent = TERRAIN_ACCENT[terrain];
	const ownerColor =
		controlledBy !== null ? PLAYER_COLORS[controlledBy] : undefined;

	const isForest = tier === "forest";

	// Build stack layers (rendered first = underneath)
	const stackLayers: React.ReactNode[] = [];
	for (let i = style.stackLayers; i >= 1; i--) {
		const offsetY = i * STACK_OFFSET_Y;
		stackLayers.push(
			<polygon
				key={`stack-${i}`}
				points={hexPoints(cx, cy + offsetY, radius)}
				fill={style.stackFill}
				stroke={style.stackStroke}
				strokeWidth={0.6}
				strokeOpacity={0.5}
			/>,
		);
	}

	// Top face points
	const topPoints = hexPoints(cx, cy, radius);

	// Terrain ASCII art color: use the elevation tier's stroke color
	const terrainColor = style.stroke;
	const fontSize = radius * 0.3;

	return (
		<g>
			{/* Forest pattern definition */}
			{isForest && (
				<defs>
					<pattern
						id="forest-pattern"
						width="4"
						height="6"
						patternUnits="userSpaceOnUse"
					>
						<line
							x1="2"
							y1="0"
							x2="2"
							y2="4"
							stroke="#1a3a1a"
							strokeWidth="0.5"
							strokeOpacity="0.4"
						/>
					</pattern>
				</defs>
			)}

			{/* Stack layers (beneath top face) */}
			{stackLayers}

			{/* Top face */}
			<polygon
				points={topPoints}
				fill={ownerColor ? ownerColor.glow : style.fill}
				fillOpacity={ownerColor ? 0.2 : 1}
				stroke={ownerColor ? ownerColor.stroke : style.stroke}
				strokeWidth={controlledBy ? 1.6 : 0.6}
				strokeOpacity={controlledBy ? 0.9 : 0.5}
				strokeDasharray={controlledBy ? undefined : "4 3"}
			/>

			{/* Terrain accent overlay */}
			{accent && (
				<polygon
					points={topPoints}
					fill={accent}
					fillOpacity={0.3}
					stroke="none"
					style={{ pointerEvents: "none" }}
				/>
			)}

			{/* Forest texture overlay */}
			{isForest && (
				<polygon
					points={topPoints}
					fill="url(#forest-pattern)"
					stroke="none"
					style={{ pointerEvents: "none" }}
				/>
			)}

			{/* Terrain ASCII art */}
			{terrainAscii ? (
				<g style={{ pointerEvents: "none" }}>
					{terrainAscii.map((line, i) => {
						const lineHeight = fontSize * 1.2;
						const startY = -((terrainAscii.length - 1) * lineHeight) / 2;
						return (
							<text
								key={line}
								x={cx}
								y={cy + startY + i * lineHeight}
								textAnchor="middle"
								dominantBaseline="central"
								fontFamily="monospace"
								fontSize={fontSize}
								fill={terrainColor}
								fillOpacity={hasUnit ? 0.15 : 0.5}
							>
								{line}
							</text>
						);
					})}
				</g>
			) : null}
		</g>
	);
});
