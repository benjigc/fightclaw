import {
	applyMove,
	initialState,
	listLegalMoves,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";

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
	const [authToken, setAuthToken] = useState("");
	const [matchId, setMatchId] = useState<string | null>(null);
	const [stateVersion, setStateVersion] = useState(0);
	const [response, setResponse] = useState<unknown>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		const stored = window.localStorage.getItem("fightclaw.devAgentKey");
		if (stored) setAuthToken(stored);
	}, []);

	useEffect(() => {
		if (!authToken) return;
		window.localStorage.setItem("fightclaw.devAgentKey", authToken);
	}, [authToken]);

	const queueMatch = async () => {
		setBusy(true);
		try {
			const res = await fetch(`${env.VITE_SERVER_URL}/v1/matches/queue`, {
				method: "POST",
			});
			const json = (await res.json()) as { matchId?: string };
			if (json.matchId) {
				setMatchId(json.matchId);
				setStateVersion(0);
			}
			setResponse(json);
		} catch (error) {
			setResponse({ error: (error as Error).message ?? "Queue failed." });
		} finally {
			setBusy(false);
		}
	};

	const submitDummyMove = async () => {
		if (!matchId) {
			setResponse({ error: "Queue a match first." });
			return;
		}
		if (!authToken) {
			setResponse({ error: "Set DEV agent key first." });
			return;
		}
		setBusy(true);
		try {
			const res = await fetch(
				`${env.VITE_SERVER_URL}/v1/matches/${matchId}/move`,
				{
					method: "POST",
					headers: {
						authorization: `Bearer ${authToken}`,
						"content-type": "application/json",
					},
					body: JSON.stringify({
						moveId: crypto.randomUUID(),
						expectedVersion: stateVersion,
						move: { action: "ping", at: new Date().toISOString() },
					}),
				},
			);
			const json = (await res.json()) as {
				ok?: boolean;
				state?: { stateVersion?: number };
				stateVersion?: number;
			};
			if (json.ok && json.state?.stateVersion !== undefined) {
				setStateVersion(json.state.stateVersion);
			}
			if (!json.ok && json.stateVersion !== undefined) {
				setStateVersion(json.stateVersion);
			}
			setResponse(json);
		} catch (error) {
			setResponse({ error: (error as Error).message ?? "Move failed." });
		} finally {
			setBusy(false);
		}
	};

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
		<div className="container mx-auto max-w-3xl px-4 py-6">
			<h1 className="font-semibold text-lg">Dev Console</h1>
			<p className="text-muted-foreground text-sm">
				Operator controls for internal testing.
			</p>
			<section className="mt-6 grid gap-4 rounded-lg border p-4">
				<div className="grid gap-2">
					<label className="font-medium text-sm" htmlFor="dev-agent-key">
						DEV Agent Key
					</label>
					<Input
						id="dev-agent-key"
						placeholder="Paste DEV_AGENT_KEY"
						value={authToken}
						onChange={(event) => setAuthToken(event.target.value)}
					/>
				</div>
				<div className="flex flex-wrap gap-2">
					<Button type="button" onClick={queueMatch} disabled={busy}>
						Queue Match
					</Button>
					<Button
						type="button"
						variant="secondary"
						onClick={submitDummyMove}
						disabled={busy}
					>
						Submit Dummy Move
					</Button>
				</div>
				<div className="text-muted-foreground text-xs">
					Match: {matchId ?? "-"} · stateVersion: {stateVersion}
				</div>
				<pre className="max-h-72 overflow-auto rounded-md bg-muted p-3 text-xs">
					{response ? JSON.stringify(response, null, 2) : "No response yet."}
				</pre>
			</section>
			<BoardPreview />
		</div>
	);
}

function BoardPreview() {
	const [seed, setSeed] = useState(42);
	const [boardState, setBoardState] = useState<MatchState>(() =>
		initialState(seed, ["dev-a", "dev-b"]),
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
			setBoardState(initialState(s, ["dev-a", "dev-b"]));
			setMoveCount(0);
		},
		[resetAnimator],
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
		<section className="mt-6 grid gap-4 rounded-lg border p-4">
			<h2 className="font-medium text-sm">Board Preview</h2>
			<div className="flex flex-wrap items-end gap-2">
				<div className="grid gap-1">
					<label className="text-muted-foreground text-xs" htmlFor="board-seed">
						Seed
					</label>
					<Input
						id="board-seed"
						type="number"
						className="w-24"
						value={seed}
						onChange={(e) => setSeed(Number(e.target.value) || 0)}
					/>
				</div>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => resetBoard(seed)}
				>
					Reset
				</Button>
				<Button
					type="button"
					size="sm"
					onClick={playRandomMove}
					disabled={boardState.status !== "active"}
				>
					Random Move
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => playBurst(5)}
					disabled={boardState.status !== "active"}
				>
					+5 Moves
				</Button>
				<Button
					type="button"
					variant="secondary"
					size="sm"
					onClick={() => playBurst(20)}
					disabled={boardState.status !== "active"}
				>
					+20 Moves
				</Button>
			</div>
			<div className="text-muted-foreground text-xs">
				Turn: {boardState.turn} | Active: {boardState.activePlayer} | AP:{" "}
				{boardState.actionsRemaining} | Moves played: {moveCount} | Status:{" "}
				{boardState.status}
				{hudFx.passPulse ? " | PASS" : ""}
			</div>
			<div className="spectator-landing rounded-md" style={{ minHeight: 200 }}>
				<HexBoard
					state={boardState}
					effects={effects}
					unitAnimStates={unitAnimStates}
					dyingUnitIds={dyingUnitIds}
				/>
			</div>
		</section>
	);
}
