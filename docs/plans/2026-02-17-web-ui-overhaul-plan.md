# Web UI Overhaul Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Overhaul the Fightclaw spectator web UI from a barebones ASCII/terminal prototype to a polished, animated, board-dominant spectate experience — all pure SVG + Framer Motion, no raster assets.

**Architecture:** Existing SVG hex grid + Framer Motion animation stack. Rework layout to board-dominant single screen with flanking thought panels. Add elevation via stacked SVG polygons, large ASCII terrain art, and rich unit animations (slide movement, combat lunge/dissolve, idle pulse). All within the dark terminal aesthetic.

**Tech Stack:** React 19, Framer Motion 12, Tailwind CSS v4, SVG, TanStack Router

**Design doc:** `docs/plans/2026-02-17-web-ui-overhaul-design.md`

---

## Task 1: Page Layout — Restructure to Board-Dominant Single Screen

Rip out the three-panel grid layout and replace with the board-dominant layout: thin top bar, two thin thought panels flanking the board, no system log, no light mode.

**Files:**
- Modify: `apps/web/src/routes/__root.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/components/header.tsx`
- Modify: `apps/web/src/index.css`
- Delete references to: `apps/web/src/components/mode-toggle.tsx`

**Step 1: Update root layout**

In `__root.tsx`, change the grid from `grid-rows-[auto_1fr]` to a viewport-locked layout. Remove ThemeProvider wrapping (force dark). Remove ModeToggle import.

```tsx
function RootComponent() {
  return (
    <>
      <HeadContent />
      <div className="h-svh overflow-hidden bg-[#050b10]">
        <Outlet />
      </div>
      <Toaster richColors />
    </>
  );
}
```

**Step 2: Simplify header to thin top bar**

Replace `header.tsx` with a minimal top bar component. Monospace font, dashed bottom border, ~32-40px height. Left: match status badge. Center: turn + active player. Right: nav links.

```tsx
export default function Header({
  turn,
  activePlayer,
  connectionStatus,
}: {
  turn?: number;
  activePlayer?: string;
  connectionStatus?: string;
}) {
  const links = [
    { to: "/leaderboard", label: "Leaderboard" },
    ...(import.meta.env.DEV ? [{ to: "/dev", label: "Dev" }] : []),
  ] as const;

  return (
    <header className="spectator-top-bar">
      <div className="top-bar-left">
        <span className="status-badge">{connectionStatus ?? "IDLE"}</span>
      </div>
      <div className="top-bar-center">
        {turn != null ? (
          <span>
            TURN {turn} · <span className={`player-${activePlayer}`}>{activePlayer}</span>
          </span>
        ) : (
          <span>WAR OF ATTRITION</span>
        )}
      </div>
      <nav className="top-bar-right">
        {links.map(({ to, label }) => (
          <Link key={to} to={to}>{label}</Link>
        ))}
      </nav>
    </header>
  );
}
```

**Step 3: Restructure spectator landing layout**

In `index.tsx`, replace the three-panel `.spectator-grid` with:
- A CSS grid: `grid-template-columns: minmax(0, 10%) 1fr minmax(0, 10%)`
- Left column: Player A thought panel (placeholder for now)
- Center: HexBoard (fills remaining space)
- Right column: Player B thought panel (placeholder for now)
- Remove the system log panel entirely
- Remove the HUD panel (will be re-added as overlays in a later task)
- Pass turn/activePlayer/connectionStatus to the new Header

**Step 4: Update CSS**

In `index.css`:
- Remove `.spectator-grid`, `.spectator-panel`, `.panel-title`, `.panel-body`, `.panel-split`, `.log-body`, `.log-line`, `.spectator-header`, `.spectator-frame`, `.spectator-players`, `.spectator-status`, `.spectator-subtitle` classes
- Add `.spectator-top-bar` styles (height: 36px, flex, monospace, dashed bottom border, `#050b10` bg)
- Add `.spectator-main` grid styles (three columns: 10% / 1fr / 10%, height: calc(100svh - 36px))
- Add `.thought-panel` base styles (semi-transparent bg, monospace, overflow hidden)
- Update `.hex-board-svg` max-height to fill the center column fully
- Remove light mode CSS variables (keep only `.dark` block and the spectator vars)

**Step 5: Run type check and dev server**

Run: `cd apps/web && npx tsc --noEmit`
Run: `pnpm run dev:web` — verify the page renders with board centered, thin top bar, two empty side panels, no scrolling.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): restructure layout to board-dominant single screen"
```

---

## Task 2: Elevation System — Stacked Hex Polygons + Brightness Tiers

Add visual elevation to the hex grid: elevated terrain (hills, high_ground, strongholds) gets stacked polygon layers beneath + brighter fills. Forest gets its own unique visual.

**Files:**
- Modify: `apps/web/src/lib/arena-theme.ts`
- Modify: `apps/web/src/components/arena/hex-cell.tsx`
- Modify: `apps/web/src/lib/hex-geo.ts` (add helper for offset hex points)

**Step 1: Add elevation config to arena-theme.ts**

Replace `TERRAIN_FILLS` with a richer terrain config:

```ts
export type ElevationTier = "base" | "elevated" | "forest";

export const TERRAIN_ELEVATION: Record<HexType, ElevationTier> = {
  plains: "base",
  deploy_a: "base",
  deploy_b: "base",
  gold_mine: "base",
  lumber_camp: "base",
  crown: "base",
  forest: "forest",
  hills: "elevated",
  high_ground: "elevated",
  stronghold_a: "elevated",
  stronghold_b: "elevated",
};

export const ELEVATION_STYLE: Record<ElevationTier, {
  fill: string;
  stroke: string;
  stackFill: string;
  stackStroke: string;
  stackLayers: number;
}> = {
  base: {
    fill: "#0a0a0a",
    stroke: "#1a3a2a",
    stackFill: "#000000",
    stackStroke: "#0d1f15",
    stackLayers: 0,
  },
  elevated: {
    fill: "#142820",
    stroke: "#3a7a4a",
    stackFill: "#0a1810",
    stackStroke: "#1a3a2a",
    stackLayers: 1,
  },
  forest: {
    fill: "#0a1408",
    stroke: "#2a5a1a",
    stackFill: "#000000",
    stackStroke: "#1a3a1a",
    stackLayers: 0,
  },
};

export const TERRAIN_ACCENT: Partial<Record<HexType, string>> = {
  gold_mine: "#2a2010",
  lumber_camp: "#1a1408",
  crown: "#2a2810",
  stronghold_a: "#1a2820",
  stronghold_b: "#1a2820",
};
```

**Step 2: Add stackOffsetY constant and helper to hex-geo.ts**

```ts
export const STACK_OFFSET_Y = 4; // SVG units per elevation layer
```

**Step 3: Rewrite HexCell to render stacked polygons**

In `hex-cell.tsx`, render stack layers first (offset downward), then the top face. Use `TERRAIN_ELEVATION` to determine stack count and fills. Apply `TERRAIN_ACCENT` as a subtle additive fill layer.

For forest, add a subtle SVG pattern (vertical dashes) as an `<pattern>` def rendered inside the hex `<g>`.

For controlled hexes, blend the player color into only the top face.

**Step 4: Verify visually**

Run: `pnpm run dev:web` — navigate to `/dev`, verify:
- Plains/deploy/gold/lumber/crown hexes are flat and dark
- Hills/high_ground/strongholds have a visible raised platform effect
- Forest hexes have a distinct green-tinted look
- Controlled hexes still show player color on top face

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add elevation stacking and brightness tiers to hex cells"
```

---

## Task 3: Large ASCII Terrain Art

Replace the tiny Unicode terrain icons with large multi-line ASCII art that fills the hex interior.

**Files:**
- Modify: `apps/web/src/lib/arena-theme.ts`
- Modify: `apps/web/src/components/arena/hex-cell.tsx`
- Modify: `apps/web/src/components/arena/hex-board.tsx` (pass `hasUnit` to HexCell)

**Step 1: Design terrain ASCII art in arena-theme.ts**

Replace `TERRAIN_ICONS` with `TERRAIN_ASCII`:

```ts
export const TERRAIN_ASCII: Partial<Record<HexType, string[]>> = {
  forest:       [" /\\ ", "/  \\", "/||\\"],
  gold_mine:    [" $$ ", "/\\/\\", " \\/ "],
  lumber_camp:  [" ## ", " || ", "_||_"],
  crown:        [" /\\ ", "|##|", "\\__/"],
  stronghold_a: ["[==]", "|##|", "|__|"],
  stronghold_b: ["[==]", "|##|", "|__|"],
  deploy_a:     [" .. ", ". A.", " .. "],
  deploy_b:     [" .. ", ". B.", " .. "],
};
```

(These are starting designs — iterate during implementation for best look at the actual hex scale.)

**Step 2: Update HexCell to render multi-line terrain ASCII**

Replace the single `<text>` icon with multiple `<text>` lines, same approach as UnitToken. Use `radius * 0.3` font size, centered in the hex. Apply `fillOpacity` of `0.5` normally.

**Step 3: Add `hasUnit` prop to HexCell**

In `hex-board.tsx`, compute which hexes have units and pass `hasUnit={true}` to those HexCells. When `hasUnit` is true, reduce terrain ASCII opacity to `0.15` so the unit takes visual priority.

**Step 4: Verify visually**

Run: `pnpm run dev:web` — verify terrain ASCII is readable on empty hexes and fades when units occupy.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): replace terrain icons with large ASCII art"
```

---

## Task 4: Unit Movement Animation (Slide Between Hexes)

Make units visually slide between hexes instead of teleporting.

**Files:**
- Modify: `apps/web/src/lib/arena-animator.ts`
- Modify: `apps/web/src/components/arena/unit-token.tsx`
- Modify: `apps/web/src/components/arena/hex-board.tsx`

**Step 1: Track target position in animator**

In `arena-animator.ts`, for `move` actions, instead of instantly applying postState, introduce a two-phase approach:
1. Set the unit's animation target position (the destination hex pixel coords)
2. After the animation completes (~350ms), apply the postState

Add a new state: `unitPositions: Map<string, { x: number; y: number }>` that holds override positions during movement animation.

Export this from `useArenaAnimator` so `HexBoard` can use it.

**Step 2: Update UnitToken to animate position**

Change `UnitToken` to use Framer Motion's `animate` prop with spring physics for x/y:

```tsx
<motion.g
  animate={{ x, y, scale: ..., opacity: ... }}
  transition={{
    x: { type: "spring", stiffness: 200, damping: 20 },
    y: { type: "spring", stiffness: 200, damping: 20 },
    // ... other transitions
  }}
>
```

The key insight: when the animator updates the unit's position in state, Framer Motion's `animate` prop will interpolate from old x/y to new x/y with spring physics — the slide happens automatically.

**Step 3: Update HexBoard to pass animated positions**

In `hex-board.tsx`, use `unitPositions` from the animator to override pixel positions during movement. When a unit has an override position, use that; otherwise compute from `hexIdToPixel`.

**Step 4: Test movement animation**

Run: `pnpm run dev:web` — go to `/dev`, click "Random move" repeatedly. Units should slide smoothly between hexes with a slight spring overshoot.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add spring-physics slide animation for unit movement"
```

---

## Task 5: Combat Animations — Lunge, Damage Numbers, Death Dissolve

Rich combat visuals: attacker lunges, damage numbers float up, dying units dissolve character-by-character.

**Files:**
- Modify: `apps/web/src/components/arena/unit-token.tsx`
- Modify: `apps/web/src/components/arena/arena-effects.tsx`
- Modify: `apps/web/src/lib/arena-animator.ts`
- Create: `apps/web/src/components/arena/damage-number.tsx`

**Step 1: Add DamageNumber component**

Create `damage-number.tsx` — a Framer Motion `<motion.text>` that floats upward and fades out:

```tsx
export function DamageNumber({ x, y, value }: { x: number; y: number; value: number }) {
  return (
    <motion.text
      x={x} y={y}
      initial={{ y, opacity: 1 }}
      animate={{ y: y - 20, opacity: 0 }}
      transition={{ duration: 0.6, ease: "easeOut" }}
      textAnchor="middle"
      fontFamily="monospace"
      fontSize={8}
      fill="#ef4444"
      fontWeight="bold"
    >
      -{value}
    </motion.text>
  );
}
```

**Step 2: Add lunge animation to attacker**

In the animator, for attack actions, compute a lunge offset (direction vector from attacker toward target, scaled to ~30% of the distance). Set this as a temporary position override, then snap back after ~200ms.

In `UnitToken`, when `animState === "attacking"`, replace the scale keyframes with a translate lunge toward the target direction.

**Step 3: Add ranged attack tracer**

In `arena-effects.tsx`, add a new effect type `"attack-tracer"` that renders a dashed `<line>` from attacker position to target position, animated with Framer Motion (opacity fade in then out, ~300ms total).

In the animator, for attack actions where the move's unit is an archer (range > 1), emit the tracer effect before the impact.

**Step 4: Implement death dissolve**

In `UnitToken`, when `animState === "dying"`, instead of the current `exit={{ scale: 0, opacity: 0 }}`:
- Split the ASCII art into individual characters
- Each character becomes a `<motion.tspan>` with:
  - Random x/y offset (scatter outward from center)
  - Fade to opacity 0
  - Staggered delay (character index * 40ms)
- Total dissolve ~400-500ms

**Step 5: Wire damage numbers into animator**

In the animator, for attack events, extract damage from `engineEvent.outcome.defenderDamage` and emit a damage number effect at the target hex position. Add `damageNumbers` to the animator's exported state.

In `HexBoard`, render `<DamageNumber>` elements from the animator's damage number state inside an `<AnimatePresence>`.

**Step 6: Test combat animations**

Run: `pnpm run dev:web` — go to `/dev`, trigger combat via "Random move" bursts. Verify:
- Attacker lunges toward target
- Damage number floats up from target hex
- Archer attacks show a tracer line
- Dying units dissolve character-by-character

**Step 7: Commit**

```bash
git add -A && git commit -m "feat(web): add combat lunge, damage numbers, and death dissolve animations"
```

---

## Task 6: Idle Animation + HP Bar Polish

Subtle breathing pulse on active player's units, animated HP drain.

**Files:**
- Modify: `apps/web/src/components/arena/unit-token.tsx`
- Modify: `apps/web/src/components/arena/hex-board.tsx` (pass `activePlayer`)

**Step 1: Add idle breathing pulse**

In `UnitToken`, when `animState === "idle"` and the unit's owner matches the active player, add a CSS animation or Framer Motion `animate` that oscillates opacity between 0.85 and 1.0 on a ~3.5 second cycle:

```tsx
const isActivePlayerUnit = unit.owner === activePlayer;
// In the motion.g animate prop:
opacity: animState === "idle" && isActivePlayerUnit
  ? [0.85, 1, 0.85]  // keyframes
  : 1,
// With transition:
opacity: {
  duration: 3.5,
  repeat: Infinity,
  ease: "easeInOut",
}
```

**Step 2: Animate HP bar drain**

Wrap the HP fill `<rect>` in a `<motion.rect>` and animate `width` with a tween transition:

```tsx
<motion.rect
  animate={{ width: hpBarWidth * hpFraction }}
  transition={{ type: "tween", duration: 0.4, ease: "easeOut" }}
  // ... other props
/>
```

**Step 3: Add fortify ring pulse**

For fortified units, animate the fortify circle's opacity between 0.6 and 1.0:

```tsx
<motion.circle
  animate={{ strokeOpacity: [0.6, 1, 0.6] }}
  transition={{ duration: 2, repeat: Infinity, ease: "easeInOut" }}
  // ... other props
/>
```

**Step 4: Pass activePlayer to HexBoard and UnitToken**

Thread `activePlayer` from `latestState.activePlayer` through `HexBoard` → `UnitToken`.

**Step 5: Verify**

Run: `pnpm run dev:web` — active player's units should gently pulse. Damaged units' HP bars should animate when taking damage. Fortified units' rings should pulse.

**Step 6: Commit**

```bash
git add -A && git commit -m "feat(web): add idle breathing, HP drain animation, fortify pulse"
```

---

## Task 7: Thought Stream Panels

Implement the AI thought stream panels flanking the board.

**Files:**
- Create: `apps/web/src/components/arena/thought-panel.tsx`
- Modify: `apps/web/src/routes/index.tsx`
- Modify: `apps/web/src/index.css`

**Step 1: Create ThoughtPanel component**

```tsx
type ThoughtPanelProps = {
  player: "A" | "B";
  thoughts: string[];
  isThinking: boolean;
};

export function ThoughtPanel({ player, thoughts, isThinking }: ThoughtPanelProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const color = player === "A" ? "#ffffff" : "#33ff66";

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [thoughts]);

  return (
    <div className="thought-panel">
      <div className="thought-panel-label" style={{ color }}>
        PLAYER {player}
      </div>
      <div className="thought-panel-content" ref={scrollRef}>
        {thoughts.length === 0 ? (
          <div className="thought-placeholder">Awaiting agent connection...</div>
        ) : (
          thoughts.map((text, i) => (
            <div key={i} className="thought-line" style={{ color }}>{text}</div>
          ))
        )}
        {isThinking ? <span className="thought-cursor">_</span> : null}
      </div>
    </div>
  );
}
```

**Step 2: Add CSS for thought panels**

In `index.css`:
- `.thought-panel`: height 100%, semi-transparent bg (`rgba(5,11,16,0.85)`), border on board-facing side, overflow hidden, flex column
- `.thought-panel-content`: flex-1, overflow-y auto, scrollbar hidden, mask-image gradient fade at top
- `.thought-panel-label`: small uppercase monospace label at top
- `.thought-line`: font-size 11px, monospace, line-height 1.4
- `.thought-cursor`: blinking animation (opacity toggle, 800ms cycle)
- `.thought-placeholder`: muted color, italic

**Step 3: Wire into spectator landing**

In `index.tsx`, add state for thoughts (`useState<string[]>` per player) and an SSE handler for `agent_thought` events. For now, just render the panels with placeholder state since the server doesn't emit `agent_thought` yet.

Place `<ThoughtPanel player="A" .../>` in the left column and `<ThoughtPanel player="B" .../>` in the right column of the spectator grid.

**Step 4: Verify**

Run: `pnpm run dev:web` — two thought panels should flank the board. They should show "Awaiting agent connection..." with a blinking cursor. Board should still be centered and dominant.

**Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): add thought stream panels with placeholder state"
```

---

## Task 8: Atmosphere Polish — Scanlines, Colors, Cleanup

Final visual polish pass: refine scanlines, clean up unused CSS/components, tune colors.

**Files:**
- Modify: `apps/web/src/index.css`
- Modify: `apps/web/src/routes/__root.tsx`
- Delete: `apps/web/src/components/mode-toggle.tsx`
- Delete: `apps/web/src/components/theme-provider.tsx`

**Step 1: Tone down scanline effect**

In the `.spectator-landing::before` pseudo-element, reduce opacity from `0.6` to `0.25`. The scanlines should be felt not seen.

**Step 2: Remove unused components**

Delete `mode-toggle.tsx` and `theme-provider.tsx`. Remove their imports from `__root.tsx` (already done in Task 1 but verify no dangling references).

**Step 3: Clean up unused CSS**

Remove any remaining unused class definitions from `index.css` that were part of the old layout (verify against grep for class usage).

**Step 4: Remove unused light mode CSS variables**

The `:root` (light mode) CSS variables are unused since we're dark-only. Remove the `:root` block — keep only `.dark` block and spectator vars.

**Step 5: Run quality checks**

Run: `cd apps/web && npx tsc --noEmit` — zero errors
Run: `pnpm -w run check` — Biome passes

**Step 6: Commit**

```bash
git add -A && git commit -m "style(web): atmosphere polish, remove unused components and CSS"
```

---

## Task Summary

| # | Task | Key Deliverable |
|---|---|---|
| 1 | Page Layout | Board-dominant single screen, thin top bar, side panels |
| 2 | Elevation System | Stacked polygons + brightness tiers on hex cells |
| 3 | Terrain ASCII Art | Large multi-line ASCII replacing tiny Unicode icons |
| 4 | Movement Animation | Spring-physics slide between hexes |
| 5 | Combat Animations | Lunge, damage numbers, death dissolve, ranged tracer |
| 6 | Idle + HP Polish | Breathing pulse, animated HP drain, fortify pulse |
| 7 | Thought Panels | Flanking AI thought stream with placeholder state |
| 8 | Atmosphere Polish | Scanline tuning, cleanup, remove light mode |

## Out of Scope (TBD items from design doc)

- HUD resource/unit display design
- Agent avatar/castle visual at strongholds
- Server-side `agent_thought` SSE event implementation
- Exact ASCII art iteration (starting designs in Task 3, refined later)
