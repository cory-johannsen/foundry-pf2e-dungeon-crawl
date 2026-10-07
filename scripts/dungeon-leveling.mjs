const MODULE_ID = "pf2e-dungeon-crawl";

/**
 * #853: PF2e itself never subtracts XP or auto-levels. Reacts to
 * `system.details.level.value` increasing (raised by PF2e Leveler or a
 * manual GM edit -- this module never auto-levels, per the owner's own
 * decision on #853) and subtracts `xp.max` once per level actually
 * gained, carry-over remaining, clamped at 0. `xpSubtractedThroughLevel`
 * (a flag on the actor) records the highest level this has already run
 * for, so a later, unrelated updateActor event (an HP change, an item
 * grant -- anything whose own `changes` carries no level field, or whose
 * level was already handled) can never re-trigger the subtraction.
 *
 * The caller (module.mjs's updateActor hook, which fires on every client)
 * must gate this on the active GM so it writes once, not once per client.
 * The write below carries no level field, so it cannot re-trigger itself.
 */
export async function subtractXpOnLevelUp(actor, changes) {
  if (actor.type !== "character") return;
  const newLevel = changes?.system?.details?.level?.value;
  if (newLevel === undefined) return;
  const lastHandled = actor.getFlag(MODULE_ID, "xpSubtractedThroughLevel") ?? newLevel - 1;
  const levelsGained = newLevel - lastHandled;
  if (levelsGained <= 0) return;
  const xpValue = actor.system.details.xp?.value ?? 0;
  const xpMax = actor.system.details.xp?.max ?? 1000;
  await actor.update({
    "system.details.xp.value": Math.max(0, xpValue - xpMax * levelsGained),
    [`flags.${MODULE_ID}.xpSubtractedThroughLevel`]: newLevel,
    [`flags.${MODULE_ID}.readyToLevelUp`]: false,
  });
}
