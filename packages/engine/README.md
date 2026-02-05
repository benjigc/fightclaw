# @fightclaw/engine

**Engine Contract (MVP)**

Coordinate mapping (7×7 offset grid):
- External `HexCoord` is `{ q, r }` with each in `[-3..3]`.
- Map to grid indices via `row = r + 3`, `col = q + 3`.
- Board is rectangular 7×7; all row/col combinations are valid.

Odd-r neighbor rules (pointy-top, using `row/col`):
- If `row` is even, neighbors are `(col+1,row)`, `(col,row+1)`, `(col-1,row+1)`, `(col-1,row)`, `(col-1,row-1)`, `(col,row-1)`.
- If `row` is odd, neighbors are `(col+1,row)`, `(col+1,row+1)`, `(col,row+1)`, `(col-1,row)`, `(col,row-1)`, `(col+1,row-1)`.

Combat rules (simplified MVP):
- `attack > defense`: defender dies; attacker captures and moves into the hex if melee (`range = 1`).
- `attack == defense`: both die; the defender hex becomes neutral (`controlledBy = null`).
- `attack < defense`: attacker dies; no retreat.
- Ranged attacks never move the attacker.
- Defense includes terrain bonus and +1 if the defender is fortified.
- Phase-2 abilities (charge, adjacency, archer melee vulnerability) are intentionally omitted.
