/**
 * Foundry glue for core trap mechanics (#134) — the live-document half of
 * trap-mechanics.mjs's pure detection/disable/classification logic. Kept in
 * its own file rather than folded into dungeon-combat.mjs: a trap isn't a
 * Combatant (it can trigger outside a tracked Combat entirely, on room
 * reveal or a party member simply walking somewhere), so it has no `combat`
 * object to thread through the way every function in that file does.
 */
import {
  parseDisableChecks,
  trapDetectionDC,
  isSimpleAutomatableTrap,
  classifyTrapMove,
  trapMinProficiencyRank,
  detectionEligibility,
  withinSearchRange,
  parseBasicSaveAction,
  basicSaveDamageMultiplier,
} from "./trap-mechanics.mjs";
import { actorIdsWithExplorationActivity } from "./stealth-detection.mjs";
import { applyTrapRoomState, getRunState } from "./dungeon-runner.mjs";
import { userMayAttemptTrapDisable } from "./dungeon-permissions.mjs";
import { footprint, isPositionChange } from "./placement.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

/**
 * Classifies a live hazard Actor the same way trap-mechanics.mjs's pure
 * `isSimpleAutomatableTrap` does, pulling the plain values off the real
 * document first — the one place that extraction happens, so nothing else
 * needs to know hazard Actors keep this data at `system.details`/
 * `system.actions` rather than trust the shape blind.
 */
export function classifyTrap(hazardActor) {
  const disableChecks = parseDisableChecks(
    hazardActor.system?.details?.disable,
  );
  const strikeActionCount = (hazardActor.system?.actions ?? []).filter(
    (a) => a.type === "strike" && a.ready !== false,
  ).length;
  const isComplex = !!hazardActor.system?.details?.isComplex;
  return {
    isComplex,
    strikeActionCount,
    disableChecks,
    automatable: isSimpleAutomatableTrap({
      isComplex,
      strikeActionCount,
      disableChecks,
    }),
  };
}

/** Suppresses PF2e's own check/damage confirmation dialogs for the duration
 * of `fn`, restoring whatever they were set to afterward — the exact same
 * pattern every roll in dungeon-combat.mjs already uses, so an automated
 * trap roll doesn't sit blocked on a dialog nobody's there to click. */
export async function withDialogsSuppressed(fn) {
  const prevShowCheck = game.user.flags?.pf2e?.settings?.showCheckDialogs;
  const prevShowDamage = game.user.flags?.pf2e?.settings?.showDamageDialogs;
  await game.user.update({
    "flags.pf2e.settings.showCheckDialogs": false,
    "flags.pf2e.settings.showDamageDialogs": false,
  });
  try {
    return await fn();
  } finally {
    await game.user.update({
      "flags.pf2e.settings.showCheckDialogs": prevShowCheck,
      "flags.pf2e.settings.showDamageDialogs": prevShowDamage,
    });
  }
}

/** PF2e degreeOfSuccess (0 crit failure .. 3 crit success) -> outcome slug. */
const DEGREE_OUTCOMES = ["criticalFailure", "failure", "success", "criticalSuccess"];

/**
 * #755: the SECRET Perception check against a hazard's Stealth DC (10 + its
 * Stealth modifier). Per PF2e RAW (Hazards / Search: "the GM will attempt a
 * free secret check"), no roll card is created (`createMessage: false`);
 * the caller whispers the result to GMs. The outcome is read from the
 * returned roll's `degreeOfSuccess` (set because a dc is passed), never from
 * the last chat message. If `degreeOfSuccess` is missing, fall back to
 * comparing `roll.total` with the DC (>= DC success, >= DC+10 critical
 * success, <= DC-10 critical failure). Returns
 * `{detected, dc, outcome, total}`. See
 * docs/superpowers/specs/2026-10-06-trap-detection-raw-design.md.
 */
export async function rollTrapDetection(hazardActor, seeker, deps = {}) {
  const suppress = deps.suppress ?? withDialogsSuppressed;
  const dc = trapDetectionDC(hazardActor.system?.attributes?.stealth?.value);
  return suppress(async () => {
    const roll = await seeker.perception.roll({
      dc: { value: dc },
      createMessage: false,
    });
    const total = roll?.total ?? null;
    let outcome = DEGREE_OUTCOMES[roll?.degreeOfSuccess] ?? null;
    if (outcome === null && total !== null) {
      outcome =
        total >= dc + 10
          ? "criticalSuccess"
          : total >= dc
            ? "success"
            : total <= dc - 10
              ? "criticalFailure"
              : "failure";
    }
    const detected = outcome === "success" || outcome === "criticalSuccess";
    return { detected, dc, outcome, total };
  });
}

/**
 * Attempts to disable `hazardActor` using `actor`'s skill against one of the
 * hazard's own parsed disable options — `skill` should be a slug a
 * `classifyTrap`/`parseDisableChecks` entry actually offered; falls back to
 * the first parsed option if the requested one isn't found (matching a
 * caller that doesn't yet have a picker UI to offer a real choice with, per
 * #134's own "core mechanics, not the room-dialog UI" scope). On success,
 * flags the hazard `trapDisabled` so `triggerTrap` treats it as inert —
 * the hazard Actor itself is left alone, still visible/present, the same
 * way #96's cover items stay on the scene until the encounter that spawned
 * them resolves, rather than being deleted the moment it's beaten.
 */
export async function rollTrapDisableAttempt(hazardActor, actor, skill) {
  const checks = parseDisableChecks(hazardActor.system?.details?.disable);
  const check = checks.find((c) => c.skill === skill) ?? checks[0];
  if (!check) return null;
  const skillStat = actor.skills?.[check.skill];
  if (!skillStat) return null;

  return withDialogsSuppressed(async () => {
    await skillStat.roll({ dc: { value: check.dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const disabled = outcome === "success" || outcome === "criticalSuccess";
    if (disabled) await hazardActor.setFlag(MODULE_ID, "trapDisabled", true);
    return { disabled, outcome, dc: check.dc, skill: check.skill };
  });
}

/**
 * Triggers `hazardActor`'s own single ready strike against `target`
 * (`{actor, token}`, a real placed Token — same shape `rollAndApplyStrike`'s
 * own `target` parameter already takes, since triggering a trap only ever
 * meaningfully happens against a party member actually on the scene) and
 * applies damage on a hit — the exact same roll/damage/applyDamage sequence
 * dungeon-combat.mjs's `rollAndApplyStrike` already uses for a combatant's
 * strike, since a simple trap's routine compiles into a real Strike the
 * same way (confirmed live: `hazardActor.system.actions[0]` has the same
 * `.variants[0].roll()`/`.damage()` shape).
 *
 * Confirmed live the hard way: `strike.variants[0].roll({target: {document:
 * ...}})` needs that document to actually be a Token, not a bare Actor — a
 * bare Actor resolves to `target: null` on the resulting chat message and
 * therefore `outcome: null`, silently, with no error at all. An earlier
 * version of this function fell back to a bare Actor when no token was
 * given, which is exactly this failure mode; removed rather than left in
 * as a trap for the next caller.
 *
 * A no-op if the trap has already been disabled (`rollTrapDisableAttempt`)
 * or has no ready strike at all — call `classifyTrap(hazardActor).automatable`
 * first to know whether this function applies before calling it.
 */
export async function triggerTrap(hazardActor, target, deps = {}) {
  if (hazardActor.getFlag(MODULE_ID, "trapDisabled")) return null;
  const strike = (hazardActor.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (strike) {
    return withDialogsSuppressed(async () => {
      const targetRef = { document: target.token };
      await strike.variants[0].roll({ target: targetRef, createMessage: true });
      const outcome =
        game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
      if (outcome === "success" || outcome === "criticalSuccess") {
        const damageRoll = await strike.damage({
          target: targetRef,
          outcome,
          createMessage: true,
        });
        if (damageRoll) {
          await target.actor.applyDamage({
            damage: damageRoll,
            token: target.token,
            outcome,
          });
        }
      }
      return outcome;
    });
  }

  // #839: no strike -- look for a hazard action item whose own description
  // is a basic save + structured damage (parseBasicSaveAction). Resolved
  // against the triggering creature alone, or every party member within
  // the parsed area, per whichever the hazard's own text describes.
  const hazardItems = Array.from(hazardActor.items ?? []);
  let parsed = null;
  for (const item of hazardItems) {
    if (item.type !== "action") continue;
    parsed = parseBasicSaveAction(item.system?.description?.value);
    if (parsed) break;
  }
  if (parsed) {
    return withDialogsSuppressed(async () => {
      const affected = resolveBasicSaveTargets(parsed, target, deps);
      const outcomes = [];
      for (const { actor, token } of affected) {
        const saveRoll = await actor.saves?.[parsed.save]?.roll?.({
          dc: { value: parsed.dc },
          createMessage: true,
        });
        const outcome =
          DEGREE_OUTCOMES[saveRoll?.degreeOfSuccess] ??
          game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ??
          null;
        const multiplier = basicSaveDamageMultiplier(outcome);
        if (multiplier > 0) {
          let total = 0;
          for (const term of parsed.damage) {
            const roll = await new Roll(term.formula).evaluate();
            total += roll.total;
          }
          await actor.applyDamage({
            damage: Math.floor(total * multiplier),
            token,
            outcome,
          });
        }
        outcomes.push(outcome);
      }
      return outcomes[0] ?? null;
    });
  }

  // Nothing automatable -- guard rail, never silence (#839). GM-only whisper
  // with the hazard's own text and the party members actually near it.
  const description = hazardDescriptionText(hazardActor, hazardItems);
  const names =
    resolveBasicSaveTargets({ areaFeet: GUARD_RAIL_RANGE_FEET }, target, deps)
      .map(({ actor }) => actor.name)
      .join(", ") || target.actor.name;
  await whisperGMChat("PF2EDC.Dungeon.Trap.UnautomatedChat", {
    trap: hazardActor.name,
    description,
    names,
  });
  return null;
}

/** #839: generous radius (feet) used to name who is near an un-automated hazard. */
const GUARD_RAIL_RANGE_FEET = 15;

/** #839: plain text of a hazard's own effect description(s) for the GM whisper. */
function hazardDescriptionText(hazardActor, items) {
  const parts = items
    .filter((i) => i.type === "action")
    .map((i) => i.system?.description?.value)
    .filter((v) => typeof v === "string" && v.trim());
  if (!parts.length) {
    const routine = hazardActor.system?.details?.routine;
    if (typeof routine === "string" && routine.trim()) parts.push(routine);
  }
  const text = parts
    .join(" ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || hazardActor.name;
}

/**
 * #839: `{actor, token}` pairs a parsed basic-save action affects --
 * the triggering creature alone when `parsed.areaFeet` is null, or every
 * PARTY member (matching handleTrapTokenMove's own party-only trigger
 * gate) within that radius of the hazard, via the same grid-distance
 * primitive the detection-range check already uses, always including the
 * triggering creature itself. `deps.hazardToken` (a TokenDocument) and
 * `deps.scene` come from the real call sites; the scene falls back to
 * `target.token.document.parent` when omitted. Geometry reads token
 * DOCUMENTS (pixel x/y, width in squares), same as handleTrapTokenMove.
 */
function resolveBasicSaveTargets(parsed, target, deps = {}) {
  const single = [{ actor: target.actor, token: target.token }];
  if (!parsed.areaFeet) return single;
  const scene = deps.scene ?? target.token?.document?.parent;
  const hazardToken = deps.hazardToken;
  if (!scene?.grid || !hazardToken) return single;
  const rangeSquares = parsed.areaFeet / (scene.grid.distance || 5);
  const hazardFootprint = footprint(hazardToken, scene.grid.size);
  const inArea = Array.from(scene.tokens ?? [])
    .filter((t) => t.actor && isPartyActor(t.actor))
    .filter((t) =>
      withinSearchRange(hazardFootprint, footprint(t, scene.grid.size), rangeSquares),
    )
    .map((t) => ({ actor: t.actor, token: t.object ?? t }));
  return inArea.some(({ actor }) => actor.id === target.actor.id)
    ? inArea
    : [...single, ...inArea];
}

/** Posts a localized public chat line for a trap event (#753). */
async function announceTrap(key, data) {
  await ChatMessage.create({ content: game.i18n.format(key, data) });
}

/** #755: whispers a localized line to every GM. */
async function whisperGMChat(key, data) {
  await ChatMessage.create({
    content: game.i18n.format(key, data),
    whisper: ChatMessage.getWhisperRecipients("GM"),
  });
}

/** #755: whether one of this module's own combats is running on `scene`
 * (same flag test as dungeon-combat.mjs's private `isModuleCombat`, inlined
 * here because dungeon-combat.mjs already imports this file). */
function moduleCombatActive(scene) {
  return (globalThis.game?.combats?.contents ?? []).some(
    (c) =>
      c.scene?.id === scene?.id &&
      (c.getFlag?.(MODULE_ID, "dungeonSlot") != null ||
        c.getFlag?.(MODULE_ID, "encounterId") != null),
  );
}

/** #755: whether `actor` has the Search exploration activity selected (an
 * owned item with slug `search` whose id is in `system.exploration`). */
function isSearching(actor) {
  return (
    actorIdsWithExplorationActivity(
      [
        {
          id: actor.id,
          exploration: actor.system?.exploration ?? [],
          items: Array.from(actor.items ?? []).map((i) => ({ id: i.id, slug: i.slug })),
        },
      ],
      "search",
    ).length > 0
  );
}

/** #754: marks a hazard TOKEN spent (disabled or triggered). Players can't
 * read the hazard actor, so the click control keys off this token flag. */
export async function markTrapSpent(hazardToken) {
  await hazardToken?.setFlag?.(MODULE_ID, "trapSpent", true);
}

/** Hazard actor ids with a trap check in flight (#753). Taken synchronously
 * before any await so two quick `updateToken` events can't both fire. */
const trapChecksInFlight = new Set();

function isPartyActor(actor) {
  if (!actor) return false;
  return (game.actors?.party?.members ?? []).some((m) => m.id === actor.id);
}

/** Hook target for `updateToken` (module.mjs, #753). Acts only on a GM
 * client and only for party tokens. Checks every not-yet-triggered trap
 * hazard on the token's scene against the mover's new footprint: overlap
 * triggers it (a disabled trap is marked triggered but doesn't attack).
 *
 * #755 detection follows PF2e rules as written: each character gets ONE
 * secret Perception check per hazard, the first time they are within 30 ft
 * (`30 / scene.grid.distance` squares) of it while exploring (no module
 * combat). A hazard listing a minimum proficiency in its Stealth details is
 * checked only for a character who has the Search exploration activity
 * selected and meets the rank; an ineligible character does not consume
 * their roll. "Already rolled" lives on the hazard actor's
 * `trapDetectionRolls` flag (GM client only). Every roll is whispered to
 * GMs; only a success is public, and it unhides the token for everyone.
 * Named out of scope: the Seek action during encounters (no rolls while a
 * module combat is active), XP for hazards, and complex-hazard
 * initiative-Stealth nuances (the `10 + modifier` DC is kept). Spec:
 * docs/superpowers/specs/2026-10-06-trap-detection-raw-design.md.
 * `deps` is injectable for tests. */
export async function handleTrapTokenMove(tokenDoc, changes, deps = {}) {
  const isGM = deps.isGM ?? (() => game.user.isGM);
  const isParty = deps.isPartyActor ?? isPartyActor;
  const trigger = deps.triggerTrap ?? triggerTrap;
  const detect = deps.rollTrapDetection ?? rollTrapDetection;
  const announce = deps.announce ?? announceTrap;
  const whisperGM = deps.whisperGM ?? whisperGMChat;
  const combatActive = deps.isCombatActive ?? moduleCombatActive;

  if (!isPositionChange(changes)) return;
  if (!isGM()) return;
  if (!isParty(tokenDoc.actor)) return;
  const scene = tokenDoc.parent;
  if (!scene) return;
  const moverFootprint = footprint(tokenDoc, scene.grid.size);

  const hazardTokens = scene.tokens.filter((t) =>
    t.getFlag(MODULE_ID, "trapHazard"),
  );
  for (const hazardToken of hazardTokens) {
    const hazardActor = hazardToken.actor;
    if (!hazardActor || hazardActor.getFlag(MODULE_ID, "trapTriggered")) continue;
    if (trapChecksInFlight.has(hazardActor.id)) continue;

    const trapFootprint = footprint(hazardToken, scene.grid.size);
    const classification = classifyTrapMove(trapFootprint, moverFootprint);
    const isTrigger = classification === "trigger";
    let detectionActor = null;
    let minRank = null;
    if (!isTrigger) {
      // #755: cheap pre-checks before taking the lock.
      if (hazardActor.getFlag(MODULE_ID, "trapDetected")) continue;
      if (combatActive(scene)) continue;
      const mover = tokenDoc.actor;
      const already = hazardActor.getFlag(MODULE_ID, "trapDetectionRolls") ?? [];
      if (already.includes(mover.id)) continue;
      const rangeSquares = 30 / (scene.grid.distance || 5);
      if (!withinSearchRange(trapFootprint, moverFootprint, rangeSquares)) continue;
      minRank = trapMinProficiencyRank(
        hazardActor.system?.attributes?.stealth?.details,
      );
      const eligible = detectionEligibility({
        minRank,
        searching: isSearching(mover),
        perceptionRank: mover.perception?.rank ?? 0,
      });
      if (!eligible) continue;
      detectionActor = mover;
    }

    trapChecksInFlight.add(hazardActor.id);
    try {
      if (isTrigger) {
        const disabled = hazardActor.getFlag(MODULE_ID, "trapDisabled");
        await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
        if (!disabled) {
          await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
            name: tokenDoc.name ?? tokenDoc.actor.name,
            trap: hazardActor.name,
          });
          await trigger(
            hazardActor,
            { actor: tokenDoc.actor, token: tokenDoc.object },
            { hazardToken, scene },
          );
        }
        await markTrapSpent(hazardToken);
        if (hazardToken.hidden) await hazardToken.update({ hidden: false });
      } else {
        const prior = hazardActor.getFlag(MODULE_ID, "trapDetectionRolls") ?? [];
        // Record before rolling so a re-entrant move can never roll twice.
        await hazardActor.setFlag(MODULE_ID, "trapDetectionRolls", [
          ...prior,
          detectionActor.id,
        ]);
        const name = tokenDoc.name ?? detectionActor.name;
        const result = await detect(hazardActor, detectionActor);
        await whisperGM("PF2EDC.Dungeon.Trap.DetectionRollGM", {
          name,
          trap: hazardActor.name,
          total: result?.total ?? "?",
          dc: result?.dc ?? "?",
          outcome: result?.outcome ?? "?",
        });
        if (result?.detected) {
          await hazardActor.setFlag(MODULE_ID, "trapDetected", true);
          if (hazardToken.hidden) await hazardToken.update({ hidden: false });
          await announce("PF2EDC.Dungeon.Trap.DetectedChat", {
            name,
            trap: hazardActor.name,
          });
        }
      }
    } finally {
      trapChecksInFlight.delete(hazardActor.id);
    }
  }
}

/** Shared entry point for a disable attempt (#753/#754) -- finds the scene's
 * own live, unspent trap hazard and rolls against it. Returns null when
 * there is no such hazard/actor, the requester is not allowed (only checked
 * when `deps.requestingUserId` is given; omitted means a trusted direct
 * GM-client call), or (via rollTrapDisableAttempt) the actor lacks the
 * skill. Critical failure triggers the trap on the attempter; success marks
 * it spent; failure leaves it clickable. */
export async function attemptTrapDisableForScene(
  sceneId,
  actorId,
  skill,
  deps = {},
) {
  const trapScene = game.scenes.get(sceneId);
  const hazardToken = trapScene?.tokens.find(
    (t) =>
      t.getFlag(MODULE_ID, "trapHazard") &&
      !t.getFlag(MODULE_ID, "trapSpent") &&
      !t.actor?.getFlag(MODULE_ID, "trapTriggered"),
  );
  const hazardActor = hazardToken?.actor;
  const actor = actorId ? game.actors.get(actorId) : null;
  if (!hazardActor || !actor) return null;

  if (deps.requestingUserId !== undefined) {
    const userId = deps.requestingUserId;
    const isHost = deps.isHost
      ? deps.isHost(sceneId, userId)
      : !!userId && getRunState(sceneId)?.hostUserId === userId;
    const allowed = userMayAttemptTrapDisable({
      userId,
      isGM: !!game.users?.get(userId)?.isGM,
      isHost,
      actor,
      partyMembers: game.actors?.party?.members ?? [],
    });
    if (!allowed) return null;
  }
  if (trapChecksInFlight.has(hazardActor.id)) return null;

  const roll = deps.rollTrapDisableAttempt ?? rollTrapDisableAttempt;
  const announce = deps.announce ?? announceTrap;
  const trigger = deps.triggerTrap ?? triggerTrap;
  const result = await roll(hazardActor, actor, skill);
  if (!result) return result;

  if (result.outcome === "criticalFailure") {
    // Same in-flight lock as the walk-over trigger so the two can't both fire.
    if (trapChecksInFlight.has(hazardActor.id)) return result;
    if (hazardActor.getFlag(MODULE_ID, "trapTriggered")) return result;
    trapChecksInFlight.add(hazardActor.id);
    try {
      await hazardActor.setFlag(MODULE_ID, "trapTriggered", true);
      await markTrapSpent(hazardToken);
      await announce("PF2EDC.Dungeon.Trap.TriggeredChat", {
        name: actor.name,
        trap: hazardActor.name,
      });
      const attempterToken = trapScene.tokens.find(
        (t) => t.actor?.id === actor.id,
      );
      if (attempterToken?.object) {
        await trigger(
          hazardActor,
          { actor, token: attempterToken.object },
          { hazardToken, scene: trapScene },
        );
      }
    } finally {
      trapChecksInFlight.delete(hazardActor.id);
    }
    return result;
  }

  if (result.disabled) await markTrapSpent(hazardToken);
  await announce(
    result.disabled
      ? "PF2EDC.Dungeon.Trap.DisableSuccessChat"
      : "PF2EDC.Dungeon.Trap.DisableFailureChat",
    { name: actor.name, trap: hazardActor.name },
  );
  return result;
}

// --- #136: external agent customization of a trap's narrative flavor ----

/**
 * The trap-tagged hazard `dungeon-scene.mjs`'s `populateSlotTrap` most
 * recently spawned and flagged `trapCustomization: {status: 'pending'}`,
 * or `null` if there's nothing for an external agent to customize right
 * now. The *only* read surface `tools/agent-loop`'s poller uses for this
 * feature — mirrors `dungeon-combat.mjs`'s `getPendingAgentTurn` exactly:
 * a thin, narrow read surface rather than exposing arbitrary script access.
 *
 * Scoped to still-hidden tokens only: `dungeon-scene.mjs`'s
 * `revealSlotTokens` un-hides a room's tokens the moment its own reveal
 * door opens, with no idea any of them might be mid-customization —
 * rather than coordinate that race, a trap simply stops being offered for
 * customization the instant it's actually revealed, so the agent can
 * never rewrite a name/description a player has already seen in chat.
 * Falling back to the un-customized template past that point is exactly
 * the same "unreachable/timed-out agent" fallback #94's combat-AI design
 * already establishes — reached here by construction (nothing ever blocks
 * room reveal on this), not by an explicit timeout.
 *
 * Deliberately narrow about what it hands the agent: the hazard's own
 * name/description/level and the room's terrain tag and party level —
 * never `system.details.disable`/`system.actions`, so a customization
 * response has no way to touch (or even see) the mechanical data #134's
 * engine actually runs.
 */
export function getPendingTrapCustomization(sceneId = canvas?.scene?.id) {
  const scene = game.scenes.get(sceneId);
  if (!scene) return null;
  const token = scene.tokens.find((t) => {
    if (t.hidden !== true) return false;
    return (
      t.actor?.getFlag(MODULE_ID, "trapCustomization")?.status === "pending"
    );
  });
  if (!token?.actor) return null;
  const actor = token.actor;
  const pending = actor.getFlag(MODULE_ID, "trapCustomization");
  return {
    sceneId: scene.id,
    actorId: actor.id,
    name: actor.name,
    // A hazard Actor's own description is a plain string at
    // system.details.description — confirmed live against Scythe Blades —
    // not the {value} wrapper an NPC's own system.details.description
    // uses. Read/written as a bare string throughout this pair for exactly
    // that reason.
    description: actor.system?.details?.description ?? "",
    trapLevel: actor.system?.details?.level?.value ?? null,
    locationTag: pending?.locationTag ?? null,
    partyLevel: pending?.partyLevel ?? null,
  };
}

/**
 * Applies an external agent's customized name/description to a pending
 * trap (or, called with no `name`/`description` at all, just marks it
 * no-longer-pending — the "decline to customize" case a provider can
 * return instead of forcing one). Only ever touches display fields never
 * read by `classifyTrap`/`parseDisableChecks`/`triggerTrap` above — this
 * cannot change a trap's DC, damage, or whether it's automatable, by
 * construction, since it never writes to `system.details.disable` or
 * `system.actions`. See module.mjs's api.applyTrapCustomization.
 *
 * #56: also mirrors the customization onto the room's own persisted `trap`
 * state via `applyTrapRoomState`, using the `sceneId`/`roomId` stashed on
 * the actor's own `trapCustomization` flag at spawn time (dungeon-scene.mjs's
 * `populateSlotTrap`) — read out here *before* the flag gets overwritten to
 * `{status: 'customized'}` below. Without this, the actor.update above was
 * the whole bug: it writes real data onto a hazard Actor spawned with
 * `ownership.default: 0`, which no player-facing surface in this module ever
 * reads, so a customization landed somewhere no player could ever see it.
 */
export async function applyTrapCustomization(
  actorId,
  { name = null, description = null } = {},
) {
  const actor = game.actors.get(actorId);
  if (!actor) return null;
  const { sceneId, roomId } = actor.getFlag(MODULE_ID, "trapCustomization") ?? {};
  const updates = {};
  if (name) updates.name = name;
  if (description) updates["system.details.description"] = description;
  if (Object.keys(updates).length) await actor.update(updates);
  if (sceneId && roomId) {
    await applyTrapRoomState(sceneId, roomId, { name, description });
  }
  await actor.setFlag(MODULE_ID, "trapCustomization", { status: "customized" });
  return { actorId, name: actor.name };
}
