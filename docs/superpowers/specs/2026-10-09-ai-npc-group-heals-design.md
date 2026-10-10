# Advanced AI NPCs: Group Heals (Heal Every Creature in an Area)

**Issue:** #1057 — NPC group heals (heal all allies in an area), deferred from #981.

**Builds on:** #981 / `docs/superpowers/specs/2026-10-09-ai-npc-ally-buffs-design.md` (ally-area placement, closed subject filters, Foundry enumerates and the model chooses), #1056 / `docs/superpowers/specs/2026-10-09-ai-npc-ally-heal-dero-medicine-design.md` (the self-or-ally heal executor), #934 (heal application), #928 (NPC self-heals), #915 (area membership), #909 (candidates), #935, #925.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-09 (see "Resolved decisions").

## Summary

Some NPC abilities heal every creature in an area or aura. This spec adds a **general area-heal executor** (a heal rolled once or per recipient according to the ability's text), the **ranking** of such abilities by total healing delivered, and the first concrete ability: **Halo Pulse** (empyreal dragons), a choose-one-effect pulse whose *Restoration* effect heals each creature in the aura. A coverage audit finds other area abilities that heal and adds the clean ones.

## Investigation findings

- **Halo Pulse** (empyreal dragon: young, adult, ancient, each with a spellcaster variant — six stat blocks; 2 actions, recharge `1d4` rounds): "The dragon chooses one effect to impose on creatures in their inspiring presence aura." Effects include **Repulsion** (each creature must succeed at a Fortitude DC 34 save or be pushed until it is no longer in the aura) and **Restoration** (healing, vitality): "Each creature recovers `7d8` Hit Points." The text says *each creature*, so enemies in the aura are healed too.
- **Bond in Light** (gliminal) links one living creature (fast healing 10, defensive substitution, damage diversion); it is a single-target link, not an area heal, and is out of scope.
- **A text scan** of Monster Core 1–2 and the Bestiaries for 1–3-action abilities that both mention healing and an area (emanation, burst, cone, "within N feet") with allies or creatures as recipients finds Halo Pulse as the clear case; the audit below widens the search and records the rest.
- **Existing pieces.** #981 defines ally-area placement (where to center a burst or whether an emanation reaches allies) and closed subject filters; #1056 defines an ally heal executor with target ranking; #934 applies heals (capped at max HP, no overheal); #915 provides area membership; #925 the result descriptor. The module already supports abilities with a recharge store (#931).

## Resolved decisions

1. **Scope:** Halo Pulse, other area buff-and-heal abilities found by an audit, and a general area-heal executor.
2. **Recipients are per the text.** "Each creature" includes enemies unless the text says allies. The model sees how many allies and enemies would be healed and weighs it; the module never silently excludes a recipient the text includes.
3. **Roll once or per recipient, per the text:** a single `@Damage[...healing]` enricher with "each creature recovers" rolls **once** and applies to all (PF2e: one damage roll for an area effect); an explicit "rolls separately" would roll per recipient (none found).

## Design

### Recognition (`scripts/npc-area-heal.mjs`, pure)

`parseAreaHeal(item)` returns `null` or:

```js
{ cost, area: { kind: "aura"|"emanation"|"burst"|"cone", feet }, heal: { formula, rollMode: "once" },
  recipients: "allCreatures" | "allies", effects?: [{ name, kind: "heal"|"save"|"other" }] }
```

- An "area-heal" is an action whose text has a `healing` damage enricher applied to "each creature"/"each ally" in a named area (an aura from the creature's own aura item, an `@Template`, or a clause like "within N feet").
- **Choose-one-effect abilities** (Halo Pulse) split into effect entries: each named effect (`Repulsion`, `Restoration`, ...) is parsed separately; only the effects the module can model become vocabulary entries (Restoration as a heal; Repulsion as a push-until-out-of-aura save using #986/#931's push helper and #915's save executor); other effects are not offered. The heal effect is the area-heal; other effects are existing shapes.
- All-or-nothing: unrecognized sentences in an effect disable that effect, not the whole ability.

### Vocabulary

`npcAreaHeal` entries (one per usable effect and, for burst/cone areas, one per placement as #981's placement enumeration; auras and emanations around the actor have a single placement). Fields: `{ slug, effect, targetId: null, cost, summary, alliesHealed, enemiesHealed, healAmountEstimate, hpMissingAllies }`.

- **Ranking** (deterministic, before the model sees the best few): `score = Σ over allies min(missingHP, avgHeal) − Σ over enemies min(missingHP, avgHeal)`; entries with `score ≤ 0` are dropped unless the model-facing summary flags them. Ties by fewer enemies healed.
- Summary example: "Halo Pulse – Restoration: heals 7d8 (≈31) to 3 allies (missing 80 HP) and 1 enemy (missing 20 HP)".
- Recharge, frequency and action-cost gates are the standard #910/#931 ones.

### Execution (`applyAgentDecision`, `npcAreaHeal` branch)

1. Re-resolve recipients from the current positions (area membership via #915's helper): everyone in the area who is a valid heal recipient per the text (living vs `vitality`: vitality healing does not heal undead/constructs; undead take vitality-as-damage per the PF2e vitality trait — so for a `vitality` heal an undead recipient takes damage instead; this module applies the system's own handling by routing through `applyDamage` with a healing roll, which already handles it).
2. Roll the heal once (`rollMode: "once"`), apply to each recipient via #934's heal executor (capped at max HP; negative-healing recipients handled by the system).
3. Spend the cost/recharge; announce publicly with per-recipient amounts; report via #925.
4. For non-heal effects of a choose-one ability (e.g. Repulsion) run the existing save/push executors.

### Audit (`tools/audit-area-heals.mjs`)

Scans all NPC action items for the area-heal pattern (and heal-plus-buff area abilities); each row is `{ creature, ability, parsed | notOffered, reason }`; output is a fixture with a monotonic ratchet like #935/#978. Clean rows (parsed by the shape) are enabled; the rest are listed for later with reasons.

## Error handling

- No recipients in the area: the entry is not offered.
- A recipient missing or defeated between enumeration and execution: skipped.
- Vitality/void trait mismatches: the system applies them; the module does not special-case.
- Recharge failures: the usual store; no heal applied on failure before the cost is spent.

## Testing

- **Recognition:** Halo Pulse (all six variants) yields Restoration and Repulsion; unrecognized effects dropped; fixture hash.
- **Ranking:** allies vs enemies healed, missing-HP caps, drop of non-positive scores.
- **Executor (mocked Foundry):** a single heal roll applied to every recipient, caps at max HP, undead vitality handling via `applyDamage`, recharge spent.
- **Audit:** fixture and ratchet.
- **Live verification:** an empyreal dragon pulses Restoration with several wounded allies in its aura; the log shows each recipient's healing.

## Explicitly out of scope

- Single-target healing links such as Bond in Light.
- Healing spells cast by AI casters (the spell pipeline).
- Excluding enemies from "each creature" heals (a house rule).

## Open questions

None. Planning-time details: the remaining Halo Pulse effect names and which the module can model beyond Restoration and Repulsion.
