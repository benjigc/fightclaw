import { randomUUID } from "node:crypto";
import type { Move } from "@fightclaw/engine";
import type { ArenaClient } from "./client";
import {
	HttpLongPollEventSource,
	parseQueueEvent,
	WsEventSource,
} from "./eventSources";
import type {
	MatchEventSource,
	MoveSubmitResponse,
	RunMatchOptions,
	RunMatchResult,
	RunnerEvent,
} from "./types";

const DEFAULT_TIMEOUT_FALLBACK_MOVE: Move = {
	action: "pass",
	reasoning: "Timed safety fallback: pass turn.",
};

const MAX_CONSECUTIVE_ACTIONS_PER_TURN = 32;

const getActiveAgentIdFromGame = (
	game:
		| {
				activePlayer?: string;
				players?: Record<string, { id?: string }>;
		  }
		| undefined,
) => {
	const activePlayer = game?.activePlayer;
	const players = game?.players;
	if (!activePlayer || !players) return null;
	const active = players[activePlayer];
	if (!active || typeof active.id !== "string") return null;
	return active.id;
};

const normalizeLoser = (
	agentA: string,
	agentB: string | null,
	winner: string | null,
): string | null => {
	if (!winner) return null;
	if (winner === agentA) return agentB;
	if (winner === agentB) return agentA;
	return null;
};

const resolveTerminalFromMove = (
	result: MoveSubmitResponse,
	agentId: string,
	opponentId: string | null,
): RunMatchResult | null => {
	if (result.ok) {
		if (result.state.status !== "ended") return null;
		const winner = result.state.winnerAgentId ?? null;
		return {
			matchId: "",
			transport: "http",
			reason: result.state.endReason ?? "terminal",
			winnerAgentId: winner,
			loserAgentId: normalizeLoser(agentId, opponentId, winner),
		};
	}
	if (result.matchStatus !== "ended") return null;
	return {
		matchId: "",
		transport: "http",
		reason: result.reasonCode ?? result.reason ?? "ended",
		winnerAgentId: result.winnerAgentId ?? null,
		loserAgentId: normalizeLoser(
			agentId,
			opponentId,
			result.winnerAgentId ?? null,
		),
	};
};

export const runMatch = async (
	client: ArenaClient,
	options: RunMatchOptions,
): Promise<RunMatchResult> => {
	const preferredTransport = options.preferredTransport ?? "ws";
	const allowTransportFallback = options.allowTransportFallback ?? true;
	const queueWaitTimeoutSeconds = options.queueWaitTimeoutSeconds ?? 30;
	const queueTimeoutMs = options.queueTimeoutMs ?? 10 * 60 * 1000;
	const httpPollIntervalMs = options.httpPollIntervalMs ?? 1_500;
	const moveProviderTimeoutMs = options.moveProviderTimeoutMs;
	const moveProviderTimeoutFallbackMove =
		options.moveProviderTimeoutFallbackMove ?? DEFAULT_TIMEOUT_FALLBACK_MOVE;
	const resolveMove = async (stateVersion: number): Promise<Move> => {
		const moveContext = {
			agentId: me.agentId,
			matchId,
			stateVersion,
		};
		if (
			typeof moveProviderTimeoutMs !== "number" ||
			!Number.isFinite(moveProviderTimeoutMs) ||
			moveProviderTimeoutMs <= 0
		) {
			return await options.moveProvider.nextMove(moveContext);
		}

		let timeout: ReturnType<typeof setTimeout> | null = null;
		try {
			return await Promise.race([
				options.moveProvider.nextMove(moveContext),
				new Promise<Move>((resolveTimeout) => {
					timeout = setTimeout(() => {
						resolveTimeout(moveProviderTimeoutFallbackMove);
					}, moveProviderTimeoutMs);
				}),
			]);
		} finally {
			if (timeout) clearTimeout(timeout);
		}
	};

	const me = await client.me();
	const joined = await client.queueJoin();
	let matchId = joined.matchId;
	const opponentId = joined.opponentId ?? null;

	if (joined.status !== "ready") {
		const startedAt = Date.now();
		while (true) {
			if (Date.now() - startedAt > queueTimeoutMs) {
				throw new Error("Timed out waiting for queue match.");
			}
			const waited = await client.waitForMatch(queueWaitTimeoutSeconds);
			const queueEvent = parseQueueEvent(waited.events);
			if (!queueEvent) continue;
			if (queueEvent.type === "match_found") {
				matchId = queueEvent.matchId;
				break;
			}
		}
	}

	const createHttpSource = () =>
		new HttpLongPollEventSource(
			client,
			matchId,
			me.agentId,
			httpPollIntervalMs,
		);
	const preferredSource =
		preferredTransport === "http"
			? createHttpSource()
			: new WsEventSource(client, matchId);
	let source = preferredSource;
	let lastObservedVersion = -1;
	const handledTurns = new Set<number>();
	let turnLoopInFlight = false;
	let transport = source.kind;

	const stopFns: Array<() => void> = [];

	let terminal: RunMatchResult;
	try {
		terminal = await new Promise<RunMatchResult>((resolve, reject) => {
			let fallbackStarted = false;
			const startHttpFallback = () => {
				fallbackStarted = true;
				const fallbackSource = createHttpSource();
				void startSource(fallbackSource);
				source = fallbackSource;
				transport = source.kind;
			};

			const startSource = (candidate: MatchEventSource) => {
				return candidate
					.start(async (event) => {
						// Once fallback is active, treat WS as dead to avoid stale turn signals.
						if (candidate.kind === "ws" && fallbackStarted) return;
						transport = candidate.kind;
						await handleEvent(event, candidate.kind);
					})
					.then((stop) => {
						stopFns.push(stop);
					})
					.catch((error) => {
						if (candidate.kind === "ws" && fallbackStarted) return;
						if (
							candidate.kind === "ws" &&
							allowTransportFallback &&
							!fallbackStarted
						) {
							startHttpFallback();
							return;
						}
						reject(error);
					});
			};

			const handleEvent = async (
				event: RunnerEvent,
				sourceKind: MatchEventSource["kind"],
			) => {
				if (event.type === "state") {
					lastObservedVersion = event.stateVersion;
					return;
				}
				if (event.type === "match_ended") {
					resolve({
						matchId,
						transport,
						reason: event.reason ?? "ended",
						winnerAgentId: event.winnerAgentId ?? null,
						loserAgentId:
							event.loserAgentId ??
							normalizeLoser(
								me.agentId,
								opponentId,
								event.winnerAgentId ?? null,
							),
					});
					return;
				}
				if (event.type === "error") {
					if (sourceKind === "ws" && fallbackStarted) {
						return;
					}
					if (transport === "ws" && fallbackStarted) {
						return;
					}
					if (
						sourceKind === "ws" &&
						allowTransportFallback &&
						!fallbackStarted
					) {
						startHttpFallback();
						return;
					}
					reject(new Error(`Match event source error: ${event.error}`));
					return;
				}
				if (event.type !== "your_turn") return;

				const initialExpectedVersion =
					event.stateVersion >= 0 ? event.stateVersion : lastObservedVersion;
				if (initialExpectedVersion < 0) {
					return;
				}
				if (handledTurns.has(initialExpectedVersion)) {
					return;
				}
				if (turnLoopInFlight) {
					return;
				}
				turnLoopInFlight = true;

				try {
					let expectedVersion = initialExpectedVersion;
					let actionsApplied = 0;

					while (actionsApplied < MAX_CONSECUTIVE_ACTIONS_PER_TURN) {
						if (handledTurns.has(expectedVersion)) {
							break;
						}

						const move = await resolveMove(expectedVersion);

						const response = await client.submitMove(matchId, {
							moveId: randomUUID(),
							expectedVersion,
							move,
						});
						if (response.ok) {
							lastObservedVersion = response.state.stateVersion;
							handledTurns.add(expectedVersion);
						}

						const terminalFromMove = resolveTerminalFromMove(
							response,
							me.agentId,
							opponentId,
						);
						if (terminalFromMove) {
							resolve({
								...terminalFromMove,
								matchId,
								transport,
							});
							return;
						}

						if (!response.ok) {
							break;
						}

						const nextVersion = response.state.stateVersion;
						if (nextVersion <= expectedVersion) {
							break;
						}

						const activeAgentId = getActiveAgentIdFromGame(response.state.game);
						if (activeAgentId !== me.agentId) {
							break;
						}

						expectedVersion = nextVersion;
						actionsApplied += 1;
					}
				} catch (error) {
					reject(error);
				} finally {
					turnLoopInFlight = false;
				}
			};
			void startSource(source);
		});
	} finally {
		for (const stop of stopFns) {
			stop();
		}
	}
	return terminal;
};
