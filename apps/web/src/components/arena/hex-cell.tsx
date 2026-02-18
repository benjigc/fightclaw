import type { HexType, PlayerSide } from "@fightclaw/engine";
import { memo } from "react";
import { PLAYER_COLORS, TERRAIN_FILLS, TERRAIN_ICONS } from "@/lib/arena-theme";
import { hexPoints } from "@/lib/hex-geo";

export type HexCellProps = {
	hexId: string;
	cx: number;
	cy: number;
	radius: number;
	terrain: HexType;
	controlledBy: PlayerSide | null;
};

export const HexCell = memo(function HexCell({
	cx,
	cy,
	radius,
	terrain,
	controlledBy,
}: HexCellProps) {
	const points = hexPoints(cx, cy, radius);
	const fill = TERRAIN_FILLS[terrain];
	const icon = TERRAIN_ICONS[terrain];
	const ownerColor =
		controlledBy !== null ? PLAYER_COLORS[controlledBy] : undefined;

	return (
		<g>
			<polygon
				points={points}
				fill={ownerColor ? ownerColor.glow : fill}
				fillOpacity={ownerColor ? 0.2 : 1}
				stroke={ownerColor?.stroke ?? "#ffffff"}
				strokeWidth={controlledBy ? 1.6 : 0.6}
				strokeOpacity={controlledBy ? 0.9 : 0.5}
				strokeDasharray={controlledBy ? undefined : "4 3"}
			/>
			{icon ? (
				<text
					x={cx}
					y={cy + 1}
					textAnchor="middle"
					dominantBaseline="central"
					fontSize={radius * 0.45}
					fill="#ffffff"
					fillOpacity={0.5}
					style={{ pointerEvents: "none" }}
				>
					{icon}
				</text>
			) : null}
		</g>
	);
});
