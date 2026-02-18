import type { MatchState, Unit } from "@fightclaw/engine";
import { AnimatePresence } from "framer-motion";
import { memo, useMemo, useRef } from "react";
import type { ArenaEffect, DamageNumberEntry } from "@/lib/arena-animator";
import {
	boardViewBox,
	HEX_RADIUS,
	hexIdToPixel,
	parseHexId,
} from "@/lib/hex-geo";
import { ArenaEffects } from "./arena-effects";
import { DamageNumber } from "./damage-number";
import { HexCell } from "./hex-cell";
import type { UnitAnimState } from "./unit-token";
import { UnitToken } from "./unit-token";

export type HexBoardProps = {
	state: MatchState;
	effects: ArenaEffect[];
	unitAnimStates: Map<string, UnitAnimState>;
	dyingUnitIds: Set<string>;
	damageNumbers: DamageNumberEntry[];
	lungeTargets: Map<string, { x: number; y: number }>;
	activePlayer?: "A" | "B";
};

export const HexBoard = memo(function HexBoard({
	state,
	effects,
	unitAnimStates,
	dyingUnitIds,
	damageNumbers,
	lungeTargets,
	activePlayer,
}: HexBoardProps) {
	const R = HEX_RADIUS;
	// Derive actual board dimensions from state to centre the viewBox correctly
	const boardCols = useMemo(() => {
		let maxCol = 0;
		for (const hex of state.board) {
			const { col } = parseHexId(hex.id);
			if (col > maxCol) maxCol = col;
		}
		return maxCol + 1;
	}, [state.board]);
	const boardRows = useMemo(() => {
		let maxRow = 0;
		for (const hex of state.board) {
			const { row } = parseHexId(hex.id);
			if (row > maxRow) maxRow = row;
		}
		return maxRow + 1;
	}, [state.board]);
	const viewBox = boardViewBox(R, 4, boardCols, boardRows);

	// Keep a ref to the previous state's units so dying units remain visible
	const prevUnitsRef = useRef<Map<string, Unit>>(new Map());

	// Collect all living units from current state
	const livingUnits = useMemo(() => {
		const units: Unit[] = [];
		for (const side of ["A", "B"] as const) {
			for (const unit of Object.values(state.players[side].units)) {
				units.push(unit);
			}
		}
		return units;
	}, [state]);

	// Update prev units map with current living units
	const livingMap = useMemo(() => {
		const map = new Map<string, Unit>();
		for (const u of livingUnits) {
			map.set(u.id, u);
		}
		return map;
	}, [livingUnits]);

	// Build visible units: living + dying (from previous state)
	const visibleUnits = useMemo(() => {
		const result = [...livingUnits];
		for (const id of dyingUnitIds) {
			if (!livingMap.has(id)) {
				const prev = prevUnitsRef.current.get(id);
				if (prev) {
					result.push(prev);
				}
			}
		}
		return result;
	}, [livingUnits, livingMap, dyingUnitIds]);

	// Group visible units by position to render stacks as a single token
	const stacks = useMemo(() => {
		const byPos = new Map<string, Unit[]>();
		for (const u of visibleUnits) {
			const existing = byPos.get(u.position);
			if (existing) {
				existing.push(u);
			} else {
				byPos.set(u.position, [u]);
			}
		}
		return byPos;
	}, [visibleUnits]);

	// After computing visible units, update the prev ref
	prevUnitsRef.current = livingMap;

	return (
		<div className="hex-board-container">
			<svg
				viewBox={viewBox}
				className="hex-board-svg"
				role="img"
				aria-label="Hex arena board"
			>
				<title>Hex Arena Board</title>

				{/* Layer 1: Terrain hexes */}
				{state.board.map((hex) => {
					const pos = hexIdToPixel(hex.id, R);
					return (
						<HexCell
							key={hex.id}
							hexId={hex.id}
							cx={pos.x}
							cy={pos.y}
							radius={R}
							terrain={hex.type}
							controlledBy={hex.controlledBy}
							hasUnit={hex.unitIds.length > 0}
						/>
					);
				})}

				{/* Layer 2: Transient effects */}
				<ArenaEffects effects={effects} hexRadius={R} />

				{/* Layer 3: Units (grouped by position for stacks) */}
				<AnimatePresence>
					{[...stacks.entries()].map(([position, units]) => {
						const lead = units[0] as Unit;
						const pos = hexIdToPixel(position, R);
						const animState = unitAnimStates.get(lead.id) ?? "idle";
						return (
							<UnitToken
								key={lead.id}
								unit={lead}
								x={pos.x}
								y={pos.y}
								radius={R}
								animState={animState}
								stackCount={units.length}
								lungeTarget={lungeTargets.get(lead.id)}
								activePlayer={activePlayer}
							/>
						);
					})}
				</AnimatePresence>

				{/* Layer 4: Damage numbers */}
				<AnimatePresence>
					{damageNumbers.map((dn) => {
						const pos = hexIdToPixel(dn.hexId, R);
						return (
							<DamageNumber
								key={dn.id}
								id={dn.id}
								x={pos.x}
								y={pos.y - R * 0.3}
								value={dn.value}
							/>
						);
					})}
				</AnimatePresence>
			</svg>
		</div>
	);
});
