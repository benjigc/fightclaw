# Shared Nav + Leaderboard Restyle + Dev Page Rework Design

Date: 2026-02-17

## Summary

Add a shared terminal-style nav bar to all routes, completely restyle the leaderboard to match the terminal aesthetic, and rework the dev page to mirror the spectator layout with a dev controls panel replacing the right thought stream.

## 1. Shared Navigation

A thin terminal-style nav bar rendered in `__root.tsx` so every route gets it.

- Height: 36px, monospace font, dashed bottom border, dark bg (#050b10)
- Left: "FIGHTCLAW" in teal accent color (#4de3c2)
- Right: nav links (Spectate, Leaderboard, Dev in dev mode)
- Active link gets brighter color to indicate current route
- The spectator page's game-info bar (turn, active player, status badge) becomes a second bar below this nav, only on the spectator and dev routes

## 2. Leaderboard — Full Terminal Restyle

Completely rethemed to match the terminal aesthetic:

- Wrapped in `.spectator-landing` so it inherits dark bg, monospace font, scanlines, CSS variables
- Table styled with dashed borders, teal accent headers, monospace text
- Column headers in uppercase muted text with letter-spacing
- Rows with subtle dashed separators
- Rating numbers in teal accent color
- Loading/error states in muted italic text
- No shadcn utilities — all terminal-native styling
- Centered content, max-width ~700px

## 3. Dev Page — Spectator Layout + Dev Controls Panel

The dev page mirrors the spectator layout:

- Same `.spectator-landing` wrapper for terminal aesthetic
- Same `100svh` viewport lock, no scrolling
- Same game-info bar below the nav
- Three-column grid: left thought panel | center board | right dev panel
- Left panel: Player A thought stream (placeholder, same as spectator)
- Center: HexBoard — identical component, same sizing as spectator
- Right panel: Dev controls replacing Player B thought stream
  - Seed input, Reset button
  - Random move, +5, +20 burst buttons
  - Game state readout (turn, active player, AP, unit counts, resources)
  - All styled in terminal aesthetic (monospace, dashed borders, teal accents)

The board rendering is identical to the spectator page — same component, same CSS, same sizing.

## Files affected

- `apps/web/src/routes/__root.tsx` — add shared nav bar
- `apps/web/src/routes/index.tsx` — extract game-info bar from the existing top bar, keep nav in root
- `apps/web/src/routes/leaderboard.tsx` — full restyle
- `apps/web/src/routes/dev.tsx` — rewrite to mirror spectator layout
- `apps/web/src/index.css` — add leaderboard styles, dev panel styles, shared nav styles

---

## Addendum (2026-02-18): Dev Tab API Replay Tools

This section captures **implemented changes after this design was written** so downstream agents do not regress the new `/dev` workflow.

### What changed on `/dev`

The dev page now supports two modes:

- `Sandbox` (existing behavior): local random/burst simulation.
- `API Replay` (new): load and replay real API-lane artifacts exported to a web JSON bundle.

### New `/dev` capabilities

- Replay source URL input (default: `/dev-replay/latest.json`).
- `Load Replay` and `Load Latest` actions.
- Match selector (choose a specific API match from the bundle).
- Replay controls: `Reset Match`, `Step`, `Play/Pause`, configurable step interval (`Step ms`).
- Action log panel (latest 200 actions) with concrete move text.
- Board animation path remains the same (`useArenaAnimator` + `HexBoard`) so visuals match spectator behavior.

### New data bridge from sim -> web

A new exporter script converts API benchmark artifacts into replay JSON for the web dev page:

- Script: `apps/sim/scripts/export-web-replay.ts`
- Output: `apps/web/public/dev-replay/latest.json`
- Source: latest (or specified) `apps/sim/results/benchmark_v2_*/api_lane/**/artifacts/*.json`

### New commands

In `apps/sim/package.json`:

- `pnpm -C apps/sim run export:web-replay`
- `pnpm -C apps/sim run benchmark:v2:api_full:viz`
- `pnpm -C apps/sim run benchmark:v2:api_smoke:viz`

`*:viz` commands run the lane and then publish replay JSON for `/dev`.

### Notes for future implementers

- This addendum does **not** replace the core visual restyle goals in this document.
- The replay workflow is intentionally file-based for simplicity and reliability in local dev.
- Live `agent_thought` streaming is still a separate server-side concern and not part of this replay bridge.
