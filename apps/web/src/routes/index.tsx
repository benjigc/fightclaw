import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { type GameState, renderBoardWithWarnings } from "@/lib/hex-conquest";

export const Route = createFileRoute("/")({
	component: SpectatorLanding,
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
	state: GameState;
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
	const [featured, setFeatured] = useState<FeaturedResponse | null>(null);
	const [latestState, setLatestState] = useState<GameState | null>(null);
	const [latestAscii, setLatestAscii] = useState<string | null>(null);
	const [eventLog, setEventLog] = useState<LogEntry[]>([]);
	const [connectionStatus, setConnectionStatus] = useState<
		"idle" | "connecting" | "live" | "error"
	>("idle");
	const warningCache = useRef<Set<string>>(new Set());
	const logSeq = useRef(0);

	const matchId = featured?.matchId ?? null;

	useEffect(() => {
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
	}, []);

	useEffect(() => {
		if (!matchId) {
			setLatestState(null);
			setLatestAscii(null);
			setEventLog([]);
			setConnectionStatus("idle");
			warningCache.current.clear();
			return;
		}

		let active = true;
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

		eventSource.addEventListener("state", handleStateEvent as EventListener);
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
	}, [matchId]);

	const boardResult = useMemo(() => {
		if (latestAscii && latestAscii.trim().length > 0) {
			return { text: latestAscii, warnings: [] };
		}
		if (!latestState) return null;
		return renderBoardWithWarnings(latestState);
	}, [latestAscii, latestState]);

	useEffect(() => {
		if (!boardResult?.warnings?.length) return;
		const newWarnings = boardResult.warnings.filter(
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
	}, [boardResult]);

	const statusLabel = featured?.status ?? "waiting";
	const playersLabel = featured?.players?.length
		? `A: ${featured.players[0] ?? "A"}  B: ${featured.players[1] ?? "B"}`
		: null;

	const resourceSummary = latestState
		? {
				A: latestState.players.A,
				B: latestState.players.B,
				counts: {
					A: latestState.players.A.controlledHexes?.length ?? 0,
					B: latestState.players.B.controlledHexes?.length ?? 0,
				},
			}
		: null;

	return (
		<div className="spectator-landing">
			<div className="spectator-frame">
				<header className="spectator-header">
					<div>
						<div className="spectator-title">HEX CONQUEST {"//"} LIVE FEED</div>
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
								<div>
									Turn: {latestState.turn} | Active: {latestState.activePlayer}{" "}
									| AP: {latestState.actionsRemaining}
								</div>
								{latestState.phase ? (
									<div>Phase: {latestState.phase}</div>
								) : null}
								{resourceSummary ? (
									<div className="panel-split">
										<div>
											A Gold: {resourceSummary.A.gold} | Supply:{" "}
											{resourceSummary.A.supply}/{resourceSummary.A.supplyCap}
										</div>
										<div>
											B Gold: {resourceSummary.B.gold} | Supply:{" "}
											{resourceSummary.B.supply}/{resourceSummary.B.supplyCap}
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
							{boardResult?.text ? (
								<pre className="ascii-board">{boardResult.text}</pre>
							) : (
								<div className="muted">No board data yet.</div>
							)}
							<div className="legend">
								Ai/Bc/Aa = units | K/M/T/. = terrain | A/B/. = control
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

function buildStateLogLine(state: GameState) {
	const a = state.players.A;
	const b = state.players.B;
	return `T${state.turn} ${state.activePlayer} AP ${state.actionsRemaining} | Gold A/B ${a.gold}/${b.gold} | Supply A/B ${a.supply}/${a.supplyCap} ${b.supply}/${b.supplyCap}`;
}

function parseStateEnvelope(input: unknown): {
	state: GameState | null;
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
		return { state: candidate as GameState, ascii: ascii ?? null };
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
