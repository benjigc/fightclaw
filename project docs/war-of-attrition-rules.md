# War of Attrition (Arena 21x9) - Canonical Engine Spec v1

Last updated: 2026-02-05

This document is the single source of truth for the War of Attrition ruleset. Engine, server, and bots must implement *exactly* what is specified here. If any earlier design doc disagrees, this spec wins.

Related (non-canonical) docs:
- `project docs/game design/war-of-attrition-arena.md` (arena layout + inspiration)
- `project docs/game design/Hex Conquest-War of Attrition.md` (older 7x7 variant; superseded for this ruleset)

---

## 1. Core Goals

- Deterministic: no randomness; given the same starting state and the same move sequence, the outcome is identical.
- Explicit: no "interpretation required" details for adjacency, line-of-sight, capture timing, economy timing, or victory.
- Single ruleset: one canonical MoveSchema/action glossary.

---

## 2. Board + Coordinates

### 2.1 Board size

- Rectangular hex grid: **21 columns x 9 rows** = **189 hexes**.
- Hex IDs are `A1..I21`:
  - Rows: `A..I` (top to bottom)
  - Columns: `1..21` (left to right)

### 2.2 HexId format

`HexId := "<Row><Col>"`

Examples:
- `"A1"`, `"E11"`, `"I21"`

Parsing:
- `rowIndex = RowChar - 'A'` (0..8)
- `colIndex = Col - 1` (0..20)

### 2.3 Adjacency (odd-r offset, pointy-top)

Neighbors are defined using 0-based `(rowIndex, colIndex)` with **odd-r offset** rules. Only in-bounds neighbors exist.

If `rowIndex` is even, the neighbor deltas in `(dCol, dRow)` are:
- `( +1,  0)`
- `(  0, +1)`
- `( -1, +1)`
- `( -1,  0)`
- `( -1, -1)`
- `(  0, -1)`

If `rowIndex` is odd, the neighbor deltas are:
- `( +1,  0)`
- `( +1, +1)`
- `(  0, +1)`
- `( -1,  0)`
- `(  0, -1)`
- `( +1, -1)`

### 2.4 Distance

Hex distance is the length of the shortest path on the neighbor graph (BFS), ignoring terrain. Movement cost is always 1 per entered hex.

---

## 3. Hex Types + Terrain Effects

This spec uses explicit hex types so setup/victory can be derived from board data:

- `plains`
- `forest`
- `hills`
- `high_ground`
- `gold_mine`
- `lumber_camp`
- `crown`
- `stronghold_a` (Player A strongholds: `B2`, `H2`)
- `stronghold_b` (Player B strongholds: `B20`, `H20`)
- `deploy_a`
- `deploy_b`

### 3.1 Defense bonuses (defender only)

- `plains`: +0
- `deploy_a` / `deploy_b`: +0
- `gold_mine`: +0
- `lumber_camp`: +0
- `hills`: +1
- `forest`: +1
- `crown`: +1
- `high_ground`: +2
- `stronghold_a` / `stronghold_b`: +3

### 3.2 Resource nodes (reserves + tick yields)

Resource reserves are stored on the hex and persist across control changes.

- `gold_mine`
  - initial reserve: **20**
  - tick yield: `min(3, reserve)` gold
  - reserve decrement: by the yielded amount
- `lumber_camp`
  - initial reserve: **15**
  - tick yield: `min(2, reserve)` wood
  - reserve decrement: by the yielded amount
- `stronghold_a` / `stronghold_b`
  - no reserve (infinite)
  - tick yield: **+2 gold per controlled stronghold**
- `crown`
  - no reserve
  - tick yield: **+1 VP per tick while controlled**

If a reserve reaches 0, the hex remains its type but yields 0 (it is "exhausted" for UI).

---

## 4. Canonical Arena Terrain Layout

The canonical per-hex terrain is the "Detailed Hex Grid Reference" block below. It is copied verbatim from `project docs/game design/war-of-attrition-arena.md` to prevent transcription drift.

Token mapping from the block to this spec's hex types:
- `PLAINS` -> `plains`
- `FOREST` -> `forest`
- `HILLS` -> `hills`
- `HIGH_GROUND` -> `high_ground`
- `GOLD_MINE` -> `gold_mine` (reserve 20)
- `LUMBER` -> `lumber_camp` (reserve 15)
- `CROWN` -> `crown`
- `STRONGHOLD_A` -> `stronghold_a`
- `STRONGHOLD_B` -> `stronghold_b`
- `DEPLOY_A` -> `deploy_a`
- `DEPLOY_B` -> `deploy_b`

```
ROW A:
  A1=DEPLOY_A   A2=DEPLOY_A   A3=DEPLOY_A   A4=PLAINS     A5=FOREST     A6=PLAINS     A7=PLAINS
  A8=HILLS      A9=PLAINS     A10=PLAINS    A11=PLAINS    A12=PLAINS    A13=PLAINS    A14=HILLS
  A15=PLAINS    A16=PLAINS    A17=FOREST    A18=PLAINS    A19=DEPLOY_B  A20=DEPLOY_B  A21=DEPLOY_B

ROW B:
  B1=DEPLOY_A   B2=STRONGHOLD_A   B3=DEPLOY_A   B4=PLAINS     B5=PLAINS     B6=HILLS      B7=FOREST
  B8=PLAINS     B9=GOLD_MINE      B10=PLAINS    B11=HILLS     B12=PLAINS    B13=GOLD_MINE B14=PLAINS
  B15=FOREST    B16=HILLS         B17=PLAINS    B18=PLAINS    B19=DEPLOY_B  B20=STRONGHOLD_B  B21=DEPLOY_B

ROW C:
  C1=DEPLOY_A   C2=DEPLOY_A   C3=DEPLOY_A   C4=FOREST     C5=PLAINS     C6=PLAINS     C7=PLAINS
  C8=LUMBER     C9=PLAINS     C10=FOREST    C11=PLAINS    C12=FOREST    C13=PLAINS    C14=LUMBER
  C15=PLAINS    C16=PLAINS    C17=PLAINS    C18=FOREST    C19=DEPLOY_B  C20=DEPLOY_B  C21=DEPLOY_B

ROW D:
  D1=DEPLOY_A   D2=DEPLOY_A   D3=PLAINS     D4=PLAINS     D5=HILLS      D6=GOLD_MINE  D7=PLAINS
  D8=PLAINS     D9=FOREST     D10=PLAINS    D11=HIGH_GROUND   D12=PLAINS    D13=FOREST    D14=PLAINS
  D15=PLAINS    D16=GOLD_MINE D17=HILLS     D18=PLAINS    D19=PLAINS    D20=DEPLOY_B  D21=DEPLOY_B

ROW E:
  E1=LUMBER     E2=PLAINS     E3=PLAINS     E4=FOREST     E5=PLAINS     E6=PLAINS     E7=HILLS
  E8=FOREST     E9=PLAINS     E10=GOLD_MINE E11=CROWN     E12=GOLD_MINE E13=PLAINS    E14=FOREST
  E15=HILLS     E16=PLAINS    E17=PLAINS    E18=FOREST    E19=PLAINS    E20=PLAINS    E21=LUMBER

ROW F:
  F1=DEPLOY_A   F2=DEPLOY_A   F3=PLAINS     F4=PLAINS     F5=HILLS      F6=GOLD_MINE  F7=PLAINS
  F8=PLAINS     F9=FOREST     F10=PLAINS    F11=HIGH_GROUND   F12=PLAINS    F13=FOREST    F14=PLAINS
  F15=PLAINS    F16=GOLD_MINE F17=HILLS     F18=PLAINS    F19=PLAINS    F20=DEPLOY_B  F21=DEPLOY_B

ROW G:
  G1=DEPLOY_A   G2=DEPLOY_A   G3=DEPLOY_A   G4=FOREST     G5=PLAINS     G6=PLAINS     G7=PLAINS
  G8=LUMBER     G9=PLAINS     G10=FOREST    G11=PLAINS    G12=FOREST    G13=PLAINS    G14=LUMBER
  G15=PLAINS    G16=PLAINS    G17=PLAINS    G18=FOREST    G19=DEPLOY_B  G20=DEPLOY_B  G21=DEPLOY_B

ROW H:
  H1=DEPLOY_A   H2=STRONGHOLD_A   H3=DEPLOY_A   H4=PLAINS     H5=PLAINS     H6=HILLS      H7=FOREST
  H8=PLAINS     H9=GOLD_MINE      H10=PLAINS    H11=HILLS     H12=PLAINS    H13=GOLD_MINE H14=PLAINS
  H15=FOREST    H16=HILLS         H17=PLAINS    H18=PLAINS    H19=DEPLOY_B  H20=STRONGHOLD_B  H21=DEPLOY_B

ROW I:
  I1=DEPLOY_A   I2=DEPLOY_A   I3=DEPLOY_A   I4=PLAINS     I5=FOREST     I6=PLAINS     I7=PLAINS
  I8=HILLS      I9=PLAINS     I10=PLAINS    I11=PLAINS    I12=PLAINS    I13=PLAINS    I14=HILLS
  I15=PLAINS    I16=PLAINS    I17=FOREST    I18=PLAINS    I19=DEPLOY_B  I20=DEPLOY_B  I21=DEPLOY_B
```

---

## 5. Players, Resources, and Units

### 5.1 Player resources

Each player has:
- `gold` (integer, >= 0)
- `wood` (integer, >= 0)
- `vp` (integer, >= 0)

There are no caps in v1.

### 5.2 Units

Unit types:
- `infantry`
- `cavalry`
- `archer`

All units:
- occupy exactly one hex
- stacking is not allowed (at most one unit per hex)

### 5.3 Unit stats and abilities (canonical)

Infantry:
- cost: 10 gold
- attack: 2
- defense: 4
- movement: 1
- range: 1
- Shield Wall: if defending and adjacent to friendly Infantry, +1 DEF per adjacent infantry, max +2

Cavalry:
- cost: 18 gold
- attack: 4
- defense: 2
- movement: 3
- range: 1
- Charge: if the cavalry performed a `move` action this player-turn with `movedDistance >= 2` and the move had a forest-free shortest path, add +2 ATK for its next attack this player-turn

Archer:
- cost: 14 gold
- attack: 3
- defense: 1
- movement: 2
- range: 2
- Melee Vulnerability: when defending against a melee attack (distance=1), DEF -= 1 (floor at 0)

Fortify (status):
- bonus: +2 DEF while fortified
- duration: until the start of that unit owner's next player-turn tick
- additional restriction: a unit cannot `move` or `attack` in the same player-turn after it fortifies (fortify consumes the unit's per-turn action budget)

Per-unit limits (per player-turn):
- a unit may perform at most **one** `move` action
- a unit may perform at most **one** `attack` action
- `fortify` requires the unit has not moved and has not attacked this player-turn

---

## 6. Fixed Starting State (No Draft/Deploy)

### 6.1 Match start

- Turn = 1 (full round)
- Active player = Player A
- Before Turn 1 Player A acts:
  - Player A gold=0, wood=0, vp=0
  - Player B gold=0, wood=0, vp=0

### 6.2 Starting control

Initial `controlledBy` values:
- all `deploy_a` and `stronghold_a` hexes are controlled by `A`
- all `deploy_b` and `stronghold_b` hexes are controlled by `B`
- all other hexes: `controlledBy = null`

### 6.3 Starting units

Units are deterministically created in this order:

Player A:
- `A-1` infantry at `B2`
- `A-2` infantry at `H2`
- `A-3` infantry at `G2`
- `A-4` cavalry at `B3`
- `A-5` cavalry at `H3`
- `A-6` archer at `C2`

Player B:
- `B-1` infantry at `B20`
- `B-2` infantry at `H20`
- `B-3` infantry at `G20`
- `B-4` cavalry at `B19`
- `B-5` cavalry at `H19`
- `B-6` archer at `C20`

All starting units:
- are not fortified
- have not moved or attacked this player-turn
- are allowed to act when their owner is active

---

## 7. Turn Structure (AP + Start Tick + End Turn)

Constants:
- `ACTIONS_PER_TURN = 3`
- `TURN_LIMIT = 30` (full rounds)

Turn numbering:
- `turn` increments **only** after Player B ends their player-turn.

### 7.1 Start-of-player-turn tick (automatic)

Runs exactly once when a player becomes active:

1. Reset the active player's units:
   - clear fortify on that player's units
   - clear per-turn flags (move/attack availability, move distance)
   - newly recruited units become eligible to act now
2. Economy + VP tick for the active player based on current `controlledBy`:
   - gold mines: add gold and deplete reserves
   - lumber camps: add wood and deplete reserves
   - strongholds: +2 gold each stronghold controlled by active player
   - crown: +1 VP if controlled by active player
3. Set `actionsRemaining = ACTIONS_PER_TURN`.

### 7.2 Action phase

The active player submits actions until:
- they choose `end_turn`, or
- `actionsRemaining` reaches 0 (automatic end of player-turn).

### 7.3 End-of-player-turn resolution (automatic)

When the player-turn ends:

1. Control update (capture-on-end-turn):
   - for every occupied hex, set `controlledBy = unit.owner`
   - empty hexes keep their current `controlledBy` (sticky control)
2. Check immediate victory:
   - stronghold capture
   - elimination
3. Switch active player:
   - if A ended: active becomes B, `turn` unchanged
   - if B ended: active becomes A, `turn += 1`
4. If the match has not ended and the `turn` became 31 (i.e., `turn > TURN_LIMIT`), apply timeout victory (Section 10.3).
5. Immediately run the next active player's Start-of-player-turn tick so the next player sees a "turn-started" state.

---

## 8. Control Rules

Definition: A player **controls** a hex if `hex.controlledBy == player`.

How control changes:
- Control is updated only at end-of-player-turn (capture-on-end-turn).
- A unit occupying a hex at end-of-player-turn sets that hex's `controlledBy` to the unit owner.
- Control persists when unoccupied until changed by an occupied end-of-turn update or by combat tie neutralization.

Special: Combat tie neutralization
- If an attack results in a tie (attack == defense), the defender hex becomes `controlledBy = null` immediately (even if it was previously controlled).

---

## 9. Actions + MoveSchema (Canonical Glossary)

All actions are deterministic and validated strictly.

### 9.1 MoveSchema (wire)

```ts
type HexId = string; // "A1".."I21"

type Move =
	| { action: "move"; unitId: string; to: HexId; reasoning?: string }
	| { action: "attack"; unitId: string; target: HexId; reasoning?: string }
	| { action: "recruit"; unitType: "infantry" | "cavalry" | "archer"; at: HexId; reasoning?: string }
	| { action: "fortify"; unitId: string; reasoning?: string }
	| { action: "end_turn"; reasoning?: string }
	// Legacy alias (migration-only): treated identically to end_turn
	| { action: "pass"; reasoning?: string };
```

### 9.2 AP costs

- `move`: 1 AP
- `attack`: 1 AP
- `recruit`: 1 AP + gold cost
- `fortify`: 1 AP + 1 wood
- `end_turn` / `pass`: 0 AP (ends player-turn immediately)

### 9.3 Move (unit movement)

Legal if:
- unit exists and is owned by active player
- unit is allowed to act this player-turn
- unit has not performed a move action this player-turn
- destination is in bounds and unoccupied
- there exists a path of length <= unit movement
- path cannot pass through occupied hexes

The move distance used for Cavalry Charge is the shortest-path length used to validate the move.

### 9.4 Attack (unit combat)

Legal if:
- attacker exists, owned by active player, and allowed to act
- attacker has not attacked this player-turn
- target hex contains an enemy unit
- distance is <= attacker range
- for archers at range 2, line-of-sight rules must pass (Section 9.7)

Melee (distance 1) and ranged (distance 2) use the same deterministic compare (Section 9.8).

### 9.5 Recruit (spawn)

Legal if:
- `at` is a stronghold hex (`stronghold_a` or `stronghold_b`)
- `at` is controlled by active player
- `at` is unoccupied
- player has enough gold for the unit type

Recruited units:
- appear on the `at` hex
- cannot act until the next time their owner becomes active (start-of-turn tick)

### 9.6 Fortify

Legal if:
- unit exists and is owned by active player
- unit has not moved or attacked this player-turn
- unit is not already fortified
- player has at least 1 wood

Effects:
- wood -= 1
- unit becomes fortified (+2 DEF) until start of its owner's next player-turn tick
- unit cannot move or attack later in the same player-turn (fortify consumes the unit's per-turn action budget)

### 9.7 Archer range-2 line of sight (LoS)

Range-2 attacks are only legal if:
- `distance(attacker, target) == 2`
- attacker and target are in a "straight line":
  - compute `sharedNeighbors = intersection(neighbors(attacker), neighbors(target))`
  - LoS requires `sharedNeighbors.length == 1`
  - define `midHex` as that single shared neighbor

LoS blocking:
- if `targetHex` is `forest`: blocked
- if `midHex` is `forest`: blocked
- if `midHex` contains any unit: blocked unless attacker is on `high_ground`
- high ground does not bypass forests

### 9.8 Combat resolution (deterministic)

For an `attack` action:

1. Compute `attackPower`:
   - base ATK
   - +2 if cavalry charge conditions are satisfied
2. Compute `defensePower`:
   - base DEF
   - + terrain defense bonus of the defender hex
   - +2 if defender is fortified
   - + Shield Wall adjacency (infantry only), max +2
   - -1 if defender is archer and the attack is melee (distance 1), floor at 0
3. Resolve:
   - if `attackPower > defensePower`: defender dies; attacker survives
     - if melee: attacker moves into defender hex
   - if `attackPower == defensePower`: both die; defender hex becomes neutral (`controlledBy = null`)
   - if `attackPower < defensePower`: attacker dies; defender survives

Ranged attacks never move the attacker.

---

## 10. Victory Conditions

### 10.1 Stronghold capture (instant)

After end-of-player-turn control update:
- Player A wins if both `B20` and `H20` are controlled by A.
- Player B wins if both `B2` and `H2` are controlled by B.

### 10.2 Elimination (instant)

If a player has 0 units remaining, they lose immediately.
If both have 0, the game is a draw.

### 10.3 Timeout (after Turn 30)

After Player B ends Turn 30 (i.e., at the moment `turn` would become 31), if no instant victory occurred:

1. Higher VP wins.
2. Tiebreaker: higher remaining unit value wins (sum of gold costs of remaining units).
3. Tiebreaker: higher controlled hex count wins (`controlledBy == side`).
4. Otherwise: draw.

---

## 11. Determinism Requirements (Non-Negotiable)

- Any function that enumerates moves or iterates board/units must use a stable ordering (e.g., lexical unitId, HexId order).
- For validation that depends on paths (movement), legality depends only on existence of at least one valid shortest path under the rules.
- No RNG in combat, income, reserve depletion, capture, or victory.
