import type {
	EngineEvent,
	HexCoord,
	MatchState,
	Move,
} from "@fightclaw/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type EngineEventsEnvelopeV1 = {
	eventVersion: 1;
	event: "engine_events";
	matchId: string;
	stateVersion: number;
	agentId: string;
	moveId: string;
	move: Move;
	engineEvents: EngineEvent[];
	ts: string;
};

export type CellFx = {
	classes: string[];
	overrideText: string | null;
};

export type HudFx = {
	passPulse: boolean;
};

type QueuedItem = {
	envelope: EngineEventsEnvelopeV1;
	postState?: MatchState;
};

const MAX_QUEUE = 8;
const MIN_STEP_MS = 50;

const TRANSIENT_CLASSES = [
	"fx-move-from",
	"fx-move-to",
	"fx-attack-attacker",
	"fx-attack-target",
	"fx-attack-impact",
	"fx-recruit",
	"fx-fortify-flash",
	"fx-pass",
];

const coordKey = (coord: HexCoord) => `${coord.q},${coord.r}`;
const isInBounds = (coord: HexCoord) =>
	coord.q >= -3 && coord.q <= 3 && coord.r >= -3 && coord.r <= 3;

const inferSide = (events: EngineEvent[]): "A" | "B" | null => {
	for (const event of events) {
		switch (event.type) {
			case "turn_start":
			case "turn_end":
			case "recruit":
			case "move_unit":
			case "fortify":
			case "attack":
			case "reject":
				return event.player;
			case "control_update":
			case "game_end":
				continue;
		}
	}
	return null;
};

const capitalForSide = (side: "A" | "B"): HexCoord =>
	side === "A" ? { q: -3, r: -3 } : { q: 3, r: 3 };

export function useSpectatorAnimator(options?: {
	onApplyBaseState?: (state: MatchState) => void;
}) {
	const onApplyBaseStateRef = useRef(options?.onApplyBaseState);
	onApplyBaseStateRef.current = options?.onApplyBaseState;

	const [cellFx, setCellFx] = useState<Record<string, CellFx>>({});
	const [hudFx, setHudFx] = useState<HudFx>({ passPulse: false });
	const [isAnimating, setIsAnimating] = useState(false);

	const queueRef = useRef<QueuedItem[]>([]);
	const wakeRef = useRef<(() => void) | null>(null);
	const runningRef = useRef(false);
	const runTokenRef = useRef(0);
	const lastSeenStateVersionRef = useRef<number>(-1);

	const classesRef = useRef<Map<string, Set<string>>>(new Map());
	const overrideRef = useRef<Map<string, string>>(new Map());
	const idleFocusKeyRef = useRef<string | null>(null);

	const timeoutsRef = useRef<Set<number>>(new Set());
	const shimmerTimeoutByKeyRef = useRef<Map<string, number>>(new Map());

	const flush = useCallback(() => {
		const snapshot: Record<string, CellFx> = {};

		for (const [key, set] of classesRef.current.entries()) {
			if (!set || set.size === 0) continue;
			snapshot[key] = {
				classes: [...set],
				overrideText: overrideRef.current.get(key) ?? null,
			};
		}

		for (const [key, overrideText] of overrideRef.current.entries()) {
			if (snapshot[key]) continue;
			snapshot[key] = {
				classes: [],
				overrideText,
			};
		}

		setCellFx(snapshot);
	}, []);

	const clearAllTimeouts = useCallback(() => {
		for (const id of timeoutsRef.current) {
			clearTimeout(id);
		}
		timeoutsRef.current.clear();

		for (const id of shimmerTimeoutByKeyRef.current.values()) {
			clearTimeout(id);
		}
		shimmerTimeoutByKeyRef.current.clear();
	}, []);

	const delay = useCallback((ms: number) => {
		return new Promise<void>((resolve) => {
			const id = window.setTimeout(() => {
				timeoutsRef.current.delete(id);
				resolve();
			}, ms);
			timeoutsRef.current.add(id);
		});
	}, []);

	const addClassByKey = useCallback((key: string, cls: string) => {
		const set = classesRef.current.get(key) ?? new Set<string>();
		set.add(cls);
		classesRef.current.set(key, set);
	}, []);

	const removeClassByKey = useCallback((key: string, cls: string) => {
		const set = classesRef.current.get(key);
		if (!set) return;
		set.delete(cls);
		if (set.size === 0) {
			classesRef.current.delete(key);
		}
	}, []);

	const setOverrideByKey = useCallback((key: string, text: string) => {
		overrideRef.current.set(key, text);
	}, []);

	const clearOverrideByKey = useCallback((key: string) => {
		overrideRef.current.delete(key);
	}, []);

	const clearTransientFxAll = useCallback(() => {
		overrideRef.current.clear();
		for (const [key, set] of classesRef.current.entries()) {
			let mutated = false;
			for (const cls of TRANSIENT_CLASSES) {
				if (set.delete(cls)) mutated = true;
			}
			if (mutated && set.size === 0) {
				classesRef.current.delete(key);
			}
		}
	}, []);

	const setIdleFocus = useCallback(
		(coord: HexCoord | null) => {
			const prevKey = idleFocusKeyRef.current;
			const nextKey = coord && isInBounds(coord) ? coordKey(coord) : null;

			if (prevKey && prevKey !== nextKey) {
				removeClassByKey(prevKey, "fx-idle-focus");
			}
			idleFocusKeyRef.current = nextKey;
			if (nextKey) {
				addClassByKey(nextKey, "fx-idle-focus");
			}
			flush();
		},
		[addClassByKey, flush, removeClassByKey],
	);

	const scheduleFortifyShimmer = useCallback(
		(key: string, afterMs: number) => {
			const prev = shimmerTimeoutByKeyRef.current.get(key);
			if (prev) clearTimeout(prev);

			const id = window.setTimeout(() => {
				shimmerTimeoutByKeyRef.current.delete(key);
				removeClassByKey(key, "fx-fortify-shimmer");
				flush();
			}, afterMs);

			shimmerTimeoutByKeyRef.current.set(key, id);
		},
		[flush, removeClassByKey],
	);

	const scaleForQueue = useCallback((queuedCount: number) => {
		const catchUp = queuedCount >= 6;
		const speedScale = catchUp ? 0.4 : 1;
		return (ms: number) => Math.max(MIN_STEP_MS, Math.round(ms * speedScale));
	}, []);

	const animateEnvelope = useCallback(
		async (item: QueuedItem, token: number) => {
			const scale = scaleForQueue(queueRef.current.length);
			const envelope = item.envelope;

			if (item.postState && onApplyBaseStateRef.current) {
				onApplyBaseStateRef.current(item.postState);
			}

			clearTransientFxAll();
			flush();

			const focusCoordFromAction = (): HexCoord | null => {
				switch (envelope.move.action) {
					case "move": {
						const ev = envelope.engineEvents.find(
							(e) => e.type === "move_unit",
						) as Extract<EngineEvent, { type: "move_unit" }> | undefined;
						return ev?.to ?? null;
					}
					case "attack": {
						const ev = envelope.engineEvents.find((e) => e.type === "attack") as
							| Extract<EngineEvent, { type: "attack" }>
							| undefined;
						return ev?.targetHex ?? null;
					}
					case "recruit": {
						const ev = envelope.engineEvents.find(
							(e) => e.type === "recruit",
						) as Extract<EngineEvent, { type: "recruit" }> | undefined;
						return ev?.at ?? null;
					}
					case "fortify": {
						const ev = envelope.engineEvents.find(
							(e) => e.type === "fortify",
						) as Extract<EngineEvent, { type: "fortify" }> | undefined;
						return ev?.at ?? null;
					}
					case "pass": {
						const side = inferSide(envelope.engineEvents) ?? "A";
						return capitalForSide(side);
					}
				}
			};

			if (envelope.move.action === "move") {
				const ev = envelope.engineEvents.find((e) => e.type === "move_unit") as
					| Extract<EngineEvent, { type: "move_unit" }>
					| undefined;
				if (ev && isInBounds(ev.from) && isInBounds(ev.to)) {
					const fromKey = coordKey(ev.from);
					const toKey = coordKey(ev.to);

					addClassByKey(fromKey, "fx-move-from");
					flush();
					await delay(scale(90));
					if (runTokenRef.current !== token) return;

					addClassByKey(toKey, "fx-move-to");
					flush();
					await delay(scale(170));
					if (runTokenRef.current !== token) return;

					removeClassByKey(fromKey, "fx-move-from");
					removeClassByKey(toKey, "fx-move-to");
					flush();
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "attack") {
				const ev = envelope.engineEvents.find((e) => e.type === "attack") as
					| Extract<EngineEvent, { type: "attack" }>
					| undefined;
				if (ev && isInBounds(ev.attackerFrom) && isInBounds(ev.targetHex)) {
					const atkKey = coordKey(ev.attackerFrom);
					const tgtKey = coordKey(ev.targetHex);

					addClassByKey(atkKey, "fx-attack-attacker");
					addClassByKey(tgtKey, "fx-attack-target");
					flush();
					await delay(scale(80));
					if (runTokenRef.current !== token) return;

					addClassByKey(tgtKey, "fx-attack-impact");
					setOverrideByKey(tgtKey, "!!");
					flush();
					await delay(scale(90));
					if (runTokenRef.current !== token) return;

					clearOverrideByKey(tgtKey);
					if (ev.outcome.defender === "dies") {
						setOverrideByKey(tgtKey, "xx");
					}
					if (ev.outcome.attacker === "dies") {
						setOverrideByKey(atkKey, "xx");
					}
					if (ev.outcome.captured) {
						addClassByKey(tgtKey, "fx-move-to");
					}
					flush();
					await delay(scale(160));
					if (runTokenRef.current !== token) return;

					clearOverrideByKey(atkKey);
					clearOverrideByKey(tgtKey);
					removeClassByKey(atkKey, "fx-attack-attacker");
					removeClassByKey(tgtKey, "fx-attack-target");
					removeClassByKey(tgtKey, "fx-attack-impact");
					removeClassByKey(tgtKey, "fx-move-to");
					flush();
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "recruit") {
				const ev = envelope.engineEvents.find((e) => e.type === "recruit") as
					| Extract<EngineEvent, { type: "recruit" }>
					| undefined;
				if (ev && isInBounds(ev.at)) {
					const atKey = coordKey(ev.at);

					addClassByKey(atKey, "fx-recruit");
					setOverrideByKey(atKey, "++");
					flush();
					await delay(scale(120));
					if (runTokenRef.current !== token) return;

					clearOverrideByKey(atKey);
					flush();
					await delay(scale(200));
					if (runTokenRef.current !== token) return;

					removeClassByKey(atKey, "fx-recruit");
					flush();
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "fortify") {
				const ev = envelope.engineEvents.find((e) => e.type === "fortify") as
					| Extract<EngineEvent, { type: "fortify" }>
					| undefined;
				if (ev && isInBounds(ev.at)) {
					const atKey = coordKey(ev.at);

					addClassByKey(atKey, "fx-fortify-flash");
					flush();
					await delay(scale(140));
					if (runTokenRef.current !== token) return;

					removeClassByKey(atKey, "fx-fortify-flash");
					addClassByKey(atKey, "fx-fortify-shimmer");
					flush();

					// Linger without blocking next move.
					scheduleFortifyShimmer(atKey, scale(2000));
				}
			} else if (envelope.move.action === "pass") {
				const side = inferSide(envelope.engineEvents) ?? "A";
				const capital = capitalForSide(side);
				if (isInBounds(capital)) {
					const key = coordKey(capital);
					setHudFx((prev) => ({ ...prev, passPulse: true }));

					addClassByKey(key, "fx-pass");
					flush();
					await delay(scale(260));
					if (runTokenRef.current !== token) return;

					setHudFx((prev) => ({ ...prev, passPulse: false }));
					removeClassByKey(key, "fx-pass");
					flush();
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			}

			// Update idle focus after action resolves (does not clear existing linger).
			const focus = focusCoordFromAction();
			setIdleFocus(focus);
		},
		[
			addClassByKey,
			clearOverrideByKey,
			clearTransientFxAll,
			delay,
			flush,
			removeClassByKey,
			scaleForQueue,
			scheduleFortifyShimmer,
			setIdleFocus,
			setOverrideByKey,
		],
	);

	const runLoop = useCallback(async () => {
		const token = runTokenRef.current;
		for (;;) {
			if (!runningRef.current) break;
			const next = queueRef.current.shift() ?? null;
			if (!next) {
				runningRef.current = false;
				setIsAnimating(false);
				break;
			}

			await animateEnvelope(next, token);
			if (runTokenRef.current !== token) break;
		}
	}, [animateEnvelope]);

	const enqueue = useCallback(
		(envelope: EngineEventsEnvelopeV1, opts?: { postState?: MatchState }) => {
			if (
				typeof envelope.stateVersion === "number" &&
				envelope.stateVersion <= lastSeenStateVersionRef.current
			) {
				return;
			}
			if (typeof envelope.stateVersion === "number") {
				lastSeenStateVersionRef.current = envelope.stateVersion;
			}

			const queue = queueRef.current;
			if (queue.length >= MAX_QUEUE) {
				queue.splice(0, queue.length - MAX_QUEUE + 1);
			}
			queue.push({ envelope, postState: opts?.postState });

			if (wakeRef.current) {
				wakeRef.current();
				wakeRef.current = null;
			}

			if (!runningRef.current) {
				runningRef.current = true;
				setIsAnimating(true);
				void runLoop();
			}
		},
		[runLoop],
	);

	const reset = useCallback(() => {
		queueRef.current = [];
		wakeRef.current = null;
		runningRef.current = false;
		runTokenRef.current += 1;
		lastSeenStateVersionRef.current = -1;
		classesRef.current.clear();
		overrideRef.current.clear();
		idleFocusKeyRef.current = null;
		setCellFx({});
		setHudFx({ passPulse: false });
		setIsAnimating(false);
		clearAllTimeouts();
	}, [clearAllTimeouts]);

	useEffect(() => {
		return () => {
			reset();
		};
	}, [reset]);

	const api = useMemo(
		() => ({
			cellFx,
			hudFx,
			isAnimating,
			enqueue,
			reset,
			setIdleFocus,
		}),
		[cellFx, enqueue, hudFx, isAnimating, reset, setIdleFocus],
	);

	return api;
}
