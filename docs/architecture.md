# Architecture

PF2e Dungeon Crawl is a GM-less-capable dungeon-crawl subsystem for
Pathfinder 2E: procedurally sequenced rooms, encounter generation, traps,
puzzles, skill challenges and combat AI, driven by a swappable generator
interface (`module.json`'s own description). This doc is a living view of
how the ~40 files under `scripts/` and `tools/agent-service/` relate to each
other — see "Keeping this current" below for how it stays that way. The
point-in-time feature specs under `docs/superpowers/specs/` remain useful
for *why* a given design was chosen, but they document history, not
today's shape; this doc documents today's shape.

## The pure-logic / Foundry-glue pairing convention

The single most important structural fact about this codebase: nearly
every room-kind mechanic is split into two files, repeated deliberately
across the module rather than being a one-off pattern:

- A **pure-logic** file with no Foundry dependency at all — plain
  functions over plain data, fully unit-testable without a live world.
  `dungeon-deck.mjs`, `trap-mechanics.mjs`, `puzzle-mechanics.mjs`,
  `skill-challenge-mechanics.mjs`, `treasure.mjs`, `room-feature-tokens.mjs`, `agent-candidates.mjs`,
  `maneuver-feat-modifiers.mjs`, `npc-ability-parse.mjs`, `npc-ability-overrides.mjs`, `npc-move-parse.mjs`, `npc-strike-shapes.mjs`, `npc-self-parse.mjs`, `self-effect-denylist.mjs`, `self-effect-summary.mjs`,
  `targeted-feat-actions.mjs`, `marked-target-requirements.mjs`, `antagonize.mjs`, `npc-reactions.mjs`, `combat-rewards.mjs`, `dungeon-follow-mechanics.mjs`, `cover-items.mjs`,
  `encounter-deck.mjs`, `dungeon-layout.mjs`, and `dungeon-retreat.mjs` are all this shape.
- A **Foundry-glue** file that touches `game`/`Actor`/`ChatMessage`/`Scene`
  and calls into its pure sibling for the actual decision logic.
  `dungeon-scene.mjs`, `trap-combat.mjs`, `puzzle.mjs`,
  `skill-challenge.mjs`, `dungeon-combat.mjs`, `foundry-api.mjs`,
  `dungeon-follow.mjs`, and `scripts/ui/dungeon-app.mjs` are this shape.

This split matters for anyone touching test coverage: the pure-logic half
of a pair is thoroughly unit-tested (dozens of `tests/*.test.mjs` files
exist for exactly these), while the Foundry-glue half generally has **no**
unit test coverage at all — `dungeon-scene.mjs`, `trap-combat.mjs`, and
`scripts/ui/dungeon-app.mjs` each have zero tests, confirmed while fixing
issues #56, #60, and #65 in this same repo. That's not an oversight to
fix; it's the accepted cost of the split. A change to glue-layer behavior
gets verified by direct code review and, where possible, against a live
Foundry world via the `foundry-rest` skill — not by adding a mock-heavy
unit test that would mostly just be testing the mock.

## Subsystems

**Dungeon generation / sequencing** (`dungeon-deck.mjs`,
`dungeon-layout.mjs`, `dungeon-reseed.mjs`, `dungeon-stub-oracle.mjs`, `dungeon-retreat.mjs`, `corridor-pieces.mjs`, `prng.mjs`) — the abstract room sequence (kind,
order, which setpiece each room draws) and the grid-unit room geometry,
both fully deterministic from a seed, both Foundry-free. (`dungeon-reseed.mjs`, #490, is the exception: it builds
each new run's layout and, if the goal is unreachable, retries seeds `<seed>~r1..r20` by checking a scratch scene
built with `dungeon-scene.mjs`; `dungeon-stub-oracle.mjs`, #427 Chunk 7, finds the edges that scene cannot walk and plans the
rubble stubs that replace them. A run stamped `topologyRouting` (#427, new v3 runs) also has its corridors routed around
each other by `routeEdgesTopologyAware`; the scene, the reseed and the stub/wall planner all read the one `routingForLayout`.
`corridor-pieces.mjs`, #823, is a pure lookup the scene reads: it picks each corridor cell's art piece (single / end / mid / corner)
from which of its sides continue to another cell of the same corridor, so joints and bends never draw a wall across an open corridor.)

**Foundry scene building** (`dungeon-scene.mjs`, `foundry-api.mjs`,
`placement.mjs`, `data-loader.mjs`, `dungeon-sound.mjs`/`audio.mjs`) —
turns the abstract sequence into a real Foundry `Scene`: walls, floor art,
reveal doors, and (lazily, one room at a time as the party reaches each
door) each room's actual spawned content.

**Encounter generation** (`encounter-generator.mjs`, `encounter-deck.mjs`,
`encounter-roster.mjs`, `generator-registry.mjs`, `default-generator.mjs`,
`creature-art.mjs`, `trait-picker.mjs`, `cover-items.mjs`) — the abstract
Encounter Deck (level-relative math, no bestiary knowledge) resolved
against the live PF2e bestiary into real creatures, behind a swappable
`generator-registry.mjs` contract so another module could supply its own
sequencing/roster logic without this one caring.

**Combat automation** (`dungeon-combat.mjs`, `stealth-detection.mjs`,
`combat-rewards.mjs`, `agent-candidates.mjs`, `agent-action-display.mjs`, `maneuver-feat-modifiers.mjs`,
`npc-ability-parse.mjs`, `npc-ability-overrides.mjs`, `npc-move-parse.mjs`, `npc-strike-shapes.mjs`, `npc-self-parse.mjs`, `self-effect-denylist.mjs`, `self-effect-summary.mjs`,
`targeted-feat-actions.mjs`, `marked-target-requirements.mjs`, `antagonize.mjs`, `npc-reactions.mjs`, `dungeon-strike-riders.mjs`, `dungeon-critical-deck.mjs`,
`flanking-indicator.mjs`, `dungeon-leveling.mjs`) — wires a spawned encounter into a real PF2e
`Combat`, and auto-applies whatever Critical Hit/Fumble Deck directives
parse cleanly. For an `agentControlled` combatant's turn,
`autoPlayCombatantTurnIfDue` races two things: `armAgentTimeout` (a pure
safety-net timeout, unchanged since before this subsystem existed) against
`runAgentDecisionLoop`, an in-process decide-apply loop that calls the
hosted agent service (below) directly over `fetch()`. If the service
doesn't answer in time, errors, or isn't configured, the timeout fires and
`playHeuristicTurn` (pure candidate-scoring logic, no LLM) takes the turn
instead — the module always has a working fallback with no hardcoded LLM
dependency of its own. `stealth-detection.mjs` (#616, pure) holds the PF2e
rules for Stealth initiative and per-hostile detection (unnoticed /
undetected / hidden / observed, Seek outcomes); `startCombat` stores the
resulting matrix on the Combat document and `combatantTargets` filters
hostile targeting through it. `antagonize.mjs` (#920, pure, reads the
same detection states) holds the Antagonize Frightened-floor rules that
`dungeon-combat.mjs`'s #943 end-of-turn Frightened decay consults; the
floors themselves live in an actor flag that chat-message, turn-change,
`deleteItem` and `deleteCombat` hooks create and clear. `flanking-indicator.mjs` (#769) is separate from
that turn-taking path: a client-side, write-nothing "Flanked" badge drawn
on flanked tokens in a started combat, using PF2e's own `Token#isFlanking`.
Every action `applyAgentDecision` executes is appended to the Combat's
`agentLog` flag and shown on one consolidated chat card per AI combatant
per round (#925): `agent-action-display.mjs` (pure) turns each executor's
own return value into the public row text and renders the card HTML, with
the model's rationale and other GM-only details in `data-visibility="gm"`
elements that PF2e strips for non-GM clients.
NPC reactions (#931, generalizing #202's Reactive Strike) are a registry:
`npc-reactions.mjs` (pure) holds `REACTION_DEFS` (Reactive Strike/Attack of
Opportunity, Twisting Tail, Wing Rebuff, Shield Block, Wing Deflection,
Ghost Dodge, Swat Projectile), the move-trigger and degree-of-success
arithmetic, and the hybrid decision (a creature's single eligible reaction
is decided by its policy; several go to the agent service's
`/v1/combat-decision` with a 5 s timeout, falling back to priority order).
`dungeon-combat.mjs` owns the gates (reach, line of sight, detection, one
reaction per round), the trigger paths (AI Strides mid-walk, a player's
`moveToken` move, ranged Strikes, attack-roll and damage-roll chat
messages, the module's own Strike executors) and the executors, including
the GM-confirm card used for player attacks when a human GM is present.

**Hosted agent service** (`scripts/agent-service-client.mjs`,
`scripts/dungeon-customization-fulfillment.mjs`,
`tools/agent-service/*`) — replaces what used to be an external polling
process (`tools/agent-loop/poll.mjs`) and an interactive-MCP-session flow
(`tools/agent-loop/mcp-server.mjs`); both are retired. `tools/agent-service/`
is a persistent, self-hosted `node:http` service (`server.mjs`, wrapping
the `providers/litellm.mjs`/`providers/laya.mjs` adapters,
`customization-generator.mjs`, and `candidate-generator.mjs`) that talks to a sidecar `litellm` proxy
(deployed alongside it via `docker-compose.yml`) rather than any model
provider directly. `providers/litellm.mjs` and `customization-generator.mjs`
both route requests through the shared `node-fetch.mjs` transport and pick
a model tier (`fast` vs `reasoning`, litellm's own aliases, configured in
`litellm-config.yaml`) via the pure `tier-selection.mjs` classifier —
`litellm` is the default combat-decision provider, `laya` remains
selectable via `PF2EDC_AGENT_PROVIDER=laya`. `candidate-generator.mjs`
(#909) is the litellm-only "reasoning model" stage that picks a tactical
subset of a Foundry-enumerated maneuver and feat/class-action (#910:
stances, Rage, Sudden Charge, Lunge, Twin Feint; #914: any one-action/free
self-effect that passes a derived safety filter plus the reviewed
`self-effect-denylist.mjs`, labelled by the pure `self-effect-summary.mjs`;
#922: Hunt Prey and Devise a Stratagem, whose effect the pure
`targeted-feat-actions.mjs` binds to the chosen opponent's token through
the system's own `TokenMark` rule; #946 widened it to every marked-target
effect `targeted-feat-actions.mjs` classifies as `marked` and whose feat
prose gives a checkable target constraint -- Smite, Duelist's Challenge,
Size Up -- read by the pure `marked-target-requirements.mjs`, which folds
onto `npc-self-parse.mjs`'s closed requirement grammar; it also admits
target-conditional self-effects like Point Blank Stance, gated by their own
Requirements, and ends a mark when its creature is defeated or leaves)
and NPC save-ability (#915: save-based, no-damage monster abilities
recognized from their @Check/@Template/condition-link text by the pure
`npc-ability-parse.mjs`; applied automatically when every outcome parses,
rolled and reported to the GM otherwise; #935 widened it with an
inline-outcome grammar, penalty outcomes applied as synthesized effect
items, target filters, and the reviewed per-ability override table
`npc-ability-overrides.mjs`, guarded by a golden-file coverage audit) and NPC movement-ability (#932:
Gallop, Swift Leap, Swoop, Eagle Dive, Phase Jump and the like, recognized
by the pure `npc-move-parse.mjs` closed grammar; `dungeon-combat.mjs` plans
the route, Strike point or teleport square and resolves move-triggered
reactions at the square they fire on) and NPC Strike-plus (#933: Death
Roll, Constrict, Gnaw, Wide Swing, Broad Swipe, Mangling Rend, Hurl Net,
Rend and the like, recognized by the pure `npc-strike-shapes.mjs` named
shapes, which reuse `npc-ability-parse.mjs`'s degree grammar; the grab
follow-ups read the who-grabbed-whom record `dungeon-strike-riders.mjs`
keeps on the Combat) and NPC self-buff/self-heal (#934: Form a Phalanx,
Reef Armor, Thesis Shield, Feed on Fear, Self-Repair and the like,
recognized by the pure `npc-self-parse.mjs` from a structural selfEffect,
a linked bestiary effect or a healing enricher, with a closed requirement
predicate set; `dungeon-combat.mjs` checks the linked effect's rules and
the requirements on the board) vocabulary, with a
response schema built per request from that vocabulary; Foundry
re-validates every pick against it before it becomes a candidate. Exposes
`GET /v1/health`, `POST /v1/combat-decision`, `POST /v1/flavor-customization`,
and `POST /v1/combat-candidates` behind a bearer token. Foundry's own client-side code calls it directly — no relay,
no local process a GM has to keep alive — via
`scripts/agent-service-client.mjs` (a thin fetch wrapper) from two call
sites: `dungeon-combat.mjs`'s `runAgentDecisionLoop` (combat decisions, plus
once per turn the maneuver/feat picks when the turn's combined vocabulary
is non-empty, see above) and `scripts/dungeon-customization-fulfillment.mjs`'s
`fulfillPendingCustomizations` (fire-and-forget trap/skill-challenge/
puzzle/narrative flavor text, called fire-and-forget from `ui/dungeon-app.mjs`'s
`startDungeonRun` once full pregeneration has built every room and left its
content pending, rather than waiting on an interactive session to check in).

**Puzzle / trap / skill-challenge / treasure mechanics**
(`puzzle-mechanics.mjs`+`puzzle.mjs`,
`trap-mechanics.mjs`+`trap-combat.mjs`+`trap-library.mjs`,
`skill-challenge-mechanics.mjs`+`skill-challenge.mjs`, `treasure.mjs`, `choice-set.mjs` (pre-picks a PF2e `ChoiceSet` rule element's choice for treasure items and spawned actors, #897),
`narrative-mechanics.mjs`, `room-feature-tokens.mjs`, `room-feature-art.mjs`, `room-feature-check.mjs`) — one pure/glue pair per room-kind mechanic
(see the convention above), each built from real PF2e compendium content
(`pf2e.hazards`, `pf2e.rollable-tables`) rather than inventing new game
data.

`trap-combat.mjs` also resolves a no-strike hazard whose action is a basic
save plus structured damage (#839): `trap-mechanics.mjs` parses it, and
`trap-combat.mjs` finds every creature in the hazard's area using
`pathfinding.mjs`'s wall-aware `hasLineOfSight`, so a wall blocks the effect
the same way it blocks movement.

Clicking a puzzle or skill-challenge room-feature token (#822) reveals it
and then offers the attempt through `room-feature-check.mjs`'s
`promptRoomFeatureCheck` (Foundry-free, collaborators injected by
`module.mjs`), which opens `ui/puzzle-stage-dialog.mjs` or
`ui/skill-challenge-dialog.mjs` (mirroring #754's `ui/trap-disable-dialog.mjs`)
and runs the same `attemptPuzzleStageFor`/`attemptSkillChallengeFor` logic
(exported from `ui/dungeon-app.mjs`) that the tracker window's own forms use.
A non-GM player's attempt is relayed as `attemptPuzzleStage`/`attemptSkillChallenge` (widened like `attemptTrapDisable`, rolled and recorded on the GM client after `userMayAttemptRoomFeatureCheck` re-validation), never as a self-reported outcome.

**GM-less relay & permissions** (`dungeon-remote.mjs`,
`dungeon-permissions.mjs`, `player-choice.mjs`, `choice-prompts.mjs`) —
every mutating dungeon-crawl action still only ever runs on a genuinely
GM-privileged client (a human GM, or a client logged in as the world's
"Agent" GM account). `dungeon-permissions.mjs` decides whether a client
should render interactive vs. read-only and whether a routed request
should be honored; `dungeon-remote.mjs` is the actual relay — a non-GM
host's client calls `requestDungeonAction(actionName, args)`, which
socket-emits a request that only a GM-privileged client picks up,
executes, and acks back. Nearly every mutating action in `dungeon-app.mjs`
already routes through this. `dungeon-follow.mjs` didn't, until #65 fixed
it today — see Party-follow below.

**Party-follow** (`dungeon-follow.mjs`, `dungeon-follow-mechanics.mjs`,
`token-walk.mjs`) —
moves AI-controlled party members toward the leader's token between
fights. The pure half computes a single step of pathfinding-aware
movement; the glue half hooks `updateToken`/`updateWall` and, since #65,
falls back to the GM-less relay above when the client reacting to the
hook isn't itself GM-privileged but is the run's own host. Since #181,
each follower's own target is whoever is immediately ahead of it in the
run's `marchingOrder` (`dungeon-runner.mjs`'s `effectiveMarchingOrder`),
not always the leader directly — this chain-following is what lets
followers queue single-file through a corridor too narrow for more than
one of them to be near the leader at once. Since #610, a follower walks its
found path one cell per `move({action: "displace"})` write with the
`movementStepDelayMs` pause between hops, via `token-walk.mjs` — the leaf
module (shared with `dungeon-combat.mjs`, #479) that owns that hop-by-hop
write loop, so neither file imports the other.
Also since #610, each follower aims for its own slot on the leader's
reconstructed route (`extendTrail`/`findTrailMove` in
`dungeon-follow-mechanics.mjs`; a per-scene trail kept by
`dungeon-follow.mjs`) instead of the nearest free cell near the one ahead,
falling back to that chain-following whenever the trail can't place it.

**Run state & UI** (`dungeon-runner.mjs`, `module.mjs`,
`scripts/ui/dungeon-app.mjs`, `scripts/ui/sound-preview-app.mjs`,
`scripts/ui/marching-order-app.mjs`, `world-macros.mjs`) — `dungeon-runner.mjs`
reads/writes the `dungeonRuns` world setting (the durable record of an
in-progress run); `module.mjs` is the Foundry module's own entry point
(hook registration, `game.modules.get(...).api` surface); `dungeon-app.mjs`
is the player/GM-facing `Application` that renders the tracker and
dispatches every user action either directly (GM) or through the relay
(non-GM host); `world-macros.mjs` (split out of `module.mjs` in #96) owns
`MACRO_DEFS` and `ensureWorldMacros()`, creating/renaming this module's
world macros in place by matching on their own `flags.<MODULE_ID>.generated`
marker rather than by (renameable) name — small and isolated enough from
the rest of `module.mjs`'s heavy import graph to carry real unit test
coverage despite touching `game.macros`/`Macro`.

`ui/sound-preview-app.mjs` (#600) is the GM-only settings-menu form, registered
by `module.mjs`, that lists every sound from `dungeon-sound.mjs` and plays it
locally (never broadcast) through `audio.mjs`.

`ui/marching-order-app.mjs` (#852) is the standalone marching-order window,
opened from a scene-control button registered in `module.mjs` and re-rendered
by `module.mjs`'s `dungeonRuns` setting hook; it reads order via
`dungeon-runner.mjs`, writes it directly (GM) or through `dungeon-remote.mjs`'s
`setMarchingOrder` relay, and uses `dungeon-permissions.mjs` so only the GM, the
run host and party-character owners get controls (everyone else sees a read-only
list); `setMarchingOrder` is a widened relay action whose payload is re-validated
as a pure permutation in `dungeon-runner.mjs`.

## Dependency graph

Generated by `node tools/generate-architecture-graph.mjs` (also `npm run
architecture:graph`) from the actual current `import` statements under
`scripts/` and `tools/agent-service/` — regenerate and paste over the block
below any time the graph might have changed, rather than hand-editing it.

```mermaid
graph LR
  subgraph "Hosted agent service (combat AI + flavor customization)"
    scripts_agent_service_client_mjs["agent-service-client.mjs"]
    scripts_dungeon_customization_fulfillment_mjs["dungeon-customization-fulfillment.mjs"]
    tools_agent_service_candidate_generator_mjs["agent-service/candidate-generator.mjs"]
    tools_agent_service_customization_generator_mjs["agent-service/customization-generator.mjs"]
    tools_agent_service_entrypoint_mjs["agent-service/entrypoint.mjs"]
    tools_agent_service_env_mjs["agent-service/env.mjs"]
    tools_agent_service_node_fetch_mjs["agent-service/node-fetch.mjs"]
    tools_agent_service_providers_index_mjs["agent-service/providers/index.mjs"]
    tools_agent_service_providers_laya_mjs["agent-service/providers/laya.mjs"]
    tools_agent_service_providers_litellm_mjs["agent-service/providers/litellm.mjs"]
    tools_agent_service_providers_openrouter_decisions_mjs["agent-service/providers/openrouter-decisions.mjs"]
    tools_agent_service_server_mjs["agent-service/server.mjs"]
    tools_agent_service_tier_selection_mjs["agent-service/tier-selection.mjs"]
    tools_agent_service_validate_decision_model_mjs["agent-service/validate-decision-model.mjs"]
  end
  subgraph "GM-less relay & permissions"
    scripts_choice_prompts_mjs["choice-prompts.mjs"]
    scripts_dungeon_permissions_mjs["dungeon-permissions.mjs"]
    scripts_dungeon_remote_mjs["dungeon-remote.mjs"]
    scripts_player_choice_mjs["player-choice.mjs"]
  end
  subgraph "Party-follow"
    scripts_dungeon_follow_mechanics_mjs["dungeon-follow-mechanics.mjs"]
    scripts_dungeon_follow_mjs["dungeon-follow.mjs"]
    scripts_token_walk_mjs["token-walk.mjs"]
  end
  subgraph "Combat automation (in-module heuristic)"
    scripts_agent_action_display_mjs["agent-action-display.mjs"]
    scripts_agent_candidates_mjs["agent-candidates.mjs"]
    scripts_antagonize_mjs["antagonize.mjs"]
    scripts_combat_rewards_mjs["combat-rewards.mjs"]
    scripts_dungeon_combat_mjs["dungeon-combat.mjs"]
    scripts_dungeon_critical_deck_mjs["dungeon-critical-deck.mjs"]
    scripts_dungeon_leveling_mjs["dungeon-leveling.mjs"]
    scripts_dungeon_strike_riders_mjs["dungeon-strike-riders.mjs"]
    scripts_flanking_indicator_mjs["flanking-indicator.mjs"]
    scripts_maneuver_feat_modifiers_mjs["maneuver-feat-modifiers.mjs"]
    scripts_marked_target_requirements_mjs["marked-target-requirements.mjs"]
    scripts_npc_ability_overrides_mjs["npc-ability-overrides.mjs"]
    scripts_npc_ability_parse_mjs["npc-ability-parse.mjs"]
    scripts_npc_move_parse_mjs["npc-move-parse.mjs"]
    scripts_npc_reactions_mjs["npc-reactions.mjs"]
    scripts_npc_self_parse_mjs["npc-self-parse.mjs"]
    scripts_npc_strike_shapes_mjs["npc-strike-shapes.mjs"]
    scripts_self_effect_denylist_mjs["self-effect-denylist.mjs"]
    scripts_self_effect_summary_mjs["self-effect-summary.mjs"]
    scripts_stealth_detection_mjs["stealth-detection.mjs"]
    scripts_targeted_feat_actions_mjs["targeted-feat-actions.mjs"]
  end
  subgraph "Puzzle / trap / skill-challenge / treasure mechanics"
    scripts_choice_set_mjs["choice-set.mjs"]
    scripts_narrative_mechanics_mjs["narrative-mechanics.mjs"]
    scripts_puzzle_mechanics_mjs["puzzle-mechanics.mjs"]
    scripts_puzzle_mjs["puzzle.mjs"]
    scripts_room_feature_art_mjs["room-feature-art.mjs"]
    scripts_room_feature_check_mjs["room-feature-check.mjs"]
    scripts_room_feature_tokens_mjs["room-feature-tokens.mjs"]
    scripts_skill_challenge_mechanics_mjs["skill-challenge-mechanics.mjs"]
    scripts_skill_challenge_mjs["skill-challenge.mjs"]
    scripts_trap_combat_mjs["trap-combat.mjs"]
    scripts_trap_library_mjs["trap-library.mjs"]
    scripts_trap_mechanics_mjs["trap-mechanics.mjs"]
    scripts_treasure_mjs["treasure.mjs"]
  end
  subgraph "Encounter generation"
    scripts_cover_items_mjs["cover-items.mjs"]
    scripts_creature_art_mjs["creature-art.mjs"]
    scripts_default_generator_mjs["default-generator.mjs"]
    scripts_encounter_deck_mjs["encounter-deck.mjs"]
    scripts_encounter_generator_mjs["encounter-generator.mjs"]
    scripts_encounter_roster_mjs["encounter-roster.mjs"]
    scripts_generator_registry_mjs["generator-registry.mjs"]
    scripts_trait_picker_mjs["trait-picker.mjs"]
  end
  subgraph "Dungeon generation / sequencing"
    scripts_corridor_pieces_mjs["corridor-pieces.mjs"]
    scripts_dungeon_deck_mjs["dungeon-deck.mjs"]
    scripts_dungeon_layout_mjs["dungeon-layout.mjs"]
    scripts_dungeon_reseed_mjs["dungeon-reseed.mjs"]
    scripts_dungeon_retreat_mjs["dungeon-retreat.mjs"]
    scripts_dungeon_stub_oracle_mjs["dungeon-stub-oracle.mjs"]
    scripts_prng_mjs["prng.mjs"]
  end
  subgraph "Foundry scene building"
    scripts_audio_mjs["audio.mjs"]
    scripts_data_loader_mjs["data-loader.mjs"]
    scripts_dungeon_scene_mjs["dungeon-scene.mjs"]
    scripts_dungeon_sound_mjs["dungeon-sound.mjs"]
    scripts_foundry_api_mjs["foundry-api.mjs"]
    scripts_placement_mjs["placement.mjs"]
  end
  subgraph "Run state & UI"
    scripts_dungeon_runner_mjs["dungeon-runner.mjs"]
    scripts_module_mjs["module.mjs"]
    scripts_ui_dungeon_app_mjs["ui/dungeon-app.mjs"]
    scripts_ui_marching_order_app_mjs["ui/marching-order-app.mjs"]
    scripts_ui_puzzle_stage_dialog_mjs["ui/puzzle-stage-dialog.mjs"]
    scripts_ui_skill_challenge_dialog_mjs["ui/skill-challenge-dialog.mjs"]
    scripts_ui_sound_preview_app_mjs["ui/sound-preview-app.mjs"]
    scripts_ui_trap_disable_dialog_mjs["ui/trap-disable-dialog.mjs"]
    scripts_world_macros_mjs["world-macros.mjs"]
  end
  subgraph "Other"
    scripts_pathfinding_mjs["pathfinding.mjs"]
  end
  scripts_agent_action_display_mjs --> scripts_agent_candidates_mjs
  scripts_antagonize_mjs --> scripts_stealth_detection_mjs
  scripts_combat_rewards_mjs --> scripts_encounter_roster_mjs
  scripts_cover_items_mjs --> scripts_prng_mjs
  scripts_default_generator_mjs --> scripts_dungeon_deck_mjs
  scripts_default_generator_mjs --> scripts_encounter_roster_mjs
  scripts_dungeon_combat_mjs --> scripts_foundry_api_mjs
  scripts_dungeon_combat_mjs --> scripts_dungeon_runner_mjs
  scripts_dungeon_combat_mjs --> scripts_combat_rewards_mjs
  scripts_dungeon_combat_mjs --> scripts_agent_candidates_mjs
  scripts_dungeon_combat_mjs --> scripts_npc_ability_parse_mjs
  scripts_dungeon_combat_mjs --> scripts_npc_move_parse_mjs
  scripts_dungeon_combat_mjs --> scripts_npc_strike_shapes_mjs
  scripts_dungeon_combat_mjs --> scripts_npc_self_parse_mjs
  scripts_dungeon_combat_mjs --> scripts_pathfinding_mjs
  scripts_dungeon_combat_mjs --> scripts_placement_mjs
  scripts_dungeon_combat_mjs --> scripts_token_walk_mjs
  scripts_dungeon_combat_mjs --> scripts_treasure_mjs
  scripts_dungeon_combat_mjs --> scripts_cover_items_mjs
  scripts_dungeon_combat_mjs --> scripts_dungeon_sound_mjs
  scripts_dungeon_combat_mjs --> scripts_dungeon_strike_riders_mjs
  scripts_dungeon_combat_mjs --> scripts_dungeon_critical_deck_mjs
  scripts_dungeon_combat_mjs --> scripts_agent_service_client_mjs
  scripts_dungeon_combat_mjs --> scripts_trap_combat_mjs
  scripts_dungeon_combat_mjs --> scripts_maneuver_feat_modifiers_mjs
  scripts_dungeon_combat_mjs --> scripts_self_effect_denylist_mjs
  scripts_dungeon_combat_mjs --> scripts_agent_action_display_mjs
  scripts_dungeon_combat_mjs --> scripts_self_effect_summary_mjs
  scripts_dungeon_combat_mjs --> scripts_targeted_feat_actions_mjs
  scripts_dungeon_combat_mjs --> scripts_marked_target_requirements_mjs
  scripts_dungeon_combat_mjs --> scripts_antagonize_mjs
  scripts_dungeon_combat_mjs --> scripts_npc_reactions_mjs
  scripts_dungeon_combat_mjs --> scripts_stealth_detection_mjs
  scripts_dungeon_customization_fulfillment_mjs --> scripts_agent_service_client_mjs
  scripts_dungeon_customization_fulfillment_mjs --> scripts_trap_combat_mjs
  scripts_dungeon_customization_fulfillment_mjs --> scripts_dungeon_runner_mjs
  scripts_dungeon_deck_mjs --> scripts_prng_mjs
  scripts_dungeon_deck_mjs --> scripts_treasure_mjs
  scripts_dungeon_follow_mechanics_mjs --> scripts_pathfinding_mjs
  scripts_dungeon_follow_mechanics_mjs --> scripts_placement_mjs
  scripts_dungeon_follow_mjs --> scripts_dungeon_runner_mjs
  scripts_dungeon_follow_mjs --> scripts_dungeon_remote_mjs
  scripts_dungeon_follow_mjs --> scripts_pathfinding_mjs
  scripts_dungeon_follow_mjs --> scripts_placement_mjs
  scripts_dungeon_follow_mjs --> scripts_token_walk_mjs
  scripts_dungeon_follow_mjs --> scripts_dungeon_follow_mechanics_mjs
  scripts_dungeon_layout_mjs --> scripts_prng_mjs
  scripts_dungeon_remote_mjs --> scripts_player_choice_mjs
  scripts_dungeon_remote_mjs --> scripts_dungeon_runner_mjs
  scripts_dungeon_remote_mjs --> scripts_dungeon_permissions_mjs
  scripts_dungeon_remote_mjs --> scripts_room_feature_tokens_mjs
  scripts_dungeon_remote_mjs --> scripts_ui_dungeon_app_mjs
  scripts_dungeon_remote_mjs --> scripts_dungeon_scene_mjs
  scripts_dungeon_remote_mjs --> scripts_trap_combat_mjs
  scripts_dungeon_remote_mjs --> scripts_dungeon_follow_mjs
  scripts_dungeon_reseed_mjs --> scripts_dungeon_layout_mjs
  scripts_dungeon_reseed_mjs --> scripts_dungeon_scene_mjs
  scripts_dungeon_reseed_mjs --> scripts_dungeon_stub_oracle_mjs
  scripts_dungeon_reseed_mjs --> scripts_dungeon_retreat_mjs
  scripts_dungeon_runner_mjs --> scripts_generator_registry_mjs
  scripts_dungeon_runner_mjs --> scripts_dungeon_deck_mjs
  scripts_dungeon_runner_mjs --> scripts_dungeon_retreat_mjs
  scripts_dungeon_runner_mjs --> scripts_skill_challenge_mechanics_mjs
  scripts_dungeon_runner_mjs --> scripts_puzzle_mechanics_mjs
  scripts_dungeon_scene_mjs --> scripts_dungeon_layout_mjs
  scripts_dungeon_scene_mjs --> scripts_placement_mjs
  scripts_dungeon_scene_mjs --> scripts_room_feature_tokens_mjs
  scripts_dungeon_scene_mjs --> scripts_encounter_generator_mjs
  scripts_dungeon_scene_mjs --> scripts_dungeon_runner_mjs
  scripts_dungeon_scene_mjs --> scripts_dungeon_retreat_mjs
  scripts_dungeon_scene_mjs --> scripts_dungeon_deck_mjs
  scripts_dungeon_scene_mjs --> scripts_dungeon_combat_mjs
  scripts_dungeon_scene_mjs --> scripts_data_loader_mjs
  scripts_dungeon_scene_mjs --> scripts_creature_art_mjs
  scripts_dungeon_scene_mjs --> scripts_room_feature_art_mjs
  scripts_dungeon_scene_mjs --> scripts_skill_challenge_mechanics_mjs
  scripts_dungeon_scene_mjs --> scripts_narrative_mechanics_mjs
  scripts_dungeon_scene_mjs --> scripts_foundry_api_mjs
  scripts_dungeon_scene_mjs --> scripts_trap_library_mjs
  scripts_dungeon_scene_mjs --> scripts_trap_combat_mjs
  scripts_dungeon_scene_mjs --> scripts_trap_mechanics_mjs
  scripts_dungeon_scene_mjs --> scripts_prng_mjs
  scripts_dungeon_scene_mjs --> scripts_corridor_pieces_mjs
  scripts_dungeon_sound_mjs --> scripts_audio_mjs
  scripts_dungeon_stub_oracle_mjs --> scripts_dungeon_layout_mjs
  scripts_encounter_deck_mjs --> scripts_prng_mjs
  scripts_encounter_generator_mjs --> scripts_foundry_api_mjs
  scripts_encounter_generator_mjs --> scripts_encounter_deck_mjs
  scripts_encounter_generator_mjs --> scripts_generator_registry_mjs
  scripts_encounter_generator_mjs --> scripts_data_loader_mjs
  scripts_encounter_generator_mjs --> scripts_creature_art_mjs
  scripts_encounter_generator_mjs --> scripts_trait_picker_mjs
  scripts_encounter_generator_mjs --> scripts_dungeon_combat_mjs
  scripts_encounter_generator_mjs --> scripts_cover_items_mjs
  scripts_encounter_generator_mjs --> scripts_encounter_roster_mjs
  scripts_flanking_indicator_mjs --> scripts_placement_mjs
  scripts_foundry_api_mjs --> scripts_placement_mjs
  scripts_foundry_api_mjs --> scripts_prng_mjs
  scripts_foundry_api_mjs --> scripts_cover_items_mjs
  scripts_foundry_api_mjs --> scripts_trap_combat_mjs
  scripts_foundry_api_mjs --> scripts_treasure_mjs
  scripts_foundry_api_mjs --> scripts_choice_set_mjs
  scripts_marked_target_requirements_mjs --> scripts_npc_self_parse_mjs
  scripts_module_mjs --> scripts_encounter_generator_mjs
  scripts_module_mjs --> scripts_ui_dungeon_app_mjs
  scripts_module_mjs --> scripts_dungeon_sound_mjs
  scripts_module_mjs --> scripts_ui_sound_preview_app_mjs
  scripts_module_mjs --> scripts_ui_marching_order_app_mjs
  scripts_module_mjs --> scripts_dungeon_retreat_mjs
  scripts_module_mjs --> scripts_npc_reactions_mjs
  scripts_module_mjs --> scripts_dungeon_runner_mjs
  scripts_module_mjs --> scripts_dungeon_permissions_mjs
  scripts_module_mjs --> scripts_dungeon_remote_mjs
  scripts_module_mjs --> scripts_room_feature_tokens_mjs
  scripts_module_mjs --> scripts_dungeon_scene_mjs
  scripts_module_mjs --> scripts_dungeon_combat_mjs
  scripts_module_mjs --> scripts_dungeon_leveling_mjs
  scripts_module_mjs --> scripts_dungeon_follow_mjs
  scripts_module_mjs --> scripts_trap_combat_mjs
  scripts_module_mjs --> scripts_flanking_indicator_mjs
  scripts_module_mjs --> scripts_ui_trap_disable_dialog_mjs
  scripts_module_mjs --> scripts_ui_puzzle_stage_dialog_mjs
  scripts_module_mjs --> scripts_ui_skill_challenge_dialog_mjs
  scripts_module_mjs --> scripts_room_feature_check_mjs
  scripts_module_mjs --> scripts_generator_registry_mjs
  scripts_module_mjs --> scripts_default_generator_mjs
  scripts_module_mjs --> scripts_world_macros_mjs
  scripts_npc_ability_parse_mjs --> scripts_agent_candidates_mjs
  scripts_npc_ability_parse_mjs --> scripts_npc_ability_overrides_mjs
  scripts_npc_self_parse_mjs --> scripts_npc_ability_parse_mjs
  scripts_npc_strike_shapes_mjs --> scripts_npc_ability_parse_mjs
  scripts_player_choice_mjs --> scripts_choice_prompts_mjs
  scripts_puzzle_mechanics_mjs --> scripts_skill_challenge_mechanics_mjs
  scripts_skill_challenge_mechanics_mjs --> scripts_prng_mjs
  scripts_skill_challenge_mechanics_mjs --> scripts_dungeon_deck_mjs
  scripts_targeted_feat_actions_mjs --> scripts_marked_target_requirements_mjs
  scripts_trap_combat_mjs --> scripts_trap_mechanics_mjs
  scripts_trap_combat_mjs --> scripts_stealth_detection_mjs
  scripts_trap_combat_mjs --> scripts_dungeon_runner_mjs
  scripts_trap_combat_mjs --> scripts_dungeon_permissions_mjs
  scripts_trap_combat_mjs --> scripts_placement_mjs
  scripts_trap_combat_mjs --> scripts_pathfinding_mjs
  scripts_trap_mechanics_mjs --> scripts_prng_mjs
  scripts_ui_dungeon_app_mjs --> scripts_data_loader_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_runner_mjs
  scripts_ui_dungeon_app_mjs --> scripts_room_feature_tokens_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_permissions_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_customization_fulfillment_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_remote_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_deck_mjs
  scripts_ui_dungeon_app_mjs --> scripts_foundry_api_mjs
  scripts_ui_dungeon_app_mjs --> scripts_encounter_roster_mjs
  scripts_ui_dungeon_app_mjs --> scripts_choice_set_mjs
  scripts_ui_dungeon_app_mjs --> scripts_skill_challenge_mjs
  scripts_ui_dungeon_app_mjs --> scripts_puzzle_mjs
  scripts_ui_dungeon_app_mjs --> scripts_skill_challenge_mechanics_mjs
  scripts_ui_dungeon_app_mjs --> scripts_trait_picker_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_scene_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_combat_mjs
  scripts_ui_dungeon_app_mjs --> scripts_generator_registry_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_retreat_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_layout_mjs
  scripts_ui_dungeon_app_mjs --> scripts_dungeon_reseed_mjs
  scripts_ui_marching_order_app_mjs --> scripts_dungeon_runner_mjs
  scripts_ui_marching_order_app_mjs --> scripts_dungeon_remote_mjs
  scripts_ui_marching_order_app_mjs --> scripts_dungeon_permissions_mjs
  scripts_ui_skill_challenge_dialog_mjs --> scripts_ui_dungeon_app_mjs
  scripts_ui_sound_preview_app_mjs --> scripts_dungeon_sound_mjs
  scripts_ui_sound_preview_app_mjs --> scripts_audio_mjs
  tools_agent_service_candidate_generator_mjs --> tools_agent_service_node_fetch_mjs
  tools_agent_service_candidate_generator_mjs --> tools_agent_service_env_mjs
  tools_agent_service_customization_generator_mjs --> tools_agent_service_node_fetch_mjs
  tools_agent_service_customization_generator_mjs --> tools_agent_service_env_mjs
  tools_agent_service_customization_generator_mjs --> tools_agent_service_tier_selection_mjs
  tools_agent_service_entrypoint_mjs --> tools_agent_service_server_mjs
  tools_agent_service_entrypoint_mjs --> tools_agent_service_env_mjs
  tools_agent_service_providers_index_mjs --> tools_agent_service_env_mjs
  tools_agent_service_providers_index_mjs --> tools_agent_service_providers_litellm_mjs
  tools_agent_service_providers_index_mjs --> tools_agent_service_providers_laya_mjs
  tools_agent_service_providers_index_mjs --> tools_agent_service_providers_openrouter_decisions_mjs
  tools_agent_service_providers_laya_mjs --> tools_agent_service_env_mjs
  tools_agent_service_providers_litellm_mjs --> tools_agent_service_env_mjs
  tools_agent_service_providers_litellm_mjs --> tools_agent_service_node_fetch_mjs
  tools_agent_service_providers_litellm_mjs --> tools_agent_service_tier_selection_mjs
  tools_agent_service_providers_openrouter_decisions_mjs --> tools_agent_service_env_mjs
  tools_agent_service_providers_openrouter_decisions_mjs --> tools_agent_service_providers_laya_mjs
  tools_agent_service_server_mjs --> tools_agent_service_providers_index_mjs
  tools_agent_service_server_mjs --> tools_agent_service_customization_generator_mjs
  tools_agent_service_server_mjs --> tools_agent_service_candidate_generator_mjs
  tools_agent_service_server_mjs --> tools_agent_service_env_mjs
  tools_agent_service_tier_selection_mjs --> tools_agent_service_env_mjs
  tools_agent_service_validate_decision_model_mjs --> tools_agent_service_providers_litellm_mjs
  tools_agent_service_validate_decision_model_mjs --> tools_agent_service_providers_index_mjs
  tools_agent_service_validate_decision_model_mjs --> tools_agent_service_env_mjs
```


Notably, `tools/agent-service/*` never imports anything from `scripts/`,
and `scripts/agent-service-client.mjs` never imports anything from
`tools/agent-service/*` either — the two only ever talk over HTTP
(`fetch()` against the service's `/v1/*` routes), never by sharing code.
This is the reverse of the old relay-based direction: previously an
external `tools/agent-loop/*` process reached *into* a live Foundry world
via the `foundry-rest` relay; now Foundry's own client-side code reaches
*out* to the self-hosted service it configures via the `agentServiceUrl`/
`agentServiceApiKey` module settings.

### Two intentional circular imports

`dungeon-follow.mjs` ⟷ `dungeon-remote.mjs` and `scripts/ui/dungeon-app.mjs`
⟷ `dungeon-remote.mjs` both import each other. This is deliberate, not a
mistake: `dungeon-remote.mjs`'s relay needs to call back into the actual
action functions it dispatches to (`dungeon-app.mjs`'s room-resolution
handlers, `dungeon-follow.mjs`'s `runFollowMoveNow`), while those same
files need `dungeon-remote.mjs`'s `requestDungeonAction` to ask a
GM-privileged client to run one of those actions on their behalf. Both
pairs work correctly under this codebase's ESM/Vitest setup because all
circular usage happens inside function bodies, never at module-evaluation
time.

## Keeping this current

Run the `update-architecture-docs` skill (`.claude/skills/update-architecture-docs/`)
as part of the same per-merge discipline this repo's `CLAUDE.md` already
requires for the `module.json` version bump: whoever merges bumps the
version *and* refreshes this doc, in the same pass. The skill regenerates
the dependency graph above mechanically (`tools/generate-architecture-graph.mjs`)
and prompts a check of whether the subsystem groupings and prose still
describe reality — the script only catches graph drift, not prose drift.
