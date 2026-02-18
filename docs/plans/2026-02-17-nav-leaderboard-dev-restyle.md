# Nav / Leaderboard / Dev Restyle Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a shared terminal-style nav bar to all routes, restyle the leaderboard page to match the terminal aesthetic, and rework the dev page to mirror the spectator layout with a dev controls panel.

**Architecture:** Shared nav bar lives in `__root.tsx` so every route inherits it. The spectator page's game-info bar is extracted into a route-level second bar (not in root). Leaderboard gets a full terminal restyle replacing all shadcn utilities. Dev page mirrors spectator's three-column grid with a dev controls panel replacing the right thought stream.

**Tech Stack:** React 19, TanStack Router (file-based), Tailwind CSS v4, CSS custom properties, Biome formatting (tabs + double quotes)

---

### Task 1: Shared Nav Bar in `__root.tsx`

**Files:**
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/routes/index.tsx` (remove nav links from spectator top bar)

**Context:** Currently `__root.tsx` renders a bare `<Outlet />` inside a dark div. The spectator page (`index.tsx`) has nav links in its own top bar. We need a shared nav bar in the root so every route gets navigation, then remove the duplicate nav from the spectator page.

**Step 1: Add nav bar CSS to `index.css`**

Add after the `.spectator-top-bar` block in `apps/web/src/index.css`:

```css
/* ── Shared nav bar ──────────────────────────────────── */

.site-nav {
	position: relative;
	z-index: 10;
	height: 36px;
	display: flex;
	align-items: center;
	justify-content: space-between;
	padding: 0 16px;
	font-family: var(--mono);
	font-size: 0.75rem;
	border-bottom: 1px dashed var(--spectator-border);
	background: var(--spectator-bg);
	color: var(--spectator-muted);
	flex-shrink: 0;
}

.site-nav-brand {
	color: var(--spectator-accent);
	font-weight: 700;
	letter-spacing: 0.15em;
	text-transform: uppercase;
}

.site-nav-links {
	display: flex;
	gap: 16px;
}

.site-nav-links a {
	color: var(--spectator-muted);
	text-decoration: none;
	transition: color 0.15s;
}

.site-nav-links a:hover,
.site-nav-links a[data-status="active"] {
	color: var(--spectator-accent);
}
```

**Step 2: Update `__root.tsx` to render shared nav**

Replace the `RootComponent` function in `apps/web/src/routes/__root.tsx` with:

```tsx
import {
	createRootRouteWithContext,
	HeadContent,
	Link,
	Outlet,
} from "@tanstack/react-router";
import { TanStackRouterDevtools } from "@tanstack/react-router-devtools";

import { Toaster } from "@/components/ui/sonner";

import "../index.css";

// biome-ignore lint/complexity/noBannedTypes: TanStack Router context placeholder
export type RouterAppContext = {};

const NAV_LINKS = [
	{ to: "/" as const, label: "Spectate" },
	{ to: "/leaderboard" as const, label: "Leaderboard" },
	...(import.meta.env.DEV ? [{ to: "/dev" as const, label: "Dev" }] : []),
];

export const Route = createRootRouteWithContext<RouterAppContext>()({
	component: RootComponent,
	head: () => ({
		meta: [
			{
				title: "fightclaw",
			},
			{
				name: "description",
				content: "fightclaw is a web application",
			},
		],
		links: [
			{
				rel: "icon",
				href: "/favicon.ico",
			},
		],
	}),
});

function RootComponent() {
	return (
		<>
			<HeadContent />
			<div className="dark h-svh overflow-hidden bg-[#050b10]">
				<nav className="site-nav">
					<span className="site-nav-brand">FIGHTCLAW</span>
					<div className="site-nav-links">
						{NAV_LINKS.map(({ to, label }) => (
							<Link key={to} to={to}>
								{label}
							</Link>
						))}
					</div>
				</nav>
				<Outlet />
			</div>
			<Toaster richColors theme="dark" />
			<TanStackRouterDevtools position="bottom-left" />
		</>
	);
}
```

**Step 3: Remove nav links from spectator page**

In `apps/web/src/routes/index.tsx`:

1. Remove the `NAV_LINKS` constant at module level.
2. Remove the `<nav className="flex gap-4">` block from inside `.spectator-top-bar`.
3. Remove the `Link` import from `@tanstack/react-router` (keep `createFileRoute`).

The spectator top bar should now only show: status badge, center game info. No nav links.

**Step 4: Update spectator-landing height to account for root nav**

In `apps/web/src/index.css`, change the `.spectator-landing` height:

```css
.spectator-landing {
	/* ... existing vars unchanged ... */
	height: calc(100svh - 36px); /* subtract root nav height */
	/* ... rest unchanged ... */
}
```

And update `.spectator-main` height:

```css
.spectator-main {
	/* ... */
	height: calc(100% - 36px); /* subtract spectator top bar from remaining space */
	/* ... */
}
```

**Step 5: Verify in browser**

Run: `pnpm run dev:web`

- Navigate to `localhost:3001` — should see "FIGHTCLAW" nav bar at top, "Spectate" link active, game info bar below, board + thought panels filling the rest.
- Navigate to `/leaderboard` — should see same nav bar, "Leaderboard" active.
- Navigate to `/dev` — should see same nav bar, "Dev" active (dev mode only).
- No vertical scrolling on any page.

**Step 6: Commit**

```bash
git add apps/web/src/routes/__root.tsx apps/web/src/routes/index.tsx apps/web/src/index.css
git commit -m "feat(web): add shared terminal nav bar to all routes"
```

---

### Task 2: Leaderboard Terminal Restyle

**Files:**
- Modify: `apps/web/src/routes/leaderboard.tsx`
- Modify: `apps/web/src/index.css`

**Context:** The leaderboard currently uses shadcn utility classes (`text-muted-foreground`, `bg-muted`, `border-t`, `container`, `rounded-lg`) which render as dark text on dark bg — completely broken. It needs a full terminal restyle using our `.spectator-landing` CSS variables and monospace typography.

**Step 1: Add leaderboard CSS to `index.css`**

Add to `apps/web/src/index.css`:

```css
/* ── Leaderboard ─────────────────────────────────────── */

.leaderboard-page {
	height: calc(100svh - 36px);
	overflow-y: auto;
	background: var(--spectator-bg);
	color: var(--spectator-text);
	font-family: var(--mono);
	display: flex;
	justify-content: center;
	padding: 32px 16px;
}

.leaderboard-inner {
	width: 100%;
	max-width: 700px;
}

.leaderboard-title {
	font-size: 1.25rem;
	font-weight: 700;
	color: var(--spectator-accent);
	text-transform: uppercase;
	letter-spacing: 0.1em;
	margin-bottom: 4px;
}

.leaderboard-subtitle {
	font-size: 0.7rem;
	color: var(--spectator-muted);
	margin-bottom: 24px;
}

.leaderboard-table {
	width: 100%;
	font-size: 0.75rem;
	border-collapse: collapse;
}

.leaderboard-table thead th {
	text-align: left;
	padding: 8px 12px;
	color: var(--spectator-muted);
	text-transform: uppercase;
	letter-spacing: 0.12em;
	font-size: 0.65rem;
	font-weight: 400;
	border-bottom: 1px dashed var(--spectator-border);
}

.leaderboard-table tbody td {
	padding: 8px 12px;
	border-bottom: 1px dashed rgba(30, 54, 66, 0.4);
}

.leaderboard-table .rating-cell {
	color: var(--spectator-accent);
	font-weight: 600;
}

.leaderboard-table .rank-cell {
	color: var(--spectator-muted);
	width: 48px;
}

.leaderboard-table .agent-cell {
	color: var(--spectator-text);
}

.leaderboard-table .games-cell {
	color: var(--spectator-muted);
}

.leaderboard-loading,
.leaderboard-error {
	font-size: 0.75rem;
	color: var(--spectator-muted);
	font-style: italic;
}

.leaderboard-error {
	color: #ff6b6b;
}
```

**Step 2: Rewrite `leaderboard.tsx`**

Replace the entire `Leaderboard` component in `apps/web/src/routes/leaderboard.tsx` with:

```tsx
import { env } from "@fightclaw/env/web";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";

export const Route = createFileRoute("/leaderboard")({
	component: Leaderboard,
});

type LeaderboardEntry = {
	agent_id: string;
	rating: number;
	games_played: number;
	wins?: number;
	losses?: number;
	updated_at?: string;
};

type LeaderboardResponse = {
	leaderboard: LeaderboardEntry[];
};

function Leaderboard() {
	const [entries, setEntries] = useState<LeaderboardEntry[]>([]);
	const [loading, setLoading] = useState(true);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		let active = true;
		const fetchLeaderboard = async () => {
			setLoading(true);
			setError(null);
			try {
				const res = await fetch(`${env.VITE_SERVER_URL}/v1/leaderboard`);
				if (!res.ok) {
					throw new Error(`Leaderboard request failed (${res.status})`);
				}
				const json = (await res.json()) as LeaderboardResponse;
				if (!active) return;
				setEntries(json.leaderboard ?? []);
			} catch (err) {
				if (!active) return;
				setError((err as Error).message ?? "Leaderboard unavailable.");
			} finally {
				if (active) setLoading(false);
			}
		};

		void fetchLeaderboard();
		return () => {
			active = false;
		};
	}, []);

	return (
		<div className="leaderboard-page">
			<div className="leaderboard-inner">
				<h1 className="leaderboard-title">Leaderboard</h1>
				<p className="leaderboard-subtitle">Top agents by rating.</p>

				{loading ? (
					<div className="leaderboard-loading">Loading leaderboard...</div>
				) : null}
				{error ? <div className="leaderboard-error">{error}</div> : null}

				{!loading && !error ? (
					<table className="leaderboard-table">
						<thead>
							<tr>
								<th>Rank</th>
								<th>Agent</th>
								<th>Rating</th>
								<th>Games</th>
							</tr>
						</thead>
						<tbody>
							{entries.map((entry, index) => (
								<tr key={entry.agent_id}>
									<td className="rank-cell">{index + 1}</td>
									<td className="agent-cell">{entry.agent_id}</td>
									<td className="rating-cell">{entry.rating}</td>
									<td className="games-cell">{entry.games_played}</td>
								</tr>
							))}
						</tbody>
					</table>
				) : null}
			</div>
		</div>
	);
}
```

**Step 3: Verify in browser**

Run: `pnpm run dev:web`

Navigate to `/leaderboard`:
- Should see terminal-styled page with dark bg, monospace font, teal accent title, dashed borders on table.
- Text should be visible (light on dark).
- Shared nav bar at top with "Leaderboard" active.

**Step 4: Commit**

```bash
git add apps/web/src/routes/leaderboard.tsx apps/web/src/index.css
git commit -m "feat(web): restyle leaderboard with terminal aesthetic"
```

---

### Task 3: Dev Page — Spectator Layout with Dev Controls Panel

**Files:**
- Modify: `apps/web/src/routes/dev.tsx`
- Modify: `apps/web/src/index.css`

**Context:** The dev page currently uses shadcn-styled header + card layout that doesn't match the spectator aesthetic. It needs to mirror the spectator page's three-column grid (thought panel | board | dev panel), with the right panel replaced by dev controls. The board should render identically to spectator. The dev controls (seed, reset, random, burst) move into the right panel styled with terminal aesthetic.

**Step 1: Add dev panel CSS to `index.css`**

Add to `apps/web/src/index.css`:

```css
/* ── Dev controls panel ──────────────────────────────── */

.dev-panel {
	background: rgba(5, 11, 16, 0.85);
	border-left: 1px dashed var(--spectator-border);
	padding: 12px;
	font-family: var(--mono);
	font-size: 0.7rem;
	display: flex;
	flex-direction: column;
	gap: 12px;
	overflow-y: auto;
}

.dev-panel-label {
	font-size: 0.65rem;
	text-transform: uppercase;
	letter-spacing: 0.1em;
	color: var(--spectator-accent);
	margin-bottom: 4px;
}

.dev-panel-section {
	display: flex;
	flex-direction: column;
	gap: 6px;
}

.dev-panel-row {
	display: flex;
	gap: 6px;
	align-items: center;
}

.dev-panel-input {
	width: 100%;
	height: 28px;
	padding: 0 8px;
	font-family: var(--mono);
	font-size: 0.7rem;
	background: rgba(11, 21, 28, 0.8);
	border: 1px dashed var(--spectator-border);
	color: var(--spectator-text);
	outline: none;
}

.dev-panel-input:focus {
	border-color: var(--spectator-accent);
}

.dev-panel-btn {
	height: 28px;
	padding: 0 10px;
	font-family: var(--mono);
	font-size: 0.65rem;
	text-transform: uppercase;
	letter-spacing: 0.08em;
	background: transparent;
	border: 1px dashed var(--spectator-border);
	color: var(--spectator-text);
	cursor: pointer;
	transition: border-color 0.15s, color 0.15s;
	white-space: nowrap;
}

.dev-panel-btn:hover {
	border-color: var(--spectator-accent);
	color: var(--spectator-accent);
}

.dev-panel-btn:disabled {
	opacity: 0.4;
	cursor: not-allowed;
}

.dev-panel-btn-primary {
	border-color: var(--spectator-accent);
	color: var(--spectator-accent);
}

.dev-panel-stat {
	display: flex;
	justify-content: space-between;
}

.dev-panel-stat-label {
	color: var(--spectator-muted);
}

.dev-panel-stat-value {
	color: var(--spectator-text);
}

.dev-panel-stat-accent {
	color: var(--spectator-accent);
}
```

**Step 2: Rewrite `dev.tsx`**

Replace the entire file `apps/web/src/routes/dev.tsx` with:

```tsx
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
import { ThoughtPanel } from "@/components/arena/thought-panel";
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
			<div className="leaderboard-page">
				<div className="leaderboard-inner">
					<h1 className="leaderboard-title">Dev tools disabled</h1>
					<p className="leaderboard-subtitle">
						This route is only available in dev mode.
					</p>
				</div>
			</div>
		);
	}

	return <DevLayout />;
}

function DevLayout() {
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
		damageNumbers,
		lungeTargets,
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

	const unitCountA = useMemo(
		() =>
			Object.values(boardState.units).filter((u) => u.owner === "A").length,
		[boardState.units],
	);
	const unitCountB = useMemo(
		() =>
			Object.values(boardState.units).filter((u) => u.owner === "B").length,
		[boardState.units],
	);

	return (
		<div className="spectator-landing">
			{/* Game-info bar (mirrors spectator) */}
			<div className="spectator-top-bar">
				<span className="status-badge">DEV</span>
				<span className="top-bar-center">
					T{boardState.turn}{" "}
					<span
						className={
							boardState.activePlayer === "A"
								? "player-a-color"
								: "player-b-color"
						}
					>
						{boardState.activePlayer}
					</span>{" "}
					| AP {boardState.actionsRemaining}
					{hudFx.passPulse ? " | PASS" : ""}
				</span>
				<span className="muted">seed:{seed}</span>
			</div>

			{/* Three-column layout: thought panel | board | dev panel */}
			<div className="spectator-main">
				<ThoughtPanel player="A" thoughts={[]} isThinking={false} />

				<div className="hex-board-container">
					<HexBoard
						state={boardState}
						effects={effects}
						unitAnimStates={unitAnimStates}
						dyingUnitIds={dyingUnitIds}
						damageNumbers={damageNumbers}
						lungeTargets={lungeTargets}
						activePlayer={boardState.activePlayer}
					/>
				</div>

				<div className="dev-panel">
					<div className="dev-panel-label">Dev Controls</div>

					<div className="dev-panel-section">
						<div className="dev-panel-stat-label">Seed</div>
						<div className="dev-panel-row">
							<input
								type="number"
								className="dev-panel-input"
								value={seed}
								onChange={(e) => setSeed(Number(e.target.value) || 0)}
							/>
						</div>
						<button
							type="button"
							className="dev-panel-btn"
							onClick={() => resetBoard(seed)}
						>
							Reset
						</button>
					</div>

					<div className="dev-panel-section">
						<div className="dev-panel-stat-label">Actions</div>
						<button
							type="button"
							className="dev-panel-btn dev-panel-btn-primary"
							onClick={playRandomMove}
							disabled={boardState.status !== "active"}
						>
							Random Move
						</button>
						<div className="dev-panel-row">
							<button
								type="button"
								className="dev-panel-btn"
								onClick={() => playBurst(5)}
								disabled={boardState.status !== "active"}
							>
								+5
							</button>
							<button
								type="button"
								className="dev-panel-btn"
								onClick={() => playBurst(20)}
								disabled={boardState.status !== "active"}
							>
								+20
							</button>
						</div>
					</div>

					<div className="dev-panel-section">
						<div className="dev-panel-label">State</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Status</span>
							<span className="dev-panel-stat-accent">{boardState.status}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Turn</span>
							<span className="dev-panel-stat-value">{boardState.turn}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Active</span>
							<span className="dev-panel-stat-value">
								{boardState.activePlayer}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">AP</span>
							<span className="dev-panel-stat-value">
								{boardState.actionsRemaining}
							</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Moves</span>
							<span className="dev-panel-stat-value">{moveCount}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Units A</span>
							<span className="player-a-color">{unitCountA}</span>
						</div>
						<div className="dev-panel-stat">
							<span className="dev-panel-stat-label">Units B</span>
							<span className="player-b-color">{unitCountB}</span>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
```

**Step 3: Remove dev route overrides from CSS**

In `apps/web/src/index.css`, remove the entire `/* ── Dev route overrides ── */` section:

```css
/* DELETE THIS BLOCK: */
.dev-spectate-board .hex-board-container { ... }
.dev-spectate-board .hex-board-svg { ... }
```

These overrides were for the old layout. The dev page now uses the same `.hex-board-container` and `.hex-board-svg` classes as spectator — no overrides needed.

**Step 4: Verify in browser**

Run: `pnpm run dev:web`

Navigate to `/dev`:
- Shared nav bar at top with "Dev" active.
- Game-info bar below with "DEV" badge, turn info, seed display.
- Three-column grid: left thought panel (empty/placeholder), center board (identical to spectator), right dev controls panel.
- Dev controls: seed input, reset button, random/+5/+20 buttons, game state readout.
- All styled in terminal aesthetic — monospace, dashed borders, teal accents.
- Board fills the center column, no scrolling.
- Clicking "Random Move" plays a move with animations identical to spectator.

**Step 5: Run type check**

Run: `cd /Users/bgciv/Dev/fightclaw && pnpm -w run check-types`

The web app should type-check clean. (The server may have pre-existing issues — focus on `apps/web`.)

**Step 6: Run Biome**

Run: `cd /Users/bgciv/Dev/fightclaw && pnpm -w run check`

Ensure no new lint errors in modified files.

**Step 7: Commit**

```bash
git add apps/web/src/routes/dev.tsx apps/web/src/index.css
git commit -m "feat(web): rework dev page to mirror spectator layout with dev controls panel"
```

---

## Post-Plan Addendum (2026-02-18): Implemented Dev Replay Workflow

This addendum documents concrete `/dev` changes that were implemented after this plan was authored.
Do not remove these behaviors when executing or extending the plan.

### Scope of the addendum

- Keeps all original tasks intact.
- Adds the new API replay toolchain and dev-tab controls introduced later.

### Implemented changes

1. `/dev` now has mode switching:
- `Sandbox` mode (random/burst local preview).
- `API Replay` mode (replay real API lane games).

2. `/dev` replay tools now include:
- Replay URL input (`/dev-replay/latest.json` default).
- `Load Replay` and `Load Latest`.
- Match selector for replay bundle entries.
- Playback controls: `Reset Match`, `Step`, `Play/Pause`, `Step ms`.
- Action log (latest 200 replayed actions).

3. Sim exporter added for web replay data:
- New file: `apps/sim/scripts/export-web-replay.ts`
- Writes: `apps/web/public/dev-replay/latest.json`
- Reads from benchmark API artifact directories under `apps/sim/results`.

4. Sim scripts added:
- `export:web-replay`
- `benchmark:v2:api_full:viz`
- `benchmark:v2:api_smoke:viz`

### Standard local workflow (now expected)

1. Start web UI:
- `pnpm run dev:web`
- Open `http://localhost:3001/dev`

2. Publish latest replay data:
- `pnpm -C apps/sim run export:web-replay`

3. Run API lane + auto-publish replay:
- `pnpm -C apps/sim run benchmark:v2:api_full:viz`

### Guardrails for future agents

- Preserve the replay-mode controls in `apps/web/src/routes/dev.tsx`.
- Preserve exporter + script contract in `apps/sim/scripts/export-web-replay.ts` and `apps/sim/package.json`.
- Keep this file-based bridge as the default local-dev visualization path unless explicitly superseded.
