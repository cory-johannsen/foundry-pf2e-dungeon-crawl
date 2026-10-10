/**
 * #935: the reviewed per-ability override table -- the ONLY way a
 * hand-written outcome enters the NPC save-ability pipeline
 * (npc-ability-parse.mjs). An entry is for a real ability the grammar
 * misreads or can't read; it supplies the outcome fields of the descriptor
 * (`degrees`, `immuneSeconds`, `targetFilter`, and `shape` when the
 * grammar's is wrong), while the save, DC, traits, action cost, frequency
 * and recharge still come from the item's own enrichers, so the same entry
 * serves every creature carrying the ability.
 *
 * An entry applies only while the item still reads as it did when it was
 * reviewed: its name matches and every `verifiedText` string is still
 * present in the item's plain text (condition links rendered as their
 * labels, so compiled-pack ids and raw source names compare alike). A
 * changed compendium text disables the entry at runtime (the grammar's
 * result applies) and fails tests/npc-ability-overrides.test.mjs, so it is
 * re-reviewed rather than silently serving a stale outcome.
 *
 * Pure data plus a matcher; no Foundry API surface.
 */

const degree = (conditions = [], { none = false, immuneSeconds = null } = {}) => ({
  none,
  conditions,
  penalties: [],
  immuneSeconds,
});

export const NPC_ABILITY_OVERRIDES = Object.freeze([
  {
    name: "Unnatural Shriek",
    save: "will",
    // Argorth (Monster Core 2). Reviewer note: the compendium misspells
    // "stupefied" as "stupefed" in both failure blocks, which no condition
    // grammar should fuzzy-match. Read as written otherwise: Frightened has
    // no duration of its own (it decays), Stupefied lasts 1 minute; every
    // creature that attempts the save is immune for 24 hours; aberrations
    // are not affected.
    verifiedText: [
      "Each non-aberration creature within 120 feet must attempt a",
      "Regardless of the result, a creature is temporarily immune to the argorth's Unnatural Shriek for 24 hours.",
      "Critical Success The creature is unaffected.",
      "Success The creature is Frightened 1.",
      "Failure The creature is stupefed 1 for 1 minute and Frightened 2.",
      "Critical Failure The creature is stupefed 2 for 1 minute and Frightened 3.",
    ],
    descriptor: {
      shape: { areaType: "emanation", distanceFeet: 120 },
      immuneSeconds: 86400,
      targetFilter: { excludeTraits: ["aberration"], excludeNames: [], livingOnly: false },
      degrees: {
        criticalSuccess: degree([], { none: true }),
        success: degree([{ slug: "frightened", value: 1, durationSeconds: null }]),
        failure: degree([
          { slug: "stupefied", value: 1, durationSeconds: 60 },
          { slug: "frightened", value: 2, durationSeconds: null },
        ]),
        criticalFailure: degree([
          { slug: "stupefied", value: 2, durationSeconds: 60 },
          { slug: "frightened", value: 3, durationSeconds: null },
        ]),
      },
    },
  },
  {
    name: "Bone-Chilling Screech",
    save: "will",
    // Skaveling (Bestiary 3). Reviewer note: the critical failure reads
    // "Frightened 2 and Stunned 1 by fear" -- "by fear" names the source of
    // the stun (the ability's fear trait), not an extra effect, but it is
    // not a qualifier the grammar may drop in general. Shape (20-ft
    // emanation) and recharge come from the item's enrichers.
    verifiedText: [
      "each creature in a",
      "Critical Success The creature is unaffected and is temporarily immune to Bone- Chilling Screech for 24 hours.",
      "Success The creature is Frightened 1.",
      "Failure The creature is Frightened 2.",
      "Critical Failure The creature is Frightened 2 and Stunned 1 by fear.",
    ],
    descriptor: {
      degrees: {
        criticalSuccess: degree([], { none: true, immuneSeconds: 86400 }),
        success: degree([{ slug: "frightened", value: 1, durationSeconds: null }]),
        failure: degree([{ slug: "frightened", value: 2, durationSeconds: null }]),
        criticalFailure: degree([
          { slug: "frightened", value: 2, durationSeconds: null },
          { slug: "stunned", value: 1, durationSeconds: null },
        ]),
      },
    },
  },
]);

/** The reviewed outcome fields for `item`, or `null`: matched by the item's
 * name and save type, and only while every `verifiedText` is still in
 * `plainText` (the item's description rendered as plain text). A fresh
 * copy every call, so a caller can never mutate the table. */
export function findNpcAbilityOverride(item, plainText, saveType) {
  const name = item?.name;
  if (!name) return null;
  const entry = NPC_ABILITY_OVERRIDES.find((e) => e.name === name && e.save === saveType);
  if (!entry) return null;
  const text = String(plainText ?? "").replace(/\s+/g, " ");
  if (!entry.verifiedText.every((t) => text.includes(t))) return null;
  return structuredClone(entry.descriptor);
}
