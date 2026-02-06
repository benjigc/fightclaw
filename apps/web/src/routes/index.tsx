import {
	applyMove,
	type EngineEvent,
	initialState,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { AsciiBoard } from "@/components/ascii-board";
import { renderBoardGridWithWarnings } from "@/lib/hex-conquest";
import {
	type EngineEventsEnvelopeV1,
	useSpectatorAnimator,
} from "@/lib/spectator-animations";

export const Route = createFileRoute("/")({
	component: SpectatorLanding,
	validateSearch: (search: Record<string, unknown>) => ({
		replayMatchId:
			typeof search.replayMatchId === "string"
				? search.replayMatchId
				: undefined,
	}),
});

type FeaturedResponse = {
	matchId: string | null;
	status: string | null;
	players: string[] | null;
};

type StateEvent = {
	eventVersion: 1;
	event: "state";
	matchId: string | null;
	state: MatchState;
};

type GameEndedEvent = {
	eventVersion: 1;
	event: "game_ended";
	matchId: string | null;
	winnerAgentId?: string | null;
	loserAgentId?: string | null;
	reason?: string;
	reasonCode?: string;
};

type LogEntry = {
	id: number;
	text: string;
};

function SpectatorLanding() {
	const search = Route.useSearch();
	const replayMatchId = search.replayMatchId ?? null;

	const [featured, setFeatured] = useState<FeaturedResponse | null>(null);
	const [latestState, setLatestState] = useState<MatchState | null>(null);
	const [latestAscii, setLatestAscii] = useState<string | null>(null);
	const [eventLog, setEventLog] = useState<LogEntry[]>([]);
	const [connectionStatus, setConnectionStatus] = useState<
		"idle" | "connecting" | "live" | "replay" | "error"
	>("idle");
	const warningCache = useRef<Set<string>>(new Set());
	const logSeq = useRef(0);
	const replayFollowStarted = useRef(false);
	const [replayShouldFollowLive, setReplayShouldFollowLive] = useState(false);

	const matchId = replayMatchId ?? featured?.matchId ?? null;

	const {
		cellFx,
		hudFx,
		isAnimating,
		enqueue: enqueueEngineEvents,
		reset: resetAnimator,
		setIdleFocus,
	} = useSpectatorAnimator({
		onApplyBaseState: (state) => setLatestState(state),
	});

	useEffect(() => {
		if (replayMatchId) return;
		let active = true;

		const fetchFeatured = async () => {
			try {
				const res = await fetch(`${env.VITE_SERVER_URL}/v1/featured`);
				if (!res.ok) {
					throw new Error(`Featured request failed (${res.status})`);
				}
				const json = (await res.json()) as FeaturedResponse;
				if (!active) return;
				setFeatured(json);
			} catch (error) {
				if (!active) return;
				setFeatured({ matchId: null, status: null, players: null });
				setEventLog((prev) =>
					[
						...prev,
						{
							id: ++logSeq.current,
							text: `Featured unavailable: ${(error as Error).message}`,
						},
					].slice(-12),
				);
			}
		};

		void fetchFeatured();
		const interval = window.setInterval(fetchFeatured, 15000);

		return () => {
			active = false;
			window.clearInterval(interval);
		};
	}, [replayMatchId]);

	useEffect(() => {
		if (replayMatchId) return;

		if (!matchId) {
			resetAnimator();
			setLatestState(null);
			setLatestAscii(null);
			setEventLog([]);
			setConnectionStatus("idle");
			warningCache.current.clear();
			return;
		}

		let active = true;
		resetAnimator();
		const hasBaseState = { current: false };
		setLatestState(null);
		setLatestAscii(null);
		setEventLog([]);
		setConnectionStatus("connecting");
		warningCache.current.clear();

		const fetchState = async () => {
			try {
				const res = await fetch(
					`${env.VITE_SERVER_URL}/v1/matches/${matchId}/state`,
				);
				if (!res.ok) {
					throw new Error(`State request failed (${res.status})`);
				}
				const json = (await res.json()) as { state?: unknown } | null;
				const { state, ascii } = parseStateEnvelope(json);
				if (!active) return;
				if (state) {
					setLatestState(state);
					if (!hasBaseState.current) {
						hasBaseState.current = true;
						setIdleFocus(strongholdForSide(state.activePlayer));
					}
				}
				setLatestAscii(ascii);
			} catch (error) {
				if (!active) return;
				setEventLog((prev) =>
					[
						...prev,
						{
							id: ++logSeq.current,
							text: `State unavailable: ${(error as Error).message}`,
						},
					].slice(-12),
				);
			}
		};

		void fetchState();

		const eventSource = new EventSource(
			`${env.VITE_SERVER_URL}/v1/matches/${matchId}/events`,
		);

		const handleStateEvent = (event: MessageEvent<string>) => {
			let payload: StateEvent | null = null;
			try {
				payload = JSON.parse(event.data) as StateEvent;
			} catch {
				if (!active) return;
				setEventLog((prev) =>
					[
						...prev,
						{ id: ++logSeq.current, text: "Malformed state payload" },
					].slice(-12),
				);
				return;
			}
			if (!payload || payload.eventVersion !== 1 || payload.event !== "state")
				return;
			if (!active) return;
			const { state, ascii } = parseStateEnvelope(payload);
			if (!state) return;
			setLatestState(state);
			setLatestAscii(ascii);
			setConnectionStatus("live");
			if (!hasBaseState.current) {
				hasBaseState.current = true;
				setIdleFocus(strongholdForSide(state.activePlayer));
			}
			setEventLog((prev) =>
				[
					...prev,
					{ id: ++logSeq.current, text: buildStateLogLine(state) },
				].slice(-12),
			);
		};

		const handleGameEnded = (event: MessageEvent<string>) => {
			let payload: GameEndedEvent | null = null;
			try {
				payload = JSON.parse(event.data) as GameEndedEvent;
			} catch {
				if (!active) return;
				setEventLog((prev) =>
					[
						...prev,
						{ id: ++logSeq.current, text: "Malformed game_ended payload" },
					].slice(-12),
				);
				return;
			}
			if (
				!payload ||
				payload.eventVersion !== 1 ||
				payload.event !== "game_ended"
			)
				return;
			if (!active) return;
			const winner = payload.winnerAgentId
				? ` Winner: ${payload.winnerAgentId}.`
				: "";
			const reason = payload.reason ?? payload.reasonCode ?? "game ended";
			setEventLog((prev) =>
				[
					...prev,
					{
						id: ++logSeq.current,
						text: `Game ended: ${reason}.${winner}`,
					},
				].slice(-12),
			);
		};

		const handleEngineEvents = (event: MessageEvent<string>) => {
			let payload: EngineEventsEnvelopeV1 | null = null;
			try {
				payload = JSON.parse(event.data) as EngineEventsEnvelopeV1;
			} catch {
				if (!active) return;
				setEventLog((prev) =>
					[
						...prev,
						{ id: ++logSeq.current, text: "Malformed engine_events payload" },
					].slice(-12),
				);
				return;
			}

			if (
				!payload ||
				payload.eventVersion !== 1 ||
				payload.event !== "engine_events"
			) {
				return;
			}
			if (!active) return;
			enqueueEngineEvents(payload);
		};

		eventSource.addEventListener("state", handleStateEvent as EventListener);
		eventSource.addEventListener(
			"engine_events",
			handleEngineEvents as EventListener,
		);
		eventSource.addEventListener(
			"game_ended",
			handleGameEnded as EventListener,
		);
		eventSource.addEventListener("error", () => {
			if (!active) return;
			setConnectionStatus("error");
			setEventLog((prev) =>
				[...prev, { id: ++logSeq.current, text: "Stream error" }].slice(-12),
			);
		});

		return () => {
			active = false;
			eventSource.close();
		};
	}, [
		enqueueEngineEvents,
		matchId,
		replayMatchId,
		resetAnimator,
		setIdleFocus,
	]);

	useEffect(() => {
		if (!replayMatchId) {
			replayFollowStarted.current = false;
			setReplayShouldFollowLive(false);
			return;
		}

		let active = true;
		replayFollowStarted.current = false;
		setReplayShouldFollowLive(false);
		resetAnimator();
		setFeatured({ matchId: replayMatchId, status: "replay", players: null });
		setLatestState(null);
		setLatestAscii(null);
		setEventLog([]);
		setConnectionStatus("connecting");
		warningCache.current.clear();

		const runReplay = async () => {
			try {
				const res = await fetch(
					`${env.VITE_SERVER_URL}/v1/matches/${replayMatchId}/log?limit=5000`,
				);
				if (!res.ok) {
					throw new Error(`Log request failed (${res.status})`);
				}

				const json = (await res.json()) as MatchLogResponseV1;
				if (!active) return;

				const started = json.events.find(
					(event) => event.eventType === "match_started",
				);
				const startedPayload = isRecord(started?.payload)
					? started.payload
					: null;
				const seedRaw = startedPayload?.seed;
				const playersRaw = startedPayload?.players;

				const seed =
					typeof seedRaw === "number" && Number.isFinite(seedRaw)
						? seedRaw
						: null;
				const players = Array.isArray(playersRaw)
					? playersRaw.filter((value) => typeof value === "string")
					: null;

				if (seed === null || !players || players.length !== 2) {
					throw new Error("Replay missing match_started metadata.");
				}

				setFeatured({
					matchId: replayMatchId,
					status: "replay",
					players,
				});

				let state = initialState(seed, players);
				setLatestState(state);
				setIdleFocus(strongholdForSide(state.activePlayer));
				setConnectionStatus("replay");

				const moveRows = json.events
					.filter((event) => event.eventType === "move_applied")
					.sort((a, b) => a.id - b.id);

				let replayed = 0;

				for (const row of moveRows) {
					if (!active) return;
					const payload = isRecord(row.payload) ? row.payload : null;
					const moveRaw = payload?.move;
					if (!moveRaw || typeof moveRaw !== "object") continue;

					const move = moveRaw as Move;
					const result = applyMove(state, move);
					if (!result.ok) {
						throw new Error(
							`Replay engine rejected move at row ${row.id}: ${result.error}`,
						);
					}
					state = result.state;

					const engineEventsRaw = payload?.engineEvents;
					const engineEvents = Array.isArray(engineEventsRaw)
						? (engineEventsRaw as EngineEvent[])
						: result.engineEvents;

					const agentId =
						typeof payload?.agentId === "string" ? payload.agentId : "unknown";
					const moveId =
						typeof payload?.moveId === "string"
							? payload.moveId
							: `replay:${row.id}`;
					const stateVersion =
						typeof payload?.stateVersion === "number" &&
						Number.isFinite(payload.stateVersion)
							? payload.stateVersion
							: replayed + 1;

					const envelope: EngineEventsEnvelopeV1 = {
						eventVersion: 1,
						event: "engine_events",
						matchId: replayMatchId,
						stateVersion,
						agentId,
						moveId,
						move,
						engineEvents,
						ts: typeof row.ts === "string" ? row.ts : new Date().toISOString(),
					};

					enqueueEngineEvents(envelope, { postState: state });
					replayed += 1;
				}

				setEventLog((prev) =>
					[
						...prev,
						{
							id: ++logSeq.current,
							text: `Replay loaded: ${replayed} moves.`,
						},
					].slice(-12),
				);

				if (state.status === "active") {
					setReplayShouldFollowLive(true);
					setEventLog((prev) =>
						[
							...prev,
							{
								id: ++logSeq.current,
								text: "Replay reached live match; will follow stream after catch-up.",
							},
						].slice(-12),
					);
				}
			} catch (error) {
				if (!active) return;
				setConnectionStatus("error");
				setEventLog((prev) =>
					[
						...prev,
						{
							id: ++logSeq.current,
							text: `Replay failed: ${(error as Error).message}`,
						},
					].slice(-12),
				);
			}
		};

		void runReplay();

		return () => {
			active = false;
		};
	}, [enqueueEngineEvents, replayMatchId, resetAnimator, setIdleFocus]);

	useEffect(() => {
		if (!replayMatchId) return;
		if (!replayShouldFollowLive) return;
		if (isAnimating) return;
		if (replayFollowStarted.current) return;

		replayFollowStarted.current = true;
		let active = true;

		const eventSource = new EventSource(
			`${env.VITE_SERVER_URL}/v1/matches/${replayMatchId}/events`,
		);

		const handleStateEvent = (event: MessageEvent<string>) => {
			let payload: StateEvent | null = null;
			try {
				payload = JSON.parse(event.data) as StateEvent;
			} catch {
				return;
			}
			if (!payload || payload.eventVersion !== 1 || payload.event !== "state")
				return;
			if (!active) return;
			const { state, ascii } = parseStateEnvelope(payload);
			if (!state) return;
			setLatestState(state);
			setLatestAscii(ascii);
			setConnectionStatus("live");
		};

		const handleEngineEvents = (event: MessageEvent<string>) => {
			let payload: EngineEventsEnvelopeV1 | null = null;
			try {
				payload = JSON.parse(event.data) as EngineEventsEnvelopeV1;
			} catch {
				return;
			}
			if (
				!payload ||
				payload.eventVersion !== 1 ||
				payload.event !== "engine_events"
			) {
				return;
			}
			if (!active) return;
			enqueueEngineEvents(payload);
		};

		eventSource.addEventListener("state", handleStateEvent as EventListener);
		eventSource.addEventListener(
			"engine_events",
			handleEngineEvents as EventListener,
		);

		return () => {
			active = false;
			eventSource.close();
		};
	}, [enqueueEngineEvents, isAnimating, replayMatchId, replayShouldFollowLive]);

	const boardGridResult = useMemo(() => {
		if (!latestState) return null;
		return renderBoardGridWithWarnings(latestState);
	}, [latestState]);

	useEffect(() => {
		if (!boardGridResult?.warnings?.length) return;
		const newWarnings = boardGridResult.warnings.filter(
			(warning) => !warningCache.current.has(warning),
		);
		if (newWarnings.length === 0) return;
		newWarnings.forEach((warning) => {
			warningCache.current.add(warning);
		});
		setEventLog((prev) =>
			[
				...prev,
				...newWarnings.map((warning) => ({
					id: ++logSeq.current,
					text: `WARN: ${warning}`,
				})),
			].slice(-12),
		);
	}, [boardGridResult]);

	const statusLabel = featured?.status ?? "waiting";
	const playersLabel = featured?.players?.length
		? `A: ${featured.players[0] ?? "A"}  B: ${featured.players[1] ?? "B"}`
		: null;

	const controlCounts = useMemo(() => {
		if (!latestState) return null;
		const board = (latestState as { board?: unknown }).board;
		const hexes = Array.isArray(board)
			? board
			: board && typeof board === "object"
				? Object.values(board as Record<string, unknown>)
				: [];
		let a = 0;
		let b = 0;
		for (const hex of hexes) {
			if (!hex || typeof hex !== "object") continue;
			const controlledBy = (hex as { controlledBy?: unknown }).controlledBy;
			if (controlledBy === "A") a += 1;
			if (controlledBy === "B") b += 1;
		}
		return { A: a, B: b };
	}, [latestState]);

	const resourceSummary = latestState
		? {
				A: latestState.players.A,
				B: latestState.players.B,
				counts: {
					A: controlCounts?.A ?? 0,
					B: controlCounts?.B ?? 0,
				},
			}
		: null;

	return (
		<div className="spectator-landing">
			<div className="spectator-frame">
				<header className="spectator-header">
					<div>
						<div className="spectator-title">
							WAR OF ATTRITION {"//"} LIVE FEED
						</div>
						<div className="spectator-subtitle">
							Spectator console - read only
						</div>
					</div>
					<div className="spectator-status">
						<div>Match: {matchId ?? "waiting"}</div>
						<div>Status: {statusLabel ?? "waiting"}</div>
						<div>Stream: {connectionStatus}</div>
					</div>
				</header>

				{playersLabel ? (
					<div className="spectator-players">{playersLabel}</div>
				) : null}

				<section className="spectator-grid">
					<div className="spectator-panel hud">
						<div className="panel-title">SYSTEM HUD</div>
						{latestState ? (
							<div className="panel-body">
								<div
									className={
										hudFx.passPulse ? "hud-line hud-pass-pulse" : "hud-line"
									}
								>
									Turn: {latestState.turn} | Active: {latestState.activePlayer}{" "}
									| AP: {latestState.actionsRemaining}
								</div>
								{resourceSummary ? (
									<div className="panel-split">
										<div>
											A Gold: {resourceSummary.A.gold} | Wood:{" "}
											{resourceSummary.A.wood} | VP: {resourceSummary.A.vp}
										</div>
										<div>
											B Gold: {resourceSummary.B.gold} | Wood:{" "}
											{resourceSummary.B.wood} | VP: {resourceSummary.B.vp}
										</div>
									</div>
								) : null}
								{resourceSummary ? (
									<div>
										Controlled: A {resourceSummary.counts.A} / B{" "}
										{resourceSummary.counts.B}
									</div>
								) : null}
							</div>
						) : (
							<div className="panel-body muted">Awaiting state stream...</div>
						)}
					</div>

					<div className="spectator-panel board">
						<div className="panel-title">ARENA MAP</div>
						<div className="panel-body">
							{boardGridResult &&
							!boardGridResult.errorText &&
							boardGridResult.grid.length ? (
								<div className="ascii-board-shell">
									<AsciiBoard
										header={boardGridResult.header}
										grid={boardGridResult.grid}
										cellFx={cellFx}
									/>
								</div>
							) : boardGridResult?.errorText ? (
								<div className="muted">{boardGridResult.errorText}</div>
							) : latestAscii && latestAscii.trim().length > 0 ? (
								<div className="ascii-board-shell">
									<pre className="ascii-board">{latestAscii}</pre>
								</div>
							) : (
								<div className="muted">No board data yet.</div>
							)}
							<div className="legend">
								i/c/a = units | S=stronghold G=gold L=lumber C=crown
								H=high_ground F=forest h=hills D=deploy .=plains | A/B/. =
								control
							</div>
						</div>
					</div>

					<div className="spectator-panel log">
						<div className="panel-title">SYSTEM LOG</div>
						<div className="panel-body log-body">
							{eventLog.length ? (
								eventLog.map((entry) => (
									<div key={entry.id} className="log-line">
										{entry.text}
									</div>
								))
							) : (
								<div className="muted">No events yet.</div>
							)}
						</div>
					</div>
				</section>
			</div>
		</div>
	);
}

type MatchLogRowV1 = {
	id: number;
	ts: string;
	eventType: string;
	payload: unknown | null;
	payloadParseError?: true;
};

type MatchLogResponseV1 = {
	matchId: string;
	events: MatchLogRowV1[];
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strongholdForSide(side: "A" | "B"): string {
	return side === "A" ? "B2" : "B20";
}

function buildStateLogLine(state: MatchState) {
	const a = state.players.A;
	const b = state.players.B;
	return `T${state.turn} ${state.activePlayer} AP ${state.actionsRemaining} | Gold A/B ${a.gold}/${b.gold} | Wood A/B ${a.wood}/${b.wood} | VP A/B ${a.vp}/${b.vp}`;
}

function parseStateEnvelope(input: unknown): {
	state: MatchState | null;
	ascii: string | null;
} {
	if (!input || typeof input !== "object") {
		return { state: null, ascii: null };
	}

	const container =
		"state" in input ? ((input as { state?: unknown }).state ?? null) : input;
	if (!container || typeof container !== "object") {
		return { state: null, ascii: null };
	}

	const ascii =
		pickAscii(container) ??
		pickAscii((container as { game?: unknown }).game ?? null) ??
		pickAscii(input);

	const candidate =
		(container as { game?: unknown }).game ??
		(container as { state?: unknown }).state ??
		container;
	if (candidate && typeof candidate === "object" && "players" in candidate) {
		return { state: candidate as MatchState, ascii: ascii ?? null };
	}

	return { state: null, ascii: ascii ?? null };
}

function pickAscii(target: unknown): string | null {
	if (!target || typeof target !== "object") return null;
	const record = target as Record<string, unknown>;
	if (typeof record.ascii === "string") return record.ascii;
	if (typeof record.asciiBoard === "string") return record.asciiBoard;
	if (typeof record.boardAscii === "string") return record.boardAscii;
	return null;
}
