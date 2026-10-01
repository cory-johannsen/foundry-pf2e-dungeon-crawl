# Resnap/Animation Race — Design

Tracks #87 (this session's continued live investigation, 2026-09-30).

## Problem

`resnapDriftedTokens` (`scripts/dungeon-follow.mjs:382`) reacts to every
position-changing `updateToken` event on a managed scene, self-healing any
token that lands off-grid (#141's own original fix for combat-time and
follow-time drift). It hands the actual correction off to `resnapTokenNow`
(`scripts/dungeon-follow.mjs:337`), which re-reads the token's *current*
`x`/`y`, rounds to the nearest grid cell, and writes the correction if it
isn't already grid-aligned — on the GM-direct path when the reacting client
is itself GM-privileged, or via `dungeon-remote.mjs`'s `resnapToken` relay
action (`scripts/dungeon-remote.mjs:71`) when the reacting client is the
run's non-GM host.

Every token-position write this module makes — `moveFollowersToward`'s own
"move" branch (`scripts/dungeon-follow.mjs`), and `dungeon-combat.mjs`'s
`stepToward` (`:2086`), `pushTokenAway` (`:2140`), and `strideByPosture`
(`:3254`) — is a single `token.update({x, y})` call using Foundry's default
animated slide (no `animation` option is passed; #352's attempt to pass
`{animation: {duration: 0}}` had to be reverted in #361 after it triggered
a Foundry v14 core crash — see #141). Foundry's animated `update()` does
not resolve the `TokenDocument`'s `x`/`y` fields synchronously with the
slide's visual completion: intermediate, fractional positions are visible
to hooks — including `resnapDriftedTokens` — while the animation is still
in flight.

**Live-confirmed this session** (module 0.54.1, monkeypatched
`TokenDocument.update()` capturing a call stack per write): a follower's
own legitimate, correctly-computed `moveFollowersToward` move began
animating, and `resnapDriftedTokens` fired mid-flight, read the
still-fractional position, rounded it to the follower's *starting* cell
(not its destination — the slide hadn't progressed far enough yet), and
"corrected" it back there. This silently cancels the follower's own
legitimate move. Because this happened on both the GM-direct path and the
relayed path independently and repeatedly, 6+ redundant resnap writes
landed within roughly 150ms of the original move, all converging back on
the pre-move cell. This is the confirmed root cause of the live-reported
symptom this investigation started from: two AI-controlled followers
stacking on the same grid cell (the follower whose move got cancelled
lands exactly on top of whichever follower already legitimately settled
there).

This is a distinct mechanism from, but tightly coupled to, the
already-known drift symptom #141 diagnosed (a token's own single-jump move
getting interrupted by a *later* move of *itself* before the first slide
finishes). Here, a *different* function — `resnapDriftedTokens`, #141's
own self-heal mechanism — is the one racing and cancelling a token's own
in-flight, legitimate move.

## Scope

Covers both call sites that trigger `resnapDriftedTokens`/`resnapTokenNow`:
follow-movement (`scripts/dungeon-follow.mjs`) and combat movement
(`scripts/dungeon-combat.mjs`). `resnapDriftedTokens` is already not gated
on combat state (deliberately, per its own existing doc comment) and hooks
every `updateToken` regardless of source, so combat's own single-jump
moves (`stepToward`/`pushTokenAway`/`strideByPosture`) are exposed to the
identical race even though it hasn't yet been live-reported there.

Out of scope: touching `token.update()`'s own animation/duration options
anywhere in this codebase. #352/#361's history (a crash-inducing Foundry
v14 core bug triggered by `{animation: {duration: 0}}`) rules this out as
a direction for this fix — the design below only ever *reads* Foundry's
own animation state, never writes to it. Also out of scope: the
already-known, separate self-interruption drift symptom (#141, still
open, unresolved) — that's a different mechanism (a token's own move
racing a *later* move of itself) and needs its own fix; this spec doesn't
attempt it, though the mechanism below (waiting for a token's own
animation to settle before treating it as at rest) may turn out to be
useful groundwork for that fix too, in a future session.

## Design

### Core mechanism: wait for the real animation state, not a guessed delay

Foundry v14 exposes `token.object.animationContexts` (a live `Map`,
confirmed non-empty while a token's slide is in progress and empty once it
settles — confirmed empirically this session against a live v14.368
world; not found in Foundry's public API docs, so treated as an
internal-but-relied-upon signal, the same category as this codebase's
existing `_movement.method`/`waypoints` handling elsewhere, which is
similarly confirmed-live-but-undocumented).

`resnapTokenNow` changes from "read position, correct immediately" to:
before reading the position to decide on a correction, poll
`token.object?.animationContexts` until it's empty, or until a defensive
cap elapses. Both the poll interval and the cap are named module
constants next to this file's existing `FOLLOW_DEBOUNCE_MS`, not inline
numbers — `RESNAP_POLL_MS = 100`, `RESNAP_MAX_WAIT_MS = 10000` (bumped
from an initial 3000 during the final review, see Testing below). Once
the animation is genuinely settled, it re-reads the token's *current*
`x`/`y` and decides whether a correction is still needed — exactly
today's existing check, just deferred until it's safe to trust.

**Revised 2026-10-01, live-confirmed bug in the original design:** if the
cap elapses while `isAnimating` is STILL true, this function does **not**
read a position and correct anyway — it bails without writing anything.
The original design said to "proceed with the correction anyway" on
cap-expiry; that was itself a bug, caught live: while still animating,
`token.x`/`token.y` is a mid-flight, client-side interpolated position,
not a committed resting point (the underlying document can't change every
render frame, so this reading is local animation state, not DB state).
Rounding and writing it back as a "correction" can only land *behind* the
token's real in-flight destination, overwriting legitimate newer
progress. This reproduces under ordinary play: a fast chain of real
leader steps (each one under `FOLLOW_DEBOUNCE_MS` apart) keeps
retargeting a follower before each prior slide settles, so
`animationContexts` never empties — the cap fires, reads the mid-flight
position, and snaps the follower back behind where it really was. Live
capture: a follower's real destination was a cell further down a
hallway; the cap fired, read the mid-flight position, and snapped the
follower back there — this *was* the "AI followers stuck behind the
door" symptom, not a separate bug. The cap now only ever means "give up
without guessing" — `resnapDriftedTokens` fires again on this token's own next
real update regardless, so a skipped attempt isn't a permanent miss.

**Revised again 2026-10-01 (round 2), the symptom still reproduced live
after round 1 shipped:** `isAnimating(token)` reporting false is *not* by
itself proof `token.x`/`token.y` holds the real, settled destination —
caught live reading a position ~24% of the way through a still-in-progress
slide, with `animationContexts` already empty at that exact instant.
Whatever internal Foundry mechanism clears `animationContexts` can
apparently do so slightly before the document's own x/y commits to its
final value — a race inside Foundry's own pipeline, separate from (and in
addition to) round 1's own cap-expiry bug. Fix: once a token has been seen
animating, a single "not animating" poll is no longer enough — require the
position to also be *unchanged* from the immediately preceding poll before
trusting it (two consecutive stable reads, not one). A token that was
never seen animating at entry still takes the original zero-delay fast
path — this only affects the polling branch, so it adds no latency to the
common already-settled case.

**Revised a third time 2026-10-01 (round 3), the real fix — round 2's own
premise was wrong:** an adversarial review of round 2, asked specifically
whether its own stability-check theory held up, went and read Foundry
v14's actual client source (`client/canvas/placeables/token.mjs`,
`#animateFrame`/`#completeAnimation`) rather than taking the live capture's
surface-level explanation at face value. It does not support round 2's
"animationContexts can clear slightly before x/y commits" theory: on a
normal animation finish, `#animateFrame` merges the final position into
the document and only then clears the animation context, in the same
synchronous step — no poll can land in between. What both rounds 1 and 2
actually missed: **`token.x`/`token.y` is the client-side, continuously
re-interpolated value Foundry's animation pipeline overwrites every
rendered frame while a slide is in progress — it was never the right field
to read for a drift/off-grid decision in the first place.**
`token._source.x`/`token._source.y` is the sealed, server-committed
position animation never touches, confirmed live (querying a real token's
own `_source` directly) and independently re-confirmed by reading
Foundry's own source for where it's assigned. Round 2's fix also still had
a gap round 1 shared: neither function's "fast path" (a token never seen
animating at entry) had *any* protection, and the one real way to get
`animationContexts` empty while `x`/`y` is stuck off its real value
(`stopAnimation({reset:false})`, used by e.g. token-HUD moves or undo) is
**permanent**, not a brief window either stability check could outlast.

The real fix: every position read in `resnapTokenNow`, `moveFollowersToward`'s
own inline snap-correction, and the `leaderCell`/`occupied` decisions
`moveFollowersToward` builds its candidate search from, now reads each
token's own `_source.x`/`_source.y`, never the top-level `x`/`y`. This
makes the whole "is it currently animating" question moot for correctness
— `_source` is unconditionally correct regardless of what the animation is
visually doing, so neither function needs to poll, wait, or check
animation state at all anymore. `RESNAP_POLL_MS`/`RESNAP_MAX_WAIT_MS` and
`isAnimating` are removed entirely; `token.object.animationContexts` is no
longer read anywhere in this file.

**Revised a fourth time 2026-10-01 (round 4), confirmatory review):**
`resnapDriftedTokens`'s own trigger gate still read `tokenDoc.x`/
`tokenDoc.y` (the animated value) instead of `_source` -- fixed to use
`_source` there too, since a gate decision made from the wrong field could
silently skip a needed correction indefinitely for any non-follower token.

**Revised a fifth time 2026-10-01 (round 5), the symptom STILL reproduced
live after round 4 shipped — the robust fix:** a fresh live capture
caught `resnapDriftedTokens` firing via Foundry's own incoming socket
handler (`#handleUpdateDocuments`) ~40ms after `moveFollowersToward` had
already *called* `token.update()` for a legitimate move -- and at that
exact instant, `tokenDoc._source` itself still read an off-grid value
that rounded back to the follower's STARTING cell, not its real
destination. Controlled live experiments (polling a token's own `_source`
during a genuinely animated move) could not pin down a precise,
reliably-reproducible window where `_source` lags a just-called
`update()` -- browser background-tab timer throttling made fine-grained
polling itself unreliable as a diagnostic technique -- but the live
production capture is unambiguous: `_source` is *not* guaranteed to
reflect this module's own just-issued write at every point in Foundry's
own multi-phase update/socket-confirmation lifecycle, however that
actually happens internally.

Four rounds each tried a different way to decide *when* a position read
is trustworthy (`animationContexts` once, `animationContexts` across two
polls, `_source`, `_source` in one more place) and each still left a
live-reproducible gap. Round 5 stops trying to answer that question at
all. `moveFollowersToward` now marks every token id it writes to (the
inline snap, and the real "move" write) in a small `recentlyWrittenByUs`
map (`tokenId -> Date.now()`); `resnapTokenNow`'s own correction write
marks it too. `resnapDriftedTokens` checks this map FIRST and returns
immediately, without reading any position field at all, for any token
written within the last `RECENT_WRITE_SUPPRESS_MS` (1000ms, generous
above any realistic animation plus socket round-trip) -- `resnapTokenNow`
re-checks the same map on entry too, since the relayed path
(`dungeon-remote.mjs`'s `resnapToken` action) reaches it directly,
bypassing `resnapDriftedTokens`'s own gate, and a non-GM host's own
client has no way to know this GM-privileged client just wrote to a
token (that bookkeeping only ever exists in `moveFollowersToward`'s own
local memory). This can only ever matter for genuine drift from OUTSIDE
this module's own control (a manual unsnapped drag, Foundry's own
internal nudging) -- exactly #141's original, narrower intent for this
self-heal hook in the first place.

`resnapDriftedTokens` itself is unchanged — it can still fire eagerly on a
mid-flight fractional position exactly as today; the fix is entirely in
`resnapTokenNow`'s own write-side logic, which both the GM-direct call and
the relayed `resnapToken` action already funnel through as their one
common choke point. `resnapTokenNow` already re-reads the token fresh from
the scene rather than trusting a caller-supplied value, so this applies
identically regardless of which path triggered it.

**Graceful degradation:** `token.object?.animationContexts` optional-chains
to `undefined` if `token.object` doesn't exist (an older Foundry version, a
system override, or a token not yet rendered on canvas) or if the API is
ever absent for any other reason. The poll treats `undefined` the same as
"empty" — zero wait, falls straight back to today's existing immediate
correction. If the animation-state signal isn't available, this fix simply
doesn't engage, rather than introducing a new failure mode.

**Token deleted mid-wait:** after the poll resolves, re-fetch the token
from the scene by id (`scene.tokens.find(...)`) rather than reusing the
reference captured before waiting, and no-op if it's gone.

**TOCTOU:** the final "animation is empty" check and the subsequent
`x`/`y` read that decides on a correction must happen in the same
synchronous continuation (no `await` between them) — otherwise a new move
could start in that exact gap and get judged against a stale reading.
Implementation detail, not a design gap, but one the implementer must get
right.

**Revised a sixth time 2026-10-01 (round 6), hardening round 5 before the
next live test, per a final adversarial review:** the review's Critical
Finding was that round 5's `recentlyWrittenByUs` map is purely per-client,
in-memory state — on this project's own documented architecture (a human
GM *and* a separate "Agent" GM-privileged account, both capable of running
`moveFollowersToward`/`resnapDriftedTokens` independently), two
simultaneously-connected GM clients would each have their own map with no
visibility into the other's writes, which could reproduce the original
symptom via a path round 5 doesn't cover. Live-checked directly against
the actual running session this investigation has used throughout (via
`game.users.contents`/`game.users.activeGM`): only one GM-privileged user
("Agent," role 4) was active; a second GM-capable account ("Gamemaster")
exists on this world but was not connected; the human player was
connected as a non-GM "Fighter" (role 2), matching this module's own
non-GM-host relay path, not a second GM client. This rules out the
multi-GM-client race as the cause of this session's own reproductions —
it remains a real, architecturally-possible gap worth closing if it's
ever seen live, but isn't what round 5 needed to fix here, so round 6
does not add `activeGM`-based gating speculatively.

Two smaller, concrete, risk-free hardenings from the same review, both
strictly additive to round 5's own protection:

1. **Re-mark after the write resolves, not just before.** All three write
   sites (`moveFollowersToward`'s inline #86 snap, its real "move" write,
   and `resnapTokenNow`'s own correction) called `markRecentlyWritten`
   immediately before `await token.update(...)`; round 6 also calls it
   again immediately after that `await` resolves. This extends the
   suppression window to cover however long the actual round-trip to the
   server and back takes, rather than only the gap between issuing the
   write and the call returning — relevant for the relayed, non-GM-host
   path in particular, where that round-trip is a real network hop rather
   than a same-process call.
2. **Diagnostic logging.** `resnapDriftedTokens` now accepts Foundry's own
   4th `updateToken` hook argument, `userId`, and logs it alongside the
   `changes` payload via `console.warn` whenever it proceeds past the
   `wasRecentlyWrittenByUs` check and finds a token genuinely off-grid.
   This changes no decision this function makes — it's observability
   only — but it means that if this symptom is ever caught live again,
   the very next capture shows definitively who/what actually committed
   the bad position, instead of requiring another round of monkeypatched
   call-stack capture to find out.

### Sibling bug found in the same review (2026-10-01): `moveFollowersToward`'s own inline #86 snap

`moveFollowersToward`'s own per-follower loop (`scripts/dungeon-follow.mjs`)
has always had its own inline off-grid snap-correction — an older, simpler
fix (#86) predating this whole investigation — that reads `token.x`/
`token.y`, rounds, and writes a correction, with **no animation check at
all**. This is the exact same bug shape as the cap-expiry bug above (a
mid-flight, client-interpolated position read and written back as if it
were committed), except it runs on *every single follow-cycle* a follower
is still animating from its own prior move — far more often than the
cap's once-per-10-seconds path, and so the more likely dominant cause of
the live-reported "stuck behind the door" symptom, not just a contributor.
Fixed in the same pass: skip the snap entirely while `isAnimating(token)`
is true. Nothing downstream depends on it having run first — the same
cycle's own `findFollowMove` call computes a grid-exact destination
regardless, from whatever position is currently readable.

### Reentrancy guard

The live capture showed 6+ overlapping resnap attempts for the same token
within ~150ms — both paths reacting independently with no guard, despite
`resnapDriftedTokens`'s own existing doc comment claiming "no separate
debounce or reentrancy guard needed" (this live evidence disproves that
claim). Add a module-scoped `Set<tokenId>` in `dungeon-follow.mjs`:
`resnapTokenNow` checks it first — if a correction is already pending for
this token id, return immediately rather than starting a second parallel
poll loop; otherwise add the id, run the poll-then-correct logic in a
`try`, and remove the id in a `finally` regardless of outcome (including
the token-deleted no-op case above).

**Accepted limitation, not solved here:** this guard is per-client
in-memory state, not cross-client. If two GM-privileged clients are
connected simultaneously (a human GM *and* the world's Agent-GM account —
an architecture this project already supports), each has its own guard
and could each independently run one correction attempt for the same
token. This is bounded and harmless, not incorrect: the second client's
attempt, once it gets around to reading the token's position, will see it
already grid-aligned (the first client's write already landed) and no-op
via the existing "already aligned" check. Building real cross-client
coordination would add meaningful complexity (e.g. routing through the
socket relay) for a residual case that's already self-limiting to at most
one extra, harmless, idempotent write — left out of this fix's scope.

## Testing

**Unit tests** (`tests/dungeon-follow.test.mjs`), reusing this file's
existing `makeToken`/`makeScene`/`installFoundryStubs`/
`vi.useFakeTimers()` fixtures:

- `makeToken` gains an optional `animationContexts` param, defaulting to
  an empty `Map` (assembled onto a `token.object = { animationContexts }`
  property the fixture doesn't currently have at all). Every existing test
  that doesn't pass this param keeps its token "never animating," so the
  new poll step short-circuits immediately — zero behavior change for
  every currently-passing test.
- A token with a non-empty `animationContexts` Map: assert
  `resnapTokenNow` does *not* write a correction yet; then clear the map
  (simulating the animation finishing) and advance fake timers past one
  `RESNAP_POLL_MS` interval; assert the correction *does* land afterward.
- A token whose `animationContexts` never empties: advance fake timers
  past `RESNAP_MAX_WAIT_MS`; assert **no** correction is written (revised
  2026-10-01 — the cap means "give up without guessing," not "correct
  anyway," per the live-confirmed bug above).
- Two concurrent `resnapTokenNow` calls for the same token id: assert only
  one `token.update()` call happens, not two (the reentrancy guard).
- Regression test for the actual live-reported bug: extend the existing
  chain-following corridor fixture (`describe("moveFollowersToward
  chain-following (#181)")`) so a follower's `animationContexts` is
  non-empty at the moment its own "move" write lands; assert
  `resnapTokenNow`/`resnapDriftedTokens` do not cancel it back to its
  starting cell.

**Live verification** (required before this ships — see Scope: this issue
family has already had two fixes ship, pass every automated and
scripted-update test, and still get reverted after failing under real
native movement):

1. Reproduce this session's exact narrow-corridor marching scenario (4
   AI-controlled followers, chain-following, #181) across several
   follow-cycles; confirm no two followers ever land on the same cell.
2. Confirm a genuinely drifted token (a manual, unsnapped drag in
   Foundry's own UI) still self-heals within a reasonable time — this fix
   must not make real drift-correction silently stop working.
3. Confirm combat movement (`stepToward`/`strideByPosture` mid-fight)
   completes cleanly and isn't snapped back mid-animation.
4. Watch actual `updateToken` traffic during a single leader move (e.g.
   via the same capture technique used this session) to confirm the
   redundant-write storm is gone — a small, bounded number of writes for
   one logical move, not 6+.
5. If steps 1-4 reveal `RESNAP_POLL_MS`/`RESNAP_MAX_WAIT_MS` need
   adjusting, tune them and re-verify rather than treating the proposed
   starting values as final.

## Success criteria

- In the exact live-reproduced scenario (4 AI-controlled followers in a
  1-wide corridor), no two followers land on the same cell across
  multiple follow-cycles.
- A follower's own legitimate, correctly-computed move is never cancelled
  by `resnapDriftedTokens` while it's still animating toward its
  destination.
- Genuine drift (a token that's actually off-grid, not mid-animation)
  still self-heals, just no longer prematurely during a legitimate move.
- The redundant-write storm (6+ resnap writes for one logical move) is
  gone or materially reduced.
- Combat-time single-jump movement (`stepToward`/`pushTokenAway`/
  `strideByPosture`) is equally protected, without any test or live
  verification showing new stuck/cancelled combat moves.
- No `token.update()` call anywhere in this codebase gains a new
  animation/duration option as part of this fix.
