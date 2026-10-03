# #406 — Drop minimum Foundry version below v14

## Goal
Stop claiming Foundry v13 support; require v14+.

## Changes
- `module.json`: `compatibility.minimum` `"13"` → `"14"`.
- `README.md` lines 3 and 15, `package.json` description: "v13" → "v14".
- Bump `module.json` version (patch).

## Audit result
No v13-specific fallback code exists (no `game.release`/`isNewerVersion`/version branches in `scripts/`, `tools/`).

## Out of scope
`{ teleport: true }` (`dungeon-follow.mjs`, `dungeon-combat.mjs`) is a Foundry-deprecated shim (since v13, removal in v15). It is load-bearing for the #87/#141 token-drift fixes and is not v13 compatibility code; replacing it is a behavior change needing live playtesting, so it is tracked as a separate follow-up issue.
