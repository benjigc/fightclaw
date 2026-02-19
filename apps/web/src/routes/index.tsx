import {
	applyMove,
	createInitialState,
	DEFAULT_CONFIG,
	type EngineConfigInput,
	type EngineEvent,
	type MatchState,
	type Move,
} from "@fightclaw/engine";
import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";

import { HexBoard } from "@/components/arena/hex-board";
import { ThoughtPanel } from "@/components/arena/thought-panel";
import {
	type EngineEventsEnvelopeV1,
	useArenaAnimator,
} from "@/lib/arena-animator";

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

const MAX_THOUGHTS = 80;

function SpectatorLanding() {
	const search = Route.useSearch();
	const replayMatchId = search.replayMatchId ?? null;

	const [featured, setFeatured] = useState<FeaturedResponse | null>(null);
	const [latestState, setLatestState] = useState<MatchState | null>(null);
	const [connectionStatus, setConnectionStatus] = useState<
		"idle" | "connecting" | "live" | "replay" | "error"
	>("idle");
	const replayFollowStarted = useRef(false);
	const [replayShouldFollowLive, setReplayShouldFollowLive] = useState(false);
	const [thoughtsA, setThoughtsA] = useState<string[]>([]);
	const [thoughtsB, setThoughtsB] = useState<string[]>([]);
	const [isThinkingA, setIsThinkingA] = useState(false);
	const [isThinkingB, setIsThinkingB] = useState(false);

	const matchId = replayMatchId ?? featured?.matchId ?? null;

	const {
		effects,
		unitAnimStates,
		dyingUnitIds,
		hudFx,
		damageNumbers,
		lungeTargets,
		isAnimating,
		enqueue: enqueueEngineEvents,
		reset: resetAnimator,
	} = useArenaAnimator({
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
			} catch {
				if (!active) return;
				setFeatured({ matchId: null, status: null, players: null });
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
			setConnectionStatus("idle");
			setThoughtsA([]);
			setThoughtsB([]);
			setIsThinkingA(false);
			setIsThinkingB(false);
			return;
		}

		let active = true;
		resetAnimator();
		setLatestState(null);
		setConnectionStatus("connecting");
		setThoughtsA([]);
		setThoughtsB([]);
		setIsThinkingA(false);
		setIsThinkingB(false);

		const fetchState = async () => {
			try {
				const res = await fetch(
					`${env.VITE_SERVER_URL}/v1/matches/${matchId}/state`,
				);
				if (!res.ok) {
					throw new Error(`State request failed (${res.status})`);
				}
				const json = (await res.json()) as { state?: unknown } | null;
				const state = parseStateFromEnvelope(json);
				if (!active) return;
				if (state) {
					setLatestState(state);
				}
			} catch {
				/* state unavailable */
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
				return;
			}
			if (!payload || payload.eventVersion !== 1 || payload.event !== "state")
				return;
			if (!active) return;
			const state = parseStateFromEnvelope(payload);
			if (!state) return;
			setLatestState(state);
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

		const handleAgentThought = (event: MessageEvent<string>) => {
			let payload: { player: "A" | "B"; text: string } | null = null;
			try {
				payload = JSON.parse(event.data) as { player: "A" | "B"; text: string };
			} catch {
				return;
			}
			if (!payload) return;
			if (!active) return;

			const { player: p, text } = payload;
			const setter = p === "A" ? setThoughtsA : setThoughtsB;
			setter((prev) => [...prev, text].slice(-MAX_THOUGHTS));
		};

		eventSource.addEventListener("state", handleStateEvent as EventListener);
		eventSource.addEventListener(
			"engine_events",
			handleEngineEvents as EventListener,
		);
		eventSource.addEventListener(
			"agent_thought",
			handleAgentThought as EventListener,
		);
		eventSource.addEventListener("error", () => {
			if (!active) return;
			setConnectionStatus("error");
		});

		return () => {
			active = false;
			eventSource.close();
		};
	}, [enqueueEngineEvents, matchId, replayMatchId, resetAnimator]);

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
		setConnectionStatus("connecting");
		setThoughtsA([]);
		setThoughtsB([]);
		setIsThinkingA(false);
		setIsThinkingB(false);

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
				const replayEngineConfig = parseReplayEngineConfig(
					startedPayload?.engineConfig,
				);

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

				let state = createInitialState(seed, replayEngineConfig, players);
				setLatestState(state);
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

				if (state.status === "active") {
					setReplayShouldFollowLive(true);
				}
			} catch {
				if (!active) return;
				setConnectionStatus("error");
			}
		};

		void runReplay();

		return () => {
			active = false;
		};
	}, [enqueueEngineEvents, replayMatchId, resetAnimator]);

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
			const state = parseStateFromEnvelope(payload);
			if (!state) return;
			setLatestState(state);
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

	const statusBadge = useMemo(() => {
		switch (connectionStatus) {
			case "live":
				return "LIVE";
			case "replay":
				return "REPLAY";
			case "connecting":
				return "SYNC";
			case "error":
				return "ERR";
			default:
				return "IDLE";
		}
	}, [connectionStatus]);

	return (
		<div className="spectator-landing">
			{/* Game-aware top bar */}
			<div className="spectator-top-bar">
				<span className="status-badge">{statusBadge}</span>
				<span className="top-bar-center">
					{latestState ? (
						<>
							T{latestState.turn}{" "}
							<span
								className={
									latestState.activePlayer === "A"
										? "player-a-color"
										: "player-b-color"
								}
							>
								{latestState.activePlayer}
							</span>{" "}
							| AP {latestState.actionsRemaining}
							{hudFx.passPulse ? " | PASS" : ""}
						</>
					) : (
						"WAR OF ATTRITION"
					)}
				</span>
			</div>

			{/* Three-column layout: thought panel | board | thought panel */}
			<div className="spectator-main">
				<ThoughtPanel
					player="A"
					thoughts={thoughtsA}
					isThinking={isThinkingA}
				/>

				<div className="hex-board-container">
					{latestState ? (
						<HexBoard
							state={latestState}
							effects={effects}
							unitAnimStates={unitAnimStates}
							dyingUnitIds={dyingUnitIds}
							damageNumbers={damageNumbers}
							lungeTargets={lungeTargets}
							activePlayer={latestState?.activePlayer}
						/>
					) : (
						<div className="muted">Awaiting state stream...</div>
					)}
				</div>

				<ThoughtPanel
					player="B"
					thoughts={thoughtsB}
					isThinking={isThinkingB}
				/>
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

function parseStateFromEnvelope(input: unknown): MatchState | null {
	if (!input || typeof input !== "object") {
		return null;
	}

	const container =
		"state" in input ? ((input as { state?: unknown }).state ?? null) : input;
	if (!container || typeof container !== "object") {
		return null;
	}

	const candidate =
		(container as { game?: unknown }).game ??
		(container as { state?: unknown }).state ??
		container;
	if (candidate && typeof candidate === "object" && "players" in candidate) {
		return candidate as MatchState;
	}

	return null;
}

function parseReplayEngineConfig(
	input: unknown,
): EngineConfigInput | undefined {
	if (!isRecord(input)) return undefined;
	const sanitized = sanitizeEngineConfigInput(input, DEFAULT_CONFIG);
	return sanitized as EngineConfigInput | undefined;
}

function sanitizeEngineConfigInput(
	input: unknown,
	template: unknown,
	path = "",
): unknown | undefined {
	if (typeof template === "number") {
		if (typeof input !== "number" || !Number.isFinite(input)) {
			return undefined;
		}
		if (path === "boardColumns" && input !== 17 && input !== 21) {
			return undefined;
		}
		return input;
	}
	if (!isRecord(template) || Array.isArray(template)) {
		return undefined;
	}
	if (!isRecord(input)) {
		return undefined;
	}
	const out: Record<string, unknown> = {};
	for (const key of Object.keys(template)) {
		if (!(key in input)) continue;
		const nextPath = path ? `${path}.${key}` : key;
		const sanitized = sanitizeEngineConfigInput(
			input[key],
			(template as Record<string, unknown>)[key],
			nextPath,
		);
		if (sanitized === undefined) {
			return undefined;
		}
		out[key] = sanitized;
	}
	return out;
}
