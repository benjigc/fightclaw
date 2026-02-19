import type { MatchState } from "@fightclaw/engine";
import type { CSSProperties, ReactNode } from "react";
import { HexBoard, type HexBoardProps } from "./hex-board";
import { ThoughtPanel } from "./thought-panel";

type SpectatorArenaProps = {
	statusBadge: string;
	state: MatchState | null;
	topBarRight?: ReactNode;
	topBarCenterFallback?: string;
	hudPassPulse?: boolean;
} & SpectatorArenaMainProps;

export type SpectatorArenaMainProps = {
	state: MatchState | null;
	thoughtsA: string[];
	thoughtsB: string[];
	isThinkingA: boolean;
	isThinkingB: boolean;
	emptyStateLabel?: string;
	mainStyle?: CSSProperties;
} & Pick<
	HexBoardProps,
	| "effects"
	| "unitAnimStates"
	| "dyingUnitIds"
	| "damageNumbers"
	| "lungeTargets"
>;

export function SpectatorArenaMain({
	state,
	thoughtsA,
	thoughtsB,
	isThinkingA,
	isThinkingB,
	emptyStateLabel = "Awaiting state stream...",
	mainStyle,
	effects,
	unitAnimStates,
	dyingUnitIds,
	damageNumbers,
	lungeTargets,
}: SpectatorArenaMainProps) {
	return (
		<div className="spectator-main" style={mainStyle}>
			<ThoughtPanel player="A" thoughts={thoughtsA} isThinking={isThinkingA} />

			{state ? (
				<HexBoard
					state={state}
					effects={effects}
					unitAnimStates={unitAnimStates}
					dyingUnitIds={dyingUnitIds}
					damageNumbers={damageNumbers}
					lungeTargets={lungeTargets}
					activePlayer={state.activePlayer}
				/>
			) : (
				<div className="spectator-board-empty">
					<div className="muted">{emptyStateLabel}</div>
				</div>
			)}

			<ThoughtPanel player="B" thoughts={thoughtsB} isThinking={isThinkingB} />
		</div>
	);
}

export function SpectatorArena({
	statusBadge,
	state,
	thoughtsA,
	thoughtsB,
	isThinkingA,
	isThinkingB,
	topBarRight,
	topBarCenterFallback = "WAR OF ATTRITION",
	emptyStateLabel = "Awaiting state stream...",
	hudPassPulse = false,
	effects,
	unitAnimStates,
	dyingUnitIds,
	damageNumbers,
	lungeTargets,
}: SpectatorArenaProps) {
	return (
		<div className="spectator-landing">
			<div className="spectator-top-bar">
				<span className="status-badge">{statusBadge}</span>
				<span className="top-bar-center">
					{state ? (
						<>
							T{state.turn}{" "}
							<span
								className={
									state.activePlayer === "A"
										? "player-a-color"
										: "player-b-color"
								}
							>
								{state.activePlayer}
							</span>{" "}
							| AP {state.actionsRemaining}
							{hudPassPulse ? " | PASS" : ""}
						</>
					) : (
						topBarCenterFallback
					)}
				</span>
				{topBarRight}
			</div>

			<SpectatorArenaMain
				state={state}
				thoughtsA={thoughtsA}
				thoughtsB={thoughtsB}
				isThinkingA={isThinkingA}
				isThinkingB={isThinkingB}
				emptyStateLabel={emptyStateLabel}
				effects={effects}
				unitAnimStates={unitAnimStates}
				dyingUnitIds={dyingUnitIds}
				damageNumbers={damageNumbers}
				lungeTargets={lungeTargets}
			/>
		</div>
	);
}
