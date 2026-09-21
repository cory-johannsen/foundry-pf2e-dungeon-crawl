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
} from "./trap-mechanics.mjs";

const MODULE_ID = "deck-of-many-more-things";

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
async function withDialogsSuppressed(fn) {
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

/**
 * Rolls Perception for `seeker` against `hazardActor`'s own detection DC
 * (its Stealth value converted the standard way). Returns
 * `{detected, dc, outcome}` — confirmed live: `actor.perception.roll(...)`
 * is a real, callable PF2e API, same shape as every other check/save roll
 * already used elsewhere in this module.
 */
export async function rollTrapDetection(hazardActor, seeker) {
  const dc = trapDetectionDC(hazardActor.system?.attributes?.stealth?.value);
  return withDialogsSuppressed(async () => {
    await seeker.perception.roll({ dc: { value: dc }, createMessage: true });
    const outcome =
      game.messages.contents.at(-1)?.flags?.pf2e?.context?.outcome ?? null;
    const detected = outcome === "success" || outcome === "criticalSuccess";
    return { detected, dc, outcome };
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
export async function triggerTrap(hazardActor, target) {
  if (hazardActor.getFlag(MODULE_ID, "trapDisabled")) return null;
  const strike = (hazardActor.system?.actions ?? []).find(
    (a) => a.type === "strike" && a.ready !== false,
  );
  if (!strike) return null;

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
 */
export async function applyTrapCustomization(
  actorId,
  { name = null, description = null } = {},
) {
  const actor = game.actors.get(actorId);
  if (!actor) return null;
  const updates = {};
  if (name) updates.name = name;
  if (description) updates["system.details.description"] = description;
  if (Object.keys(updates).length) await actor.update(updates);
  await actor.setFlag(MODULE_ID, "trapCustomization", { status: "customized" });
  return { actorId, name: actor.name };
}
