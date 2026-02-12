import type { EngineEvent, MatchState, Move } from "@fightclaw/engine";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { UnitAnimState } from "@/components/arena/unit-token";

// Re-export unchanged envelope type for consumers
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

export type ArenaEffect = {
	id: string;
	type:
		| "move-from"
		| "move-to"
		| "attack-source"
		| "attack-target"
		| "recruit"
		| "fortify"
		| "pass";
	hexId: string;
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

const isValidHex = (id: unknown): id is string =>
	typeof id === "string" && id.length >= 2;

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

const strongholdForSide = (side: "A" | "B"): string =>
	side === "A" ? "B2" : "B20";

let effectCounter = 0;
function nextEffectId(): string {
	return `fx-${++effectCounter}`;
}

export function useArenaAnimator(options?: {
	onApplyBaseState?: (state: MatchState) => void;
}) {
	const onApplyBaseStateRef = useRef(options?.onApplyBaseState);
	onApplyBaseStateRef.current = options?.onApplyBaseState;

	const [effects, setEffects] = useState<ArenaEffect[]>([]);
	const [unitAnimStates, setUnitAnimStates] = useState<
		Map<string, UnitAnimState>
	>(new Map());
	const [dyingUnitIds, setDyingUnitIds] = useState<Set<string>>(new Set());
	const [hudFx, setHudFx] = useState<HudFx>({ passPulse: false });
	const [isAnimating, setIsAnimating] = useState(false);

	const queueRef = useRef<QueuedItem[]>([]);
	const runningRef = useRef(false);
	const runTokenRef = useRef(0);
	const lastSeenStateVersionRef = useRef<number>(-1);
	const timeoutsRef = useRef<Set<number>>(new Set());

	const delay = useCallback((ms: number) => {
		return new Promise<void>((resolve) => {
			const id = window.setTimeout(() => {
				timeoutsRef.current.delete(id);
				resolve();
			}, ms);
			timeoutsRef.current.add(id);
		});
	}, []);

	const clearAllTimeouts = useCallback(() => {
		for (const id of timeoutsRef.current) {
			clearTimeout(id);
		}
		timeoutsRef.current.clear();
	}, []);

	const scaleForQueue = useCallback((queuedCount: number) => {
		const speedScale = queuedCount >= 6 ? 0.4 : 1;
		return (ms: number) => Math.max(MIN_STEP_MS, Math.round(ms * speedScale));
	}, []);

	const setUnitAnim = useCallback((unitId: string, state: UnitAnimState) => {
		setUnitAnimStates((prev) => {
			const next = new Map(prev);
			next.set(unitId, state);
			return next;
		});
	}, []);

	const clearUnitAnim = useCallback((unitId: string) => {
		setUnitAnimStates((prev) => {
			const next = new Map(prev);
			next.delete(unitId);
			return next;
		});
	}, []);

	const animateEnvelope = useCallback(
		async (item: QueuedItem, token: number) => {
			const scale = scaleForQueue(queueRef.current.length);
			const envelope = item.envelope;

			// Collect dying unit IDs from attack events BEFORE applying state
			const dyingIds: string[] = [];

			if (envelope.move.action === "attack") {
				const ev = envelope.engineEvents.find((e) => e.type === "attack") as
					| Extract<EngineEvent, { type: "attack" }>
					| undefined;
				if (ev) {
					dyingIds.push(...ev.outcome.defenderCasualties);
					dyingIds.push(...ev.outcome.attackerCasualties);
				}
			}

			// Mark dying units before applying post-state so HexBoard can keep them visible
			if (dyingIds.length > 0) {
				setDyingUnitIds(new Set(dyingIds));
				for (const id of dyingIds) {
					setUnitAnim(id, "dying");
				}
			}

			// Apply post-state (dead units are removed from state here)
			if (item.postState && onApplyBaseStateRef.current) {
				onApplyBaseStateRef.current(item.postState);
			}

			// Clear previous effects
			setEffects([]);

			if (envelope.move.action === "move") {
				const ev = envelope.engineEvents.find((e) => e.type === "move_unit") as
					| Extract<EngineEvent, { type: "move_unit" }>
					| undefined;
				if (ev && isValidHex(ev.from) && isValidHex(ev.to)) {
					setUnitAnim(ev.unitId, "moving");
					setEffects([
						{ id: nextEffectId(), type: "move-from", hexId: ev.from },
						{ id: nextEffectId(), type: "move-to", hexId: ev.to },
					]);
					await delay(scale(260));
					if (runTokenRef.current !== token) return;

					clearUnitAnim(ev.unitId);
					setEffects([]);
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "attack") {
				const ev = envelope.engineEvents.find((e) => e.type === "attack") as
					| Extract<EngineEvent, { type: "attack" }>
					| undefined;
				if (ev && isValidHex(ev.attackerFrom) && isValidHex(ev.targetHex)) {
					setUnitAnim(ev.attackerId, "attacking");
					setEffects([
						{
							id: nextEffectId(),
							type: "attack-source",
							hexId: ev.attackerFrom,
						},
						{
							id: nextEffectId(),
							type: "attack-target",
							hexId: ev.targetHex,
						},
					]);
					await delay(scale(170));
					if (runTokenRef.current !== token) return;

					// Dying units are already marked; wait for exit animation
					await delay(scale(160));
					if (runTokenRef.current !== token) return;

					clearUnitAnim(ev.attackerId);
					for (const id of dyingIds) {
						clearUnitAnim(id);
					}
					setDyingUnitIds(new Set());
					setEffects([]);
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "recruit") {
				const ev = envelope.engineEvents.find((e) => e.type === "recruit") as
					| Extract<EngineEvent, { type: "recruit" }>
					| undefined;
				if (ev && isValidHex(ev.at)) {
					setUnitAnim(ev.unitId, "spawning");
					setEffects([{ id: nextEffectId(), type: "recruit", hexId: ev.at }]);
					await delay(scale(320));
					if (runTokenRef.current !== token) return;

					clearUnitAnim(ev.unitId);
					setEffects([]);
					await delay(scale(120));
					if (runTokenRef.current !== token) return;
				}
			} else if (envelope.move.action === "fortify") {
				const ev = envelope.engineEvents.find((e) => e.type === "fortify") as
					| Extract<EngineEvent, { type: "fortify" }>
					| undefined;
				if (ev && isValidHex(ev.at)) {
					setUnitAnim(ev.unitId, "fortifying");
					setEffects([{ id: nextEffectId(), type: "fortify", hexId: ev.at }]);
					await delay(scale(300));
					if (runTokenRef.current !== token) return;

					clearUnitAnim(ev.unitId);
					setEffects([]);
				}
			} else if (
				envelope.move.action === "end_turn" ||
				envelope.move.action === "pass"
			) {
				const side = inferSide(envelope.engineEvents) ?? "A";
				const key = strongholdForSide(side);

				setHudFx((prev) => ({ ...prev, passPulse: true }));
				setEffects([{ id: nextEffectId(), type: "pass", hexId: key }]);
				await delay(scale(260));
				if (runTokenRef.current !== token) return;

				setHudFx((prev) => ({ ...prev, passPulse: false }));
				setEffects([]);
				await delay(scale(120));
				if (runTokenRef.current !== token) return;
			}
		},
		[clearUnitAnim, delay, scaleForQueue, setUnitAnim],
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
		runningRef.current = false;
		runTokenRef.current += 1;
		lastSeenStateVersionRef.current = -1;
		setEffects([]);
		setUnitAnimStates(new Map());
		setDyingUnitIds(new Set());
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
			effects,
			unitAnimStates,
			dyingUnitIds,
			hudFx,
			isAnimating,
			enqueue,
			reset,
		}),
		[effects, unitAnimStates, dyingUnitIds, hudFx, isAnimating, enqueue, reset],
	);

	return api;
}
