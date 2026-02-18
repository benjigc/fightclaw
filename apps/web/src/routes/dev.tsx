import {
	applyMove,
	createInitialState,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useMemo, useState } from "react";

import { HexBoard } from "@/components/arena/hex-board";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	type EngineEventsEnvelopeV1,
	useArenaAnimator,
} from "@/lib/arena-animator";

export const Route = createFileRoute("/dev")({
	component: DevConsole,
});

function DevConsole() {
	if (!import.meta.env.DEV) {
		return (
			<div className="container mx-auto max-w-3xl px-4 py-6">
				<h1 className="font-semibold text-lg">Dev tools disabled</h1>
				<p className="text-muted-foreground text-sm">
					This route is only available in dev.
				</p>
			</div>
		);
	}

	return (
		<div className="mx-auto w-full max-w-[1700px] px-4 py-4 md:px-6 md:py-6">
			<header className="mb-4 rounded-xl border border-border/70 bg-card/70 p-4 backdrop-blur">
				<p className="text-[11px] text-muted-foreground uppercase tracking-[0.2em]">
					Spectate Sandbox
				</p>
				<h1 className="mt-1 font-semibold text-2xl">Live Spectate Preview</h1>
				<p className="text-muted-foreground text-sm">
					Board-first layout for testing spectator readability, scale, and HUD
					density.
				</p>
			</header>
			<BoardPreview />
		</div>
	);
}

function BoardPreview() {
	const [seed, setSeed] = useState(42);
	const createPreviewState = useCallback(
		(s: number) =>
			createInitialState(s, { boardColumns: 17 }, ["dev-a", "dev-b"]),
		[],
	);
	const [boardState, setBoardState] = useState<MatchState>(() =>
		createPreviewState(seed),
	);
	const [moveCount, setMoveCount] = useState(0);

	const {
		effects,
		unitAnimStates,
		dyingUnitIds,
		hudFx,
		enqueue,
		reset: resetAnimator,
	} = useArenaAnimator({
		onApplyBaseState: (state) => setBoardState(state),
	});

	const resetBoard = useCallback(
		(s: number) => {
			resetAnimator();
			setBoardState(createPreviewState(s));
			setMoveCount(0);
		},
		[createPreviewState, resetAnimator],
	);

	const legalMoves = useMemo(() => listLegalMoves(boardState), [boardState]);

	const playRandomMove = useCallback(() => {
		if (boardState.status !== "active" || legalMoves.length === 0) return;
		const move = legalMoves[
			Math.floor(Math.random() * legalMoves.length)
		] as Move;
		const result = applyMove(boardState, move);
		if (!result.ok) return;

		const envelope: EngineEventsEnvelopeV1 = {
			eventVersion: 1,
			event: "engine_events",
			matchId: "dev-preview",
			stateVersion: moveCount + 1,
			agentId: "dev",
			moveId: `dev-${moveCount + 1}`,
			move,
			engineEvents: result.engineEvents,
			ts: new Date().toISOString(),
		};
		enqueue(envelope, { postState: result.state });
		setMoveCount((n) => n + 1);
	}, [boardState, legalMoves, moveCount, enqueue]);

	const playBurst = useCallback(
		(count: number) => {
			let state = boardState;
			let mc = moveCount;
			for (let i = 0; i < count; i++) {
				if (state.status !== "active") break;
				const moves = listLegalMoves(state);
				if (moves.length === 0) break;
				const move = moves[Math.floor(Math.random() * moves.length)] as Move;
				const result = applyMove(state, move);
				if (!result.ok) break;
				state = result.state;
				mc += 1;

				const envelope: EngineEventsEnvelopeV1 = {
					eventVersion: 1,
					event: "engine_events",
					matchId: "dev-preview",
					stateVersion: mc,
					agentId: "dev",
					moveId: `dev-${mc}`,
					move,
					engineEvents: result.engineEvents,
					ts: new Date().toISOString(),
				};
				enqueue(envelope, { postState: state });
			}
			setMoveCount(mc);
		},
		[boardState, moveCount, enqueue],
	);

	return (
		<section className="mx-auto grid w-full max-w-[1500px] gap-3 rounded-xl border border-border/70 bg-card/70 p-4">
			<div className="flex flex-wrap items-start justify-between gap-3">
				<div>
					<p className="text-[11px] text-muted-foreground uppercase tracking-[0.18em]">
						Arena View
					</p>
					<h2 className="font-semibold text-lg">Board: 17x9</h2>
					<p className="text-muted-foreground text-xs">
						Turn {boardState.turn} | Active {boardState.activePlayer} | AP{" "}
						{boardState.actionsRemaining} | Moves {moveCount} |{" "}
						{boardState.status}
						{hudFx.passPulse ? " | PASS" : ""}
					</p>
				</div>
				<div className="grid gap-2 sm:grid-cols-[auto_auto_auto]">
					<div className="grid gap-1">
						<label
							className="text-muted-foreground text-xs"
							htmlFor="board-seed"
						>
							Seed
						</label>
						<Input
							id="board-seed"
							type="number"
							className="h-8 w-24"
							value={seed}
							onChange={(e) => setSeed(Number(e.target.value) || 0)}
						/>
					</div>
					<Button
						type="button"
						variant="secondary"
						size="sm"
						className="self-end"
						onClick={() => resetBoard(seed)}
					>
						Reset
					</Button>
					<div className="flex flex-wrap gap-2 self-end">
						<Button
							type="button"
							size="sm"
							onClick={playRandomMove}
							disabled={boardState.status !== "active"}
						>
							Random
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => playBurst(5)}
							disabled={boardState.status !== "active"}
						>
							+5
						</Button>
						<Button
							type="button"
							variant="secondary"
							size="sm"
							onClick={() => playBurst(20)}
							disabled={boardState.status !== "active"}
						>
							+20
						</Button>
					</div>
				</div>
			</div>
			<div className="dev-spectate-board spectator-landing overflow-auto rounded-xl border border-border/60 p-2 sm:p-3">
				<div className="mx-auto w-fit">
					<HexBoard
						state={boardState}
						effects={effects}
						unitAnimStates={unitAnimStates}
						dyingUnitIds={dyingUnitIds}
					/>
				</div>
			</div>
		</section>
	);
}
