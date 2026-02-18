# Web UI Overhaul Design

Date: 2026-02-17

## Summary

Overhaul the Fightclaw spectator web UI from a barebones ASCII/terminal prototype to a polished, animated, board-dominant spectate experience. Stay within the ASCII/terminal art aesthetic — no raster images or SVG sprite assets. All rendering remains pure SVG + Framer Motion.

## Approach

**Pure SVG + Framer Motion** (Approach A). Builds on the existing hex-geo.ts and HexBoard architecture. No new rendering layers (no canvas, no CSS 3D). Framer Motion (already a dependency) handles all animation.

---

## 1. Page Layout

Single-screen, no scrolling. `100svh` viewport lock.

```
┌─────────────────────────────────────────────────┐
│  thin top bar: match status / turn / nav links  │
├────────┬───────────────────────────┬────────────┤
│        │                           │            │
│ Player │                           │  Player    │
│ A      │                           │  B         │
│ Thought│      HEX BOARD            │  Thought   │
│ Stream │      (~76-80% width)      │  Stream    │
│        │                           │            │
│        │                           │            │
├────────┴───────────────────────────┴────────────┤
│  HUD overlays in bottom corners (TBD design)    │
└─────────────────────────────────────────────────┘
```

- **Top bar**: ~32-40px. Center: turn number + active player (color-coded). Left: match status badge (LIVE/REPLAY). Right: nav links (Leaderboard, Dev). Monospace, dashed bottom border.
- **Thought panels**: ~10-12% width each side. See Section 5.
- **Board**: Fills remaining center. SVG with `preserveAspectRatio`.
- **HUD**: Player resources (gold/wood/VP/AP) as small fixed overlays in bottom corners. Exact design TBD.
- **Agent avatar/castle display**: TBD — potentially a visual presence at each player's stronghold.
- **System log**: Removed entirely.
- **Light mode**: Removed. Dark-only aesthetic.

---

## 2. Hex Board — Elevation & Terrain

### Two elevation tiers

| Tier | Terrain types | Visual treatment |
|---|---|---|
| **Base** | plains, deploy zones, gold_mine, lumber_camp, crown | Single polygon, darker fill |
| **Elevated** | hills, high_ground, strongholds | Stacked polygon outlines beneath + brighter fill |

Elevated hexes get additional polygon(s) drawn below and offset downward (~3-4 SVG units per layer), creating a "rising platform" look. Same hex shape, progressively darker stroke on the stack layers. Render order: stack layers bottom-up, top face last.

```
  Elevated hex:
       ___
      /   \      <- top face (brighter)
     /     \
     \_____/
      \_____/   <- stack layer (darker)
```

### Brightness tiers

Terminal palette — luminance shifts on a dark base, no full color:

| Tier | Fill | Stroke |
|---|---|---|
| Base | `#0a0a0a` (near-black) | `#1a3a2a` (dark green-grey) |
| Elevated | `#142820` (noticeably brighter) | `#3a7a4a` (brighter green) |
| Stack layers | progressively darker fills for depth shadow |

### Forest — unique visual

Forest is a special case: not elevated, not plain base. Gets its own distinct visual treatment — immediately recognizable at a glance due to its gameplay significance (blocks LoS, blocks cavalry charge, archer bonus). Exact fill/pattern determined during implementation.

### Terrain-specific accents (subtle)

- **Gold mine**: very subtle warm amber tint
- **Lumber camp**: very subtle brown tint
- **Strongholds**: slightly heavier stroke + faint glow (SVG filter)
- **Crown**: faint gold-ish tint

Accents are subtle — terminal aesthetic stays dominant.

### Controlled hex treatment

Player color bleeds into the top-face fill at low opacity with a brighter stroke. Stack layers beneath stay neutral.

---

## 3. Terrain Identifiers — Large ASCII Art

Replace all current small Unicode symbols (♣, ∆, ✦, ⚒, ♕, █) with large multi-line ASCII art that fills the hex interior. Each terrain type gets a distinctive drawing — same approach as unit tokens.

Examples (final designs iterated during implementation):
- **Forest**: tree-line characters
- **Gold mine**: pickaxe pattern
- **Lumber camp**: axe/log pattern
- **Stronghold**: crenellated wall
- **Crown**: crown/throne pattern
- **Deploy zone**: target/circle pattern

### Behavior when units occupy the hex

Terrain ASCII art becomes translucent (reduced opacity) when a unit occupies the hex. The unit token takes visual priority; the terrain fades into the background but remains faintly visible.

---

## 4. Unit Tokens & Animations

### ASCII art

Keep the 3-line multi-line ASCII format. Refine character choices for more personality and readability. Scale up slightly relative to hex — units should feel like they own their hex. Exact designs iterated during implementation.

### Movement animation

- Framer Motion `animate` on the `<g>` group's x/y transform
- Spring physics (slight overshoot and settle)
- ~300-400ms per hop
- Multi-hex moves: animate through each intermediate hex position sequentially (follow the hex path, not a straight line)

### Combat animation

**Melee attack:**
- Attacker lunges toward target hex (translate partway, snap back) ~200ms
- Target hex: bright stroke pulse (impact flash)
- Damage number floats up from target — `<text>` animates upward + fades out ~600ms

**Ranged attack (archer):**
- Dashed line or dot series traces from attacker to target before impact
- Then same impact flash + damage number

**Death dissolve:**
- Split unit ASCII `<text>` into individual `<tspan>` characters
- Each character scatters outward with randomized angle + fades to 0 opacity
- Staggered timing (50-100ms offset per character) for a ripple effect
- Total duration ~400-500ms

### Idle animation

- Slow opacity pulse (sine wave between ~0.85 and 1.0, 3-4 second cycle)
- Only the active player's units pulse during their turn
- Low priority polish

### HP bar

- Slightly wider to match scaled-up tokens
- Animated drain when HP changes (bar width transitions rather than snapping)
- Color: green (>50%), amber (25-50%), red (<25%)

### Fortify indicator

- Dashed circle ring (existing) + subtle opacity pulse to distinguish from static decoration

### Stack count badge

- Keep as-is: circle + number in top-right corner

---

## 5. Thought Stream Panels

### Structure

Two vertical panels flanking the board. Player A left, Player B right.

- **Width**: ~10-12% of viewport
- **Height**: top bar to bottom edge
- **Background**: semi-transparent dark (`rgba(5, 11, 16, 0.85)`)
- **Border**: thin dashed line on the board-facing edge
- **Font**: monospace, 11-13px, player-colored

### Content behavior

- Auto-scrolls to bottom as new text arrives
- Older text fades via gradient mask at the top
- New text: typewriter reveal animation (character-by-character or line-by-line)
- Blinking cursor/caret at bottom when agent is actively thinking
- When not that player's turn: panel goes quiet, last thought stays visible but dimmed

### Player identification

- Player A: white text (`#ffffff`)
- Player B: green text (`#33ff66`)
- Small label at top: "PLAYER A" / "PLAYER B"

### Data source

Requires a new SSE event type from the server: `agent_thought` with `{ player: "A" | "B", text: string }`. Until available, panels show placeholder state ("Awaiting agent connection..." with blinking cursor).

---

## 6. Overall Atmosphere

- **Background**: deep navy-black (`#050b10` range) — keep existing
- **Scanline effect**: keep but make very subtle (felt not seen)
- **Color palette**: monochrome with green-grey terminal tones. Player colors (white + green) are the brightest elements. Terrain accents stay muted.
- **No decorative borders or chrome** — board and panels feel projected onto a screen
- **Font**: monospace throughout (JetBrains Mono / IBM Plex Mono stack)

### Removed

- Three-panel grid layout (left HUD / center board / right log)
- System log panel
- Light mode / mode toggle
- Thick padding and panel borders

---

## Open items (TBD — not blocking implementation)

- HUD resource/unit display design
- Agent avatar/castle visual at strongholds
- Exact ASCII art designs for each terrain and unit type (iterated during implementation)
- Server-side `agent_thought` SSE event implementation
