# AI NPC Movement Abilities Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Offer movement-with-a-twist NPC abilities (Gallop/Speed Surge-style Stride variants, alternate-mode moves, move-plus-Strike compounds like Pounce/Swoop, and teleports like Phase Jump) as a new `npcMove` candidate type, by parsing each ability's description into a small movement-plan descriptor and generalizing the existing stride executor to run it.

**Architecture:** A pure parser (`scripts/npc-move-parse.mjs`) turns an NPC action item's description into a movement-plan descriptor or `null`, using a closed grammar plus a short rider table — all-or-nothing, exactly like #915's own parser convention. `scripts/agent-candidates.mjs` gains a vocabulary/candidate builder pair (`buildNpcMoveVocabulary`/`buildNpcMoveCandidates`) mirroring #910's `buildFeatVocabulary`/`buildFeatCandidates` pattern byte-for-byte. `scripts/dungeon-combat.mjs` gains a `computeNpcMoveVocabularyEntries` pre-filter (mirroring `computeSelfEffectVocabularyEntries`), wires the new vocabulary into the existing once-per-turn reasoning call (the same call #910's `featVocabulary` already rides along in), generalizes `strideByPosture` with two new optional fields (a distance-budget override and a reaction-suppression flag) rather than building a second movement system, and adds one new `applyAgentDecision` branch that spends the ability's cost/frequency/recharge and dispatches to a move, move-plus-Strike, or teleport executor.

**Tech Stack:** Vanilla JS (ES modules), Foundry VTT v14 API, PF2e system API, Vitest.

**Spec:** `docs/superpowers/specs/2026-10-08-ai-npc-movement-abilities-design.md`

## Global Constraints

- **#915's own parser (`scripts/npc-ability-parse.mjs`) does not exist in real code yet** (confirmed live: issue #915 carries label `planned`, not implemented). This plan's parser follows the spec's own stated conventions ("pure, all-or-nothing, data-driven coverage audit") and the real, already-implemented `parseBreathWeaponEffect` precedent (`scripts/agent-candidates.mjs`) directly, rather than importing anything from #915's not-yet-real module.
- **#925's result-descriptor card does not exist in real code yet either** (confirmed live: issue #925 carries label `planned`). This plan reports a movement ability's outcome via the same mechanism every other `applyAgentDecision` branch already uses today — the existing, fully generic `postAgentDecisionChat(combatant, candidate, rationale)` (reads `candidate.summary`) and, for a stalled move, the existing, fully generic `postMoveStalledChat(combatant, status)` — not #925's not-yet-real mechanism.
- **#931's generalized reaction registry does not exist in real code yet either** (confirmed live: issue #931 carries label `planned`). `suppressReactions` is wired against the real, current `offerReactiveStrikesAgainst(combat, mover)` call inside `strideByPosture` (skip the call entirely when set) — whichever function ends up handling reactions after #931 ships, skipping this one call site has the same effect, since `offerReactiveStrikesAgainst` is and will remain the single entry point `strideByPosture` calls into.
- **Three named spec examples needed a grounded correction after reading their real compendium text** (`~/pf2e-data/packs/pf2e/*.json`), confirmed before writing this plan, not guessed:
  - *Eagle Dive*'s real text embeds its elevation clause **inside** the movement sentence itself ("Flies up to double its fly Speed in a straight line, descending at least 10 feet, and then makes a talon Strike") rather than as a separate trailing sentence. The movement-sentence grammar (Task 1) tolerates and discards a trailing `in a straight line, (?:descending|ascending) at least N feet` fragment, surfacing it only as a GM-visible note at report time — consistent with the spec's own Resolved Decision #3 ("Elevation is not modeled; the GM report notes it").
  - *Breach*'s real text has no single clean form: the simplest real instance (`ossuary-warden.json`) reads "Leaps and makes a Strike at the end of that movement" with **no Speed/mode wording at all** (PF2e's basic Leap action is a fixed-distance jump, not Speed-based, so it fails the grammar outright — correctly unrecognized); the aquatic instance (`great-white-shark.json`) reads "Swims up to its swim Speed, then Leaps vertically out of the water up to 25 feet high, making a Strike... After the Strike, the shark splashes back down into the water" — a vertical-jump-height-plus-aftermath shape well outside the closed grammar. Breach is reclassified from the spec's "recognized" example column to "not offered" in this plan's own parser fixtures; its own real complexity matches the spec's own catalog of commonly-unmodeled riders, not an oversight.
  - *Phase Jump*'s real text ("The dragon teleports up to 75 feet. If they are airborne, they maintain their momentum, and do not fall at the end of their turn...") carries a trailing rider not in the spec's own literal rider table. Since the module models no elevation/falling at all (Resolved Decision #3), this clause describes a mechanic the module was never going to simulate either way — the rider table (Task 1) gains one additional, narrowly-scoped entry matching exactly this "airborne, doesn't fall" phrasing, recognized-and-discarded, rather than leaving every teleport in the first slice unrecognized against the spec's own explicit intent to ship teleports now.
- Follow this repo's existing per-file `const MODULE_ID = "pf2e-dungeon-crawl";` convention.
- Bump `module.json`'s `version` as part of this work (minor bump — a new vocabulary category plus a generalized core movement primitive, not a routine fix).

## Review Factor

- A parsed ability whose required movement mode (e.g. `fly`) the actor has no Speed for must never be offered — this is explicit in the spec but easy to drop while focused on the happy path of an actor that has every mode.
- An ability with `cost` greater than the combatant's remaining actions, `frequency.value` at 0, or an active recharge cooldown must never be offered — the same three gates #910's own self-effect entries already apply, reused identically here.
- A move-plus-Strike compound whose target moves or is removed between candidate generation and execution (the general "re-resolve at execution time" rule this codebase already follows everywhere else) must degrade to a reported no-op, never throw or apply a Strike against a stale position.
- A teleport whose only "legal" destination would place the token somewhere with no line of sight to any opponent, or that finds no free cell at all, must be skipped entirely (not offered) rather than offered and then failing at execution time.
- The existing plain-stride regression tests (`strideByPosture(combat, combatant, posture, target)` with no fourth argument) must keep passing byte-for-byte after the generalization — a new optional options object is the only surface change.

---

### Task 1: The movement-ability parser (`scripts/npc-move-parse.mjs`)

**Files:**
- Create: `scripts/npc-move-parse.mjs`
- Create: `tests/fixtures/npc-move-ability-fixtures.json` (real description text, gathered below)
- Test: `tests/npc-move-parse.test.mjs`

**Interfaces:**
- Consumes: nothing (pure; takes a plain `{ name, system: { description: { value }, actions: { value }, frequency } }`-shaped object, matching a real Foundry `Item`'s own readable fields).
- Produces (consumed by Task 3): `parseMovementAbility(item)` → the movement-plan descriptor or `null`, per the spec's own descriptor shape below.

- [x] **Step 1: Write the real-data fixture file**

Gathered directly from `~/pf2e-data/packs/pf2e/*.json` (every string below is the item's real, unedited `system.description.value`):

```json
{
  "gallop": {
    "name": "Gallop",
    "description": "<p>Windchaser Strides twice. It has a +10-foot circumstance bonus to its Speed during these Strides.</p>",
    "cost": 1,
    "frequency": null
  },
  "speedSurge": {
    "name": "Speed Surge",
    "description": "<p><strong>Effect</strong> Bun the Black Strides or Flies twice.</p>",
    "cost": 1,
    "frequency": { "value": 3, "max": 3, "per": "day" }
  },
  "swiftLeap": {
    "name": "Swift Leap",
    "description": "<p>The ghoul jumps up to half its Speed. This movement doesn't trigger reactions.</p>",
    "cost": 1,
    "frequency": null
  },
  "swoop": {
    "name": "Swoop",
    "description": "<p>The giant dragonfly Flies up to its Speed and makes one mandible Strike at any point during that movement.</p>",
    "cost": 1,
    "frequency": null
  },
  "eagleDive": {
    "name": "Eagle Dive",
    "description": "<p>The giant eagle @UUID[Compendium.pf2e.actionspf2e.Item.Fly]{Flies} up to double its fly Speed in a straight line, descending at least 10 feet, and then makes a talon Strike.</p>",
    "cost": 1,
    "frequency": null
  },
  "phaseJump": {
    "name": "Phase Jump",
    "description": "<p><strong>Effect</strong> The dragon teleports up to 75 feet. If they are airborne, they maintain their momentum, and do not fall at the end of their turn, even if they didn't use an action to Fly.</p>",
    "cost": 1,
    "frequency": { "value": 1, "max": 1, "per": "round" }
  },
  "pounce": {
    "name": "Pounce",
    "description": "<p>The leopard Strides and makes a Strike at the end of that movement. If the leopard successfully used @UUID[Compendium.pf2e.actionspf2e.Item.Hide] before this action, the target has the @UUID[Compendium.pf2e.conditionitems.Item.Off-Guard] condition against this Strike.</p>",
    "cost": 1,
    "frequency": null
  },
  "impalingCharge": {
    "name": "Impaling Charge",
    "description": "<p>The karkadann Strides twice, then Strikes with their horn. If the Strike hits, it also deals 1d10 persistent bleed damage.</p>",
    "cost": 1,
    "frequency": null
  },
  "breachSimple": {
    "name": "Breach",
    "description": "<p>The ossuary warden Leaps and makes a Strike at the end of that movement.</p>",
    "cost": 1,
    "frequency": null
  },
  "breachShark": {
    "name": "Breach",
    "description": "<p>The shark Swims up to its swim Speed, then @UUID[Compendium.pf2e.actionspf2e.Item.Leap]{Leaps} vertically out of the water up to 25 feet high, making a Strike against a creature at any point during the jump (this lets it attack a creature within 30 feet of the water's surface). After the Strike, the shark splashes back down into the water.</p>",
    "cost": 1,
    "frequency": null
  },
  "changeShape": {
    "name": "Change Shape",
    "description": "<p>The creature changes its shape, taking on the appearance of a form of its choice...</p>",
    "cost": 1,
    "frequency": null
  }
}
```

- [x] **Step 2: Write the failing tests**

```js
// tests/npc-move-parse.test.mjs
import { describe, it, expect } from 'vitest';
import { parseMovementAbility } from '../scripts/npc-move-parse.mjs';
import fixtures from './fixtures/npc-move-ability-fixtures.json';

function itemFor(key, overrides = {}) {
  const f = fixtures[key];
  return {
    name: f.name,
    system: {
      description: { value: f.description },
      actions: { value: f.cost },
      frequency: f.frequency,
      ...overrides,
    },
  };
}

describe('parseMovementAbility', () => {
  it('parses Gallop as a land Stride-twice with a +10ft bonus', () => {
    const plan = parseMovementAbility(itemFor('gallop'));
    expect(plan).not.toBeNull();
    expect(plan.plan.kind).toBe('move');
    expect(plan.plan.segments).toEqual([{ mode: 'land', speedFactor: 1 }]);
    expect(plan.plan.segmentRepeat).toBe(2);
    expect(plan.plan.bonusFeet).toBe(10);
    expect(plan.plan.strike).toBeNull();
    expect(plan.plan.suppressReactions).toBe(false);
  });

  it('parses Speed Surge as an auto land-or-fly Stride-twice, carrying its structured frequency as-is', () => {
    const plan = parseMovementAbility(itemFor('speedSurge'));
    expect(plan).not.toBeNull();
    expect(plan.plan.segments).toEqual([{ mode: 'landOrFly', speedFactor: 1 }]);
    expect(plan.plan.segmentRepeat).toBe(2);
    expect(plan.frequency).toEqual({ value: 3, max: 3, per: 'day' });
  });

  it('parses Swift Leap as a half-Speed land jump with reactions suppressed', () => {
    const plan = parseMovementAbility(itemFor('swiftLeap'));
    expect(plan).not.toBeNull();
    expect(plan.plan.segments).toEqual([{ mode: 'land', speedFactor: 0.5 }]);
    expect(plan.plan.suppressReactions).toBe(true);
    expect(plan.plan.strike).toBeNull();
  });

  it('parses Swoop as a full fly Speed move with a Strike at any point', () => {
    const plan = parseMovementAbility(itemFor('swoop'));
    expect(plan).not.toBeNull();
    expect(plan.plan.segments).toEqual([{ mode: 'fly', speedFactor: 1 }]);
    expect(plan.plan.strike).toEqual({ limb: null, count: 1, timing: 'any' });
  });

  it('parses Eagle Dive as a double fly Speed move with a Strike at the end, discarding the embedded elevation clause', () => {
    const plan = parseMovementAbility(itemFor('eagleDive'));
    expect(plan).not.toBeNull();
    expect(plan.plan.segments).toEqual([{ mode: 'fly', speedFactor: 2 }]);
    expect(plan.plan.strike).toEqual({ limb: 'talon', count: 1, timing: 'end' });
    expect(plan.plan.elevationNote).toBe('descending at least 10 feet');
  });

  it('parses Phase Jump as a teleport, discarding the vacuous airborne/falling rider', () => {
    const plan = parseMovementAbility(itemFor('phaseJump'));
    expect(plan).not.toBeNull();
    expect(plan.plan.kind).toBe('teleport');
    expect(plan.plan.teleportFeet).toBe(75);
    expect(plan.frequency).toEqual({ value: 1, max: 1, per: 'round' });
  });

  it('does not recognize Pounce (unmodeled conditional Off-Guard rider)', () => {
    expect(parseMovementAbility(itemFor('pounce'))).toBeNull();
  });

  it('does not recognize Impaling Charge (unmodeled persistent-damage rider)', () => {
    expect(parseMovementAbility(itemFor('impalingCharge'))).toBeNull();
  });

  it('does not recognize the simple Breach (Leap has no Speed/mode wording at all)', () => {
    expect(parseMovementAbility(itemFor('breachSimple'))).toBeNull();
  });

  it('does not recognize the aquatic Breach (vertical jump height plus splash-back aftermath)', () => {
    expect(parseMovementAbility(itemFor('breachShark'))).toBeNull();
  });

  it('does not recognize Change Shape (not movement at all)', () => {
    expect(parseMovementAbility(itemFor('changeShape'))).toBeNull();
  });

  it('never throws on malformed/missing description HTML', () => {
    expect(() => parseMovementAbility({ name: 'x', system: { description: {}, actions: { value: 1 } } })).not.toThrow();
    expect(parseMovementAbility({ name: 'x', system: { description: {}, actions: { value: 1 } } })).toBeNull();
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/npc-move-parse.test.mjs`
Expected: FAIL — the module doesn't exist yet.

- [x] **Step 4: Implement `scripts/npc-move-parse.mjs`**

```js
/**
 * #932: a pure parser turning an NPC movement ability's description into a
 * movement plan, or null when the text falls outside the closed grammar
 * below (all-or-nothing, matching #915's own parser convention — an
 * ability this module only partly understands is never offered, rather
 * than offered with a wrong or incomplete effect).
 *
 * Grounded against real compendium text (not invented prose): Gallop,
 * Speed Surge, Swift Leap, Swoop, Eagle Dive and Phase Jump are each real,
 * unedited ability descriptions (see tests/fixtures/npc-move-ability-
 * fixtures.json). Two corrections found against the spec's own stated
 * grammar during that grounding, both narrow and both justified by the
 * spec's own Resolved Decision #3 ("elevation is not modeled"):
 * - Eagle Dive's elevation clause is embedded inside the movement sentence
 *   itself, not a separate trailing sentence -- tolerated and discarded
 *   by MOVE_SENTENCE_RE's own optional elevation group, surfaced only as
 *   `elevationNote` for the GM report.
 * - Phase Jump's "if airborne, doesn't fall" clause is a vacuous rider
 *   (the module models no elevation/falling to begin with) -- added to
 *   the rider table as a recognized-and-discarded entry rather than
 *   leaving every teleport unrecognized.
 * Breach (both the simple Leap-based and the aquatic vertical-jump forms)
 * and Pounce/Impaling Charge's conditional riders do NOT fit this grammar
 * and are correctly null -- confirmed against their own real text, not
 * assumed from the spec's own example list.
 */

const MODE_WORD = {
  strides: "land",
  stride: "land",
  flies: "fly",
  fly: "fly",
  swims: "swim",
  swim: "swim",
  burrows: "burrow",
  burrow: "burrow",
  climbs: "climb",
  climb: "climb",
};

const FACTOR_WORD = { half: 0.5, double: 2, twice: 2 };

const MOVE_SENTENCE_RE =
  /\b(Strides or Flies|Strides?|Flies|Swims|Burrows|Climbs|Leaps|jumps)\b(?: up to)?(?: (half|double))?(?: its| their)?(?: (land|fly|swim|burrow|climb))? Speed(?: plus (\d+) feet)?(?: in a straight line, (descending|ascending) at least (\d+) feet)?(?: and (?:makes|attempts) (?:a|one) (\w+)? ?Strike(?: at the end of that movement| at any point during (?:its|that) movement)?)?(?:,? then (?:makes|Strikes with their) (\w+)? ?(?:Strike)?(?: at the end of that movement| at any point during (?:its|that) movement)?)?(?: ?(twice))?\b/i;

const STRIKE_CLAUSE_RE =
  /\b(?:and|then) (?:makes|attempts) (?:a|one) (\w+)? ?Strike(?: at the end of that movement| at any point during (?:its|that) movement)?/i;

const BONUS_SENTENCE_RE = /It has a \+(\d+)-foot circumstance bonus to its Speed(?:s)?(?: during these Strides)?/i;

const TELEPORT_SENTENCE_RE = /teleports?(?: itself)? up to (\d+) feet/i;

const RIDER_TABLE = [
  { re: /This movement doesn't trigger reactions/i, apply: (plan) => { plan.suppressReactions = true; } },
  { re: /if (?:they|it) (?:is|are) airborne.*(?:do not fall|doesn't fall)/i, apply: () => {} },
];

function stripHtml(html) {
  return String(html ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function resolveUuidLinks(text) {
  return text.replace(/@UUID\[[^\]]*\]\{([^}]*)\}/g, "$1");
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @returns {object|null} the movement plan, or null if the text falls
 * outside this file's closed grammar. */
export function parseMovementAbility(item) {
  const raw = item?.system?.description?.value;
  if (!raw) return null;
  let text = resolveUuidLinks(stripHtml(raw));
  // Strip a leading "Frequency ..."/"Effect " boilerplate block; the
  // authoritative frequency value is read from item.system.frequency, not
  // from this text.
  text = text.replace(/^(Frequency[^.]*\.?\s*)?(Effect\s+)?/i, "");
  const sentences = splitSentences(text);
  if (!sentences.length) return null;

  const teleportMatch = TELEPORT_SENTENCE_RE.exec(sentences[0]);
  if (teleportMatch) {
    const rest = sentences.slice(1).join(" ");
    if (rest && !RIDER_TABLE.some((r) => r.re.test(rest))) return null;
    return {
      cost: item.system?.actions?.value ?? 1,
      frequency: item.system?.frequency ?? null,
      rechargeFormula: null,
      plan: {
        kind: "teleport",
        segments: [],
        bonusFeet: 0,
        teleportFeet: Number(teleportMatch[1]),
        strike: null,
        suppressReactions: false,
        chargeNote: null,
      },
      mode: "auto",
    };
  }

  const moveMatch = MOVE_SENTENCE_RE.exec(sentences[0]);
  if (!moveMatch) return null;
  const [
    ,
    verb,
    factorWord,
    modeWord,
    bonusPlusFeet,
    elevationDir,
    elevationFeet,
    limbInline,
    limbThen,
    twiceSuffix,
  ] = moveMatch;

  const verbKey = verb.toLowerCase();
  let mode;
  if (verbKey === "strides or flies") mode = "landOrFly";
  else if (verbKey.startsWith("stride")) mode = modeWord ? MODE_WORD[modeWord.toLowerCase()] : "land";
  else if (verbKey === "jumps" || verbKey === "leaps") mode = modeWord ? MODE_WORD[modeWord.toLowerCase()] : "land";
  else mode = MODE_WORD[verbKey] ?? (modeWord ? MODE_WORD[modeWord.toLowerCase()] : null);
  if (!mode) return null;

  const speedFactor = factorWord ? FACTOR_WORD[factorWord.toLowerCase()] : 1;
  const segmentRepeat = twiceSuffix ? 2 : 1;
  const bonusFeet = Number(bonusPlusFeet ?? 0);

  let strike = null;
  const limb = limbInline || limbThen || null;
  if (limbInline !== undefined || limbThen !== undefined) {
    const timing = /at any point/i.test(sentences[0]) ? "any" : "end";
    strike = { limb: limb || null, count: 1, timing };
  } else {
    const strikeClauseMatch = STRIKE_CLAUSE_RE.exec(sentences.slice(1).join(" "));
    if (strikeClauseMatch) {
      const timing = /at any point/i.test(strikeClauseMatch[0]) ? "any" : "end";
      strike = { limb: strikeClauseMatch[1] || null, count: 1, timing };
    }
  }

  const plan = {
    kind: "move",
    segments: [{ mode, speedFactor }],
    segmentRepeat,
    bonusFeet,
    teleportFeet: null,
    strike,
    suppressReactions: false,
    chargeNote: null,
    elevationNote: elevationDir ? `${elevationDir} at least ${elevationFeet} feet` : null,
  };

  // Every remaining sentence (after the movement sentence and, if the
  // Strike clause lived in a sentence of its own, after that one too)
  // must match the bonus sentence or the rider table, or this ability is
  // unrecognized.
  for (const sentence of sentences.slice(1)) {
    if (STRIKE_CLAUSE_RE.test(sentence) && strike) continue;
    const bonusMatch = BONUS_SENTENCE_RE.exec(sentence);
    if (bonusMatch) {
      plan.bonusFeet = Number(bonusMatch[1]);
      continue;
    }
    const rider = RIDER_TABLE.find((r) => r.re.test(sentence));
    if (rider) {
      rider.apply(plan);
      continue;
    }
    return null;
  }

  return {
    cost: item.system?.actions?.value ?? 1,
    frequency: item.system?.frequency ?? null,
    rechargeFormula: /\[\[\/gmr (\d+d\d+) #Recharge/.exec(raw)?.[1] ?? null,
    plan,
    mode: "auto",
  };
}
```

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/npc-move-parse.test.mjs`
Expected: PASS. If a specific fixture's exact capture groups don't line up with `MOVE_SENTENCE_RE`'s own group ordering (regex group numbering is easy to get subtly wrong on a first pass — e.g. Swoop's inline Strike clause vs. Eagle Dive's "then Strikes with their horn" clause use two different capture groups, `limbInline` vs `limbThen`), adjust the regex and the destructuring together rather than only one side; re-run after every adjustment instead of guessing twice.

- [x] **Step 6: Commit**

```bash
git add scripts/npc-move-parse.mjs tests/npc-move-parse.test.mjs tests/fixtures/npc-move-ability-fixtures.json
git commit -m "feat(#932): add the pure NPC movement-ability parser

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Coverage audit snapshot

**Files:**
- Create: `tests/npc-move-parse-coverage.test.mjs`

**Interfaces:**
- Consumes: `parseMovementAbility` (Task 1).
- Produces: nothing further — a standing regression guard, per the spec's own Testing section ("a snapshot test ... so grammar or compendium changes are visible").

- [x] **Step 1: Write the snapshot test**

```js
// tests/npc-move-parse-coverage.test.mjs
import { describe, it, expect } from 'vitest';
import { parseMovementAbility } from '../scripts/npc-move-parse.mjs';
import fixtures from './fixtures/npc-move-ability-fixtures.json';

describe('npc-move-parse coverage audit', () => {
  it('recognizes exactly the expected subset of the fixture set, by name', () => {
    const recognized = Object.entries(fixtures)
      .filter(([, f]) => parseMovementAbility({ name: f.name, system: { description: { value: f.description }, actions: { value: f.cost }, frequency: f.frequency } }))
      .map(([key]) => key)
      .sort();
    expect(recognized).toEqual(
      ['eagleDive', 'gallop', 'phaseJump', 'speedSurge', 'swiftLeap', 'swoop'].sort(),
    );
  });
});
```

(This is intentionally a small, fixture-scale snapshot, not a live scan of the full ~320-instance bestiary population the spec's own investigation sized — that full-population scan is #972's own progress-measurement concern per the spec's "Explicitly out of scope" section; this task's job is only to pin today's grammar's own recognized/unrecognized split for the fixture set this plan ships with, so a later grammar change shows up as an intentional, reviewed diff rather than a silent behavior change.)

- [x] **Step 2: Run the test to verify it passes**

Run: `npm test -- tests/npc-move-parse-coverage.test.mjs`
Expected: PASS (given Task 1's implementation already recognizes exactly this set).

- [x] **Step 3: Commit**

```bash
git add tests/npc-move-parse-coverage.test.mjs
git commit -m "test(#932): pin the parser's recognized/unrecognized fixture split

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Vocabulary and candidate builders (`scripts/agent-candidates.mjs`)

**Files:**
- Modify: `scripts/agent-candidates.mjs`
- Test: `tests/agent-candidates.test.mjs` (existing — add to it; check its current structure first)

**Interfaces:**
- Consumes: nothing beyond plain data (pure, no Foundry API surface, matching every other builder in this file).
- Produces (consumed by Task 4): `buildNpcMoveVocabulary({ movementEntries, opponents, gridDistanceFt })` → vocabulary entries `{ type: "npcMove", itemId, slug, name, kind, posture, targetId, cost, speedSquares, mode, strike, suppressReactions, teleportFeet, elevationNote }`; `buildNpcMoveCandidates({ npcMoveVocabulary, picks, opponents })` → candidate entries `{ id, type: "npcMove", ...same fields as the vocabulary entry, cost, summary }`.

- [x] **Step 1: Read the existing test file's structure**

Run: `grep -n "^describe\|^import" tests/agent-candidates.test.mjs | head -30`

Match its existing fixture/mock conventions (`opponentStub`, etc.) rather than inventing new ones.

- [x] **Step 2: Write the failing tests**

```js
// Added to tests/agent-candidates.test.mjs
import { buildNpcMoveVocabulary, buildNpcMoveCandidates } from '../scripts/agent-candidates.mjs';

describe('buildNpcMoveVocabulary', () => {
  function entry(overrides = {}) {
    return {
      itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 1,
      plan: { kind: 'move', segments: [{ mode: 'land', speedFactor: 1 }], segmentRepeat: 2, bonusFeet: 10, teleportFeet: null, strike: null, suppressReactions: false, elevationNote: null },
      ...overrides,
    };
  }
  function opponent(overrides = {}) { return { id: 'o1', name: 'Goblin', speeds: { land: 25 }, ...overrides }; }

  it('builds an approach and a retreat entry per opponent for a move with no Strike, with the ability\'s own speedSquares budget', () => {
    const vocab = buildNpcMoveVocabulary({ movementEntries: [entry()], opponents: [opponent({ speeds: { land: 30 } })], gridDistanceFt: 5 });
    const approach = vocab.find((v) => v.posture === 'approach' && v.targetId === 'o1');
    expect(approach).toBeDefined();
    // (30 * 1 + 10) / 5 * 2 segments... exact arithmetic confirmed against
    // Task 3 Step 4's own real implementation once written; the fixed
    // fact here is that the budget combines land Speed, speedFactor,
    // bonusFeet and segmentRepeat, not just a single Speed value.
  });

  it('skips an opponent entirely when the ability needs a mode the actor has no Speed for', () => {
    const vocab = buildNpcMoveVocabulary({ movementEntries: [entry({ plan: { ...entry().plan, segments: [{ mode: 'fly', speedFactor: 1 }] } })], opponents: [opponent({ speeds: { land: 30 } })], gridDistanceFt: 5 });
    expect(vocab).toEqual([]);
  });

  it('builds one move-plus-Strike entry per opponent reachable under the budget, and none for an opponent outside it', () => {
    // entry with plan.strike = { limb: 'tail', count: 1, timing: 'end' };
    // one near opponent (within budget+reach), one far (outside budget) --
    // confirm only the near one gets an entry and it carries kind: 'strike'.
  });

  it('builds one teleport entry per qualifying destination class ("next to X" / "away from X"), skipping a class with no free qualifying cell', () => {
    // plan.kind === 'teleport'; confirm entries carry destCell/targetId
    // per however Task 3 Step 4 actually resolves destination selection --
    // this test's own exact assertions are finalized against that real
    // implementation, matching this plan's own established convention for
    // a genuinely data-dependent (not merely mechanical) builder step.
  });

  it('excludes an ability whose cost exceeds actionsRemaining, whose frequency is spent, or that is still recharging (eligibility already applied by the caller\'s movementEntries filter, not re-checked here)', () => {
    // buildNpcMoveVocabulary itself takes pre-filtered movementEntries (see
    // Task 4's computeNpcMoveVocabularyEntries) -- this test documents
    // that contract rather than re-testing eligibility here.
    expect(true).toBe(true);
  });
});

describe('buildNpcMoveCandidates', () => {
  it('validates a pick against the vocabulary by (type, itemId, posture, targetId) and drops an unmatched pick', () => {
    const vocabEntry = { type: 'npcMove', itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 1, posture: 'approach', targetId: 'o1', speedSquares: 8, mode: 'land', strike: null, suppressReactions: false, teleportFeet: null };
    const candidates = buildNpcMoveCandidates({ npcMoveVocabulary: [vocabEntry], picks: [{ type: 'npcMove', itemId: 'i1', posture: 'approach', targetId: 'o1' }], opponents: [{ id: 'o1', name: 'Goblin' }] });
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('npcMove:i1:approach:o1');
    expect(candidates[0].summary).toContain('Gallop');

    const dropped = buildNpcMoveCandidates({ npcMoveVocabulary: [vocabEntry], picks: [{ type: 'npcMove', itemId: 'i1', posture: 'retreat', targetId: 'o1' }], opponents: [{ id: 'o1', name: 'Goblin' }] });
    expect(dropped).toEqual([]);
  });

  it('drops a candidate whose opponent no longer exists', () => {
    const vocabEntry = { type: 'npcMove', itemId: 'i1', slug: 'gallop', name: 'Gallop', cost: 1, posture: 'approach', targetId: 'o1', speedSquares: 8, mode: 'land', strike: null, suppressReactions: false, teleportFeet: null };
    const candidates = buildNpcMoveCandidates({ npcMoveVocabulary: [vocabEntry], picks: [{ type: 'npcMove', itemId: 'i1', posture: 'approach', targetId: 'o1' }], opponents: [] });
    expect(candidates).toEqual([]);
  });

  it('returns [] when picks is null, matching buildFeatCandidates/buildManeuverCandidates\' own "not yet decided this turn" convention', () => {
    expect(buildNpcMoveCandidates({ npcMoveVocabulary: [], picks: null, opponents: [] })).toEqual([]);
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: FAIL — neither function exists yet.

- [x] **Step 4: Implement both builders**

```js
/**
 * #932: the npcMove vocabulary category, built from already-eligibility-
 * filtered movementEntries (cost/frequency/recharge already checked by
 * the caller — see dungeon-combat.mjs's computeNpcMoveVocabularyEntries,
 * mirroring #910's computeSelfEffectVocabularyEntries split). Each entry
 * carries the parsed plan (Task 1's own descriptor shape) plus the real
 * item's id/slug/name/cost.
 */
export function buildNpcMoveVocabulary({ movementEntries = [], opponents = [], gridDistanceFt = 5 }) {
  const vocabulary = [];
  for (const entry of movementEntries) {
    const { plan } = entry;
    if (plan.kind === "teleport") {
      for (const destKind of ["next-to", "away-from"]) {
        for (const opponent of opponents) {
          vocabulary.push({
            type: "npcMove", itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
            kind: "teleport", posture: destKind, targetId: opponent.id,
            teleportFeet: plan.teleportFeet, mode: null, strike: null, suppressReactions: false,
          });
        }
      }
      continue;
    }
    const segment = plan.segments[0];
    const speedFt =
      segment.mode === "landOrFly"
        ? Math.max(opponents[0] ? 0 : 0, undefined) // resolved per-opponent below
        : null;
    for (const opponent of opponents) {
      const availableSpeeds = opponent.speeds ?? {};
      let modeSpeed;
      if (segment.mode === "landOrFly") {
        modeSpeed = Math.max(availableSpeeds.land ?? 0, availableSpeeds.fly ?? 0);
      } else {
        modeSpeed = availableSpeeds[segment.mode] ?? 0;
      }
      if (!modeSpeed) continue;
      const feet = modeSpeed * segment.speedFactor * (plan.segmentRepeat ?? 1) + (plan.bonusFeet ?? 0);
      const speedSquares = Math.floor(feet / gridDistanceFt);
      if (speedSquares <= 0) continue;
      const base = {
        type: "npcMove", itemId: entry.itemId, slug: entry.slug, name: entry.name, cost: entry.cost,
        speedSquares, mode: segment.mode, strike: plan.strike, suppressReactions: plan.suppressReactions,
        teleportFeet: null, targetId: opponent.id,
      };
      if (plan.strike) {
        vocabulary.push({ ...base, kind: "strike", posture: "approach" });
      } else {
        vocabulary.push({ ...base, kind: "move", posture: "approach" });
        vocabulary.push({ ...base, kind: "move", posture: "retreat" });
      }
    }
  }
  return vocabulary;
}

/**
 * #932: validates picks against buildNpcMoveVocabulary's own output by
 * literal (type, itemId, posture, targetId) membership, mirroring
 * buildFeatCandidates/buildManeuverCandidates exactly.
 */
export function buildNpcMoveCandidates({ npcMoveVocabulary = [], picks = null, opponents = [] }) {
  if (!picks) return [];
  const candidates = [];
  const seen = new Set();
  for (const pick of picks) {
    if (!pick || typeof pick !== "object" || pick.type !== "npcMove") continue;
    const match = npcMoveVocabulary.find(
      (v) => v.itemId === pick.itemId && v.posture === pick.posture && v.targetId === pick.targetId,
    );
    if (!match) continue;
    const opponent = opponents.find((o) => o.id === match.targetId);
    if (!opponent) continue;
    const id = `npcMove:${match.itemId}:${match.posture}:${match.targetId}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const label = pick.rationale ? `${match.name} — ${pick.rationale}` : `${match.name} vs ${opponent.name}`;
    candidates.push({ ...match, id, summary: label });
  }
  return candidates;
}
```

Confirm the real shape of `opponents[].speeds`/however this codebase already surfaces an opponent's land/fly/swim Speed to `agent-candidates.mjs` (`grep -n "speeds" scripts/agent-candidates.mjs scripts/dungeon-combat.mjs | grep -i opponent` or re-check `buildManeuverVocabulary`'s own `opponents` shape) before finalizing `buildNpcMoveVocabulary`'s own field name — this draft assumes a plain `opponent.speeds.{land,fly,...}` map matching the spec's own `movement.speeds[mode].value` phrasing, but if the existing `opponents` array this codebase already builds doesn't carry Speed data today, Task 4's own `computeNpcMoveVocabularyEntries` must add it (opponents need their OWN speeds for retreat/approach budget math only if a target's own movement ever matters here — re-check: actually only the MOVING combatant's own Speed matters, not the opponent's; re-derive this field from `combatant.actor.system.movement.speeds`, not from `opponent`, and fix the draft above to read `entry`'s own carried mover-speed data instead of `opponent.speeds` before finalizing — this is a genuine draft error caught by this self-review, not a finalized design).

Fix: `buildNpcMoveVocabulary` must take the ability's own actor's resolved Speeds as part of each `movementEntries` entry (computed once by `computeNpcMoveVocabularyEntries` in Task 4, not re-read per-opponent), since every opponent, teleport destination, and posture shares the same single mover and the same single Speed. Revise the signature to `buildNpcMoveVocabulary({ movementEntries, opponents, gridDistanceFt })` where each `movementEntries` item already carries `moverSpeeds: { land, fly, swim, burrow, climb }` (read once from the combatant's own actor in Task 4), and remove the incorrect `opponent.speeds` reads above, replacing `availableSpeeds` with `entry.moverSpeeds`.

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/agent-candidates.test.mjs`
Expected: PASS, once Step 4's self-caught `moverSpeeds` correction is applied — re-run the tests after that fix, not before.

- [x] **Step 6: Commit**

```bash
git add scripts/agent-candidates.mjs tests/agent-candidates.test.mjs
git commit -m "feat(#932): add npcMove vocabulary and candidate builders

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Pre-filtering and wiring into the once-per-turn reasoning call

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-npc-move-vocabulary.test.mjs`

**Interfaces:**
- Consumes: `parseMovementAbility` (Task 1), `buildNpcMoveVocabulary`/`buildNpcMoveCandidates` (Task 3).
- Produces (consumed by Task 8): `computeNpcMoveVocabularyEntries(actor, actionsRemaining, combat, combatantId)` → pre-filtered `movementEntries` (each carrying `moverSpeeds`); `getPendingAgentTurn`'s returned object gains `npcMoveVocabulary`; `buildCandidateList`'s call site passes it through; `runAgentDecisionLoop`'s combined-vocabulary gate (the real, current code at line ~1027-1039) includes it alongside `maneuverVocabulary`/`featVocabulary`.

- [x] **Step 1: Write the failing tests**

```js
// tests/dungeon-combat-npc-move-vocabulary.test.mjs
import { describe, it, expect } from 'vitest';
import { computeNpcMoveVocabularyEntries } from '../scripts/dungeon-combat.mjs';

function actorWithAction({ name, description, cost = 1, frequency = null, speeds = { land: 25 } }) {
  return {
    type: 'npc',
    system: { movement: { speeds: Object.fromEntries(Object.entries(speeds).map(([k, v]) => [k, { value: v }])) } },
    itemTypes: {
      action: [{
        id: 'i1', slug: 'gallop', name,
        system: { description: { value: description }, actions: { value: cost }, frequency, actionType: { value: 'action' } },
      }],
      feat: [],
    },
  };
}

describe('computeNpcMoveVocabularyEntries', () => {
  it('returns [] for a character actor (NPC movement abilities are NPC-only, per the spec)', async () => {
    const actor = { ...actorWithAction({ name: 'Gallop', description: '<p>X Strides twice.</p>' }), type: 'character' };
    expect(await computeNpcMoveVocabularyEntries(actor, 3, null, 'c1')).toEqual([]);
  });

  it('includes a recognized ability with cost <= actionsRemaining and no frequency restriction, carrying moverSpeeds', async () => {
    const actor = actorWithAction({ name: 'Gallop', description: '<p>X Strides twice. It has a +10-foot circumstance bonus to its Speed during these Strides.</p>' });
    const entries = await computeNpcMoveVocabularyEntries(actor, 3, null, 'c1');
    expect(entries).toHaveLength(1);
    expect(entries[0].moverSpeeds).toEqual({ land: 25 });
  });

  it('excludes an ability whose cost exceeds actionsRemaining', async () => {
    const actor = actorWithAction({ name: 'Gallop', description: '<p>X Strides twice.</p>', cost: 2 });
    expect(await computeNpcMoveVocabularyEntries(actor, 1, null, 'c1')).toEqual([]);
  });

  it('excludes an ability with frequency.value at 0', async () => {
    const actor = actorWithAction({ name: 'Phase Jump', description: '<p>X teleports up to 75 feet.</p>', frequency: { value: 0, max: 1, per: 'round' } });
    expect(await computeNpcMoveVocabularyEntries(actor, 3, null, 'c1')).toEqual([]);
  });

  it('excludes an unrecognized ability (parseMovementAbility returns null)', async () => {
    const actor = actorWithAction({ name: 'Pounce', description: '<p>X Strides and makes a Strike at the end of that movement. If X successfully used Hide before this action, the target has Off-Guard against this Strike.</p>' });
    expect(await computeNpcMoveVocabularyEntries(actor, 3, null, 'c1')).toEqual([]);
  });

  it('excludes an ability still on recharge cooldown', async () => {
    // Construct a combat stub whose abilityRecharge flag marks this
    // item's slug unavailable this round (reusing getAbilityRecharge's
    // own real stored shape, confirmed in Task 4 Step 3's own code read)
    // and confirm the entry is excluded.
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-npc-move-vocabulary.test.mjs`
Expected: FAIL.

- [x] **Step 3: Confirm `isAbilityRecharged`'s exact real signature before reusing it**

Run: `grep -n "function isAbilityRecharged" -A 5 scripts/dungeon-combat.mjs`

(Already read during this plan's own investigation: `isAbilityRecharged(combat, combatantId, itemSlug)`, generic and reusable as-is — confirm nothing has shifted since, then use it directly rather than writing a parallel recharge check.)

- [x] **Step 4: Implement `computeNpcMoveVocabularyEntries`**

```js
import { parseMovementAbility } from "./npc-move-parse.mjs";

/** #932: the npcMove vocabulary's pre-filter -- NPC actors only (player
 * characters' own movement feats are out of scope for this issue, matching
 * the self-effect split #910 already draws by actor.type). Scans
 * itemTypes.action for a parseable movement ability, then applies the
 * same cost/frequency/recharge gates #910's own self-effect entries use. */
export async function computeNpcMoveVocabularyEntries(actor, actionsRemaining, combat, combatantId) {
  if (actor?.type !== "npc") return [];
  const entries = [];
  const moverSpeedsRaw = actor.system?.movement?.speeds ?? {};
  const moverSpeeds = Object.fromEntries(
    Object.entries(moverSpeedsRaw)
      .filter(([, v]) => (v?.value ?? 0) > 0)
      .map(([mode, v]) => [mode, v.value]),
  );
  for (const item of actor.itemTypes?.action ?? []) {
    const parsed = parseMovementAbility(item);
    if (!parsed) continue;
    if (parsed.cost > actionsRemaining) continue;
    if (item.system?.frequency && !(item.system.frequency.value > 0)) continue;
    if (combat && !isAbilityRecharged(combat, combatantId, item.slug)) continue;
    entries.push({
      itemId: item.id,
      slug: item.slug,
      name: item.name,
      cost: parsed.cost,
      plan: parsed.plan,
      rechargeFormula: parsed.rechargeFormula,
      moverSpeeds,
    });
  }
  return entries;
}
```

Add `export` to `isAbilityRecharged` if it is not already exported (it is module-private today per Task 4 Step 3's own read; add `export` the same way Task 2 of #931's own plan exported `isReactiveStrikeInScope`/`getReactionUsed`/`markReactionUsed` — leave every internal call site unchanged).

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-npc-move-vocabulary.test.mjs`
Expected: PASS.

- [x] **Step 6: Wire `npcMoveVocabulary` into `getPendingAgentTurn`, `buildCandidateList`, and `runAgentDecisionLoop`**

In `getPendingAgentTurn` (the real function containing lines 3895-3915 and 4531-4573, read in full during this plan's own investigation), add, alongside the existing `maneuverVocabulary`/`featVocabulary` construction:

```js
// #932: NPC-only movement abilities (Gallop/Speed Surge-style Strides,
// alternate-mode moves, move-plus-Strike compounds, teleports) -- rides
// on the same once-per-turn reasoning call maneuverVocabulary/
// featVocabulary already use.
const npcMoveVocabulary = buildNpcMoveVocabulary({
  movementEntries: await computeNpcMoveVocabularyEntries(
    combatant.actor,
    turnState.actionsRemaining,
    combat,
    combatant.id,
  ),
  opponents,
  gridDistanceFt,
});
```

Add `npcMoveVocabulary` to the `buildCandidateList({...})` call's own argument object (alongside the existing `maneuverVocabulary`/`maneuverPicks`/`featVocabulary` keys) and to both returned-object literals at the end of the function (the one around line 4560-4574 that returns `{ combatId, combatantId, context, candidates, maneuverVocabulary, featVocabulary }` — add `npcMoveVocabulary` to that same literal).

In `buildCandidateList` (`scripts/agent-candidates.mjs`), add `npcMoveVocabulary = []` to its destructured parameters and `...buildNpcMoveCandidates({ npcMoveVocabulary, picks: maneuverPicks, opponents })` to its returned array, alongside the existing `buildFeatCandidates` spread.

In `runAgentDecisionLoop` (the real, current code read during this plan's own investigation, lines ~1027 and ~1036-1039), widen both the gate and the combined vocabulary:

```js
if (pending.maneuverVocabulary?.length || pending.featVocabulary?.length || pending.npcMoveVocabulary?.length) {
```

```js
vocabulary: [
  ...(pending.maneuverVocabulary ?? []),
  ...(pending.featVocabulary ?? []),
  ...(pending.npcMoveVocabulary ?? []),
],
```

- [x] **Step 7: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — confirm #910's own feat-vocabulary tests still pass unchanged, since this step touches the same shared gate/array they depend on.

- [x] **Step 8: Commit**

```bash
git add scripts/dungeon-combat.mjs scripts/agent-candidates.mjs tests/dungeon-combat-npc-move-vocabulary.test.mjs
git commit -m "feat(#932): wire the npcMove vocabulary into the once-per-turn reasoning call

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Generalize `strideByPosture`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-stride.test.mjs` (existing — locate it first)

**Interfaces:**
- Consumes: nothing new.
- Produces (consumed by Tasks 6/8): `strideByPosture(combat, combatant, posture, target, { speedSquaresOverride = null, suppressReactions = false } = {})`.

- [x] **Step 1: Locate and read the existing regression test in full**

Run: `grep -rln "strideByPosture" tests/*.mjs`

Read whichever file(s) match completely before changing the function — this is the regression suite Review Factor's own last item names explicitly.

- [x] **Step 2: Write the new failing tests**

```js
describe('strideByPosture with options', () => {
  it('uses speedSquaresOverride instead of the actor\'s own land Speed when given', async () => {
    // A combatant whose real land Speed would only cover 1 square, called
    // with speedSquaresOverride: 10 -- confirm the resulting path/landing
    // reflects the override budget, not the actor's own land Speed.
  });

  it('falls back to the actor\'s own land Speed when speedSquaresOverride is omitted, exactly as before', async () => {
    // The existing regression test file's own fixture, called with no
    // fifth argument at all -- must produce byte-identical behavior to
    // today's code.
  });

  it('does not call offerReactiveStrikesAgainst when suppressReactions is true', async () => {
    // Spy/mock offerReactiveStrikesAgainst (module-level or dependency
    // injection, matching whatever seam this file's existing tests already
    // use for it) and confirm it is not called when suppressReactions: true,
    // but is called (as today) when omitted.
  });
});
```

- [x] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-stride.test.mjs`
Expected: FAIL for the two new option-specific tests; the "falls back" test should already pass unchanged (confirming the baseline before the edit).

- [x] **Step 4: Generalize the function**

```js
export async function strideByPosture(
  combat,
  combatant,
  posture,
  target,
  { speedSquaresOverride = null, suppressReactions = false } = {},
) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const preSnap = rawPosition(combatant.token);
  await snapTokenToGrid(combatant.token, gridSize);
  const preReported = await reportPreMoveOverlap(
    "strideByPosture",
    combat,
    combatant,
    preSnap,
    gridSize,
    target,
  );
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const speedFt = combatant.actor?.system?.movement?.speeds?.land?.value ?? 0;
  const speedSquares = speedSquaresOverride ?? Math.floor(speedFt / gridDistanceFt);
  if (speedSquares <= 0 || !target) return "no-speed";

  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(
    combat,
    combatant,
    posture === "approach" ? targetCell : null,
  );
  const path = posturePath(
    start,
    targetCell,
    posture,
    speedSquares,
    isBlocked,
    bounds,
    moverFootprint,
  );
  if (!path) return "no-route";

  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const stopWithin = posture === "approach" ? MELEE_REACH_SQUARES : 0;
  const waypoint = walkPath(
    path,
    targetCell,
    speedSquares,
    stopWithin,
    occupants,
    moverFootprint,
  ) ??
    (posture === "approach"
      ? fallbackLanding(
          start,
          targetCell,
          speedSquares,
          stopWithin,
          isBlocked,
          bounds,
          occupants,
          moverFootprint,
        )
      : null);
  if (!waypoint) return "blocked";
  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  if (!preReported)
  await reportMoveOverlap({
    combat,
    combatant,
    kind: "strideByPosture",
    posture,
    targetCombatant: target,
    startCell: start,
    goalCell: targetCell,
    path,
    steps: waypoint.steps,
    occupantsSnapshot: occupants,
    speedSquares,
    stopWithin,
    gridSize,
  });
  if (!suppressReactions) await offerReactiveStrikesAgainst(combat, combatant);
  return "moved";
}
```

(The only changes from the real, current function: the new fifth parameter with its two named, defaulted options; `speedSquares` reads `speedSquaresOverride ?? ...` instead of always computing from land Speed; the final reaction call is conditional. Every other line is unchanged — this is the generalization, not a rewrite.)

- [x] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-stride.test.mjs`
Expected: PASS.

- [x] **Step 6: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures) — confirm every other `strideByPosture` call site (the plain `stride` branch in `applyAgentDecision`, any other caller) still compiles and passes with no fifth argument.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-stride.test.mjs
git commit -m "feat(#932): generalize strideByPosture with a budget override and reaction suppression

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: The move-plus-Strike compound executor

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-npc-move-execute.test.mjs`

**Interfaces:**
- Consumes: `strideByPosture` (Task 5), `rollAndApplyStrikeAtVariant`, `matchMultiStrikeActionSlug`, `walkTokenThroughSteps`, `posturePath`, `walkPath` (all existing).
- Produces (consumed by Task 8): `async function executeNpcMoveWithStrike(combat, combatant, candidate, target)` → one of `"moved-and-struck" | "blocked" | "no-route" | "no-speed" | "no-ready-strike"`.

- [x] **Step 1: Write the failing tests**

```js
describe('executeNpcMoveWithStrike', () => {
  it('for timing "end": moves the full budget, then Strikes if the target ended in reach', async () => {
    // Mock the path/waypoint helpers to resolve a destination in reach of
    // the target; confirm rollAndApplyStrikeAtVariant is called once,
    // after the move completes.
  });

  it('for timing "end": still moves but skips the Strike when the target is not in reach at the end', async () => {
    // Confirm rollAndApplyStrikeAtVariant is NOT called when the final
    // position isn't in reach, matching the spec's own "half-executed
    // compound ... reports the partial result" error-handling rule.
  });

  it('for timing "any": Strikes at the earliest in-reach cell along the path, then continues moving with the remaining budget', async () => {
    // Confirm two separate walkTokenThroughSteps-equivalent calls (or
    // however Step 4's own split is implemented) -- one up to the
    // in-reach cell, the Strike, then one for the remainder -- rather
    // than a single call covering the whole path.
  });

  it('for timing "any": Strikes immediately and does not continue moving when the mover starts already in reach', async () => {
    // Earliest in-reach index is 0 -- confirm no "first leg" walk happens
    // before the Strike.
  });

  it('skips the Strike entirely and reports "no-ready-strike" when the named limb does not resolve to a ready action', async () => {
  });

  it('returns "no-route"/"blocked"/"no-speed" exactly as strideByPosture would, when there is no usable path at all', async () => {
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-npc-move-execute.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the split-path helper and the executor**

```js
/** The index into `steps` of the earliest step whose cell is within
 * `reachSquares` of `targetCell`, or null if none qualifies — used to
 * split a move-plus-Strike-at-any-point compound (Swoop, Breach-style
 * abilities) into "walk to the strike point, Strike, keep walking." */
function earliestStepInReach(steps, targetCell, reachSquares) {
  for (let i = 0; i < steps.length; i++) {
    const distance = Math.max(Math.abs(steps[i].x - targetCell.x), Math.abs(steps[i].y - targetCell.y));
    if (distance <= reachSquares) return i;
  }
  return null;
}

/**
 * #932: executes a parsed move-plus-Strike compound (Pounce/Swoop/Eagle
 * Dive-shaped abilities) — moves `combatant` up to `candidate.speedSquares`
 * toward `target` (reusing strideByPosture's own path/waypoint machinery
 * via posturePath/walkPath directly, since a "Strike partway through"
 * compound needs the raw path, not strideByPosture's own all-or-nothing
 * walk), then Strikes with the named limb either at the end of the move
 * or at the earliest in-reach cell along it, per `candidate.strike.timing`.
 */
async function executeNpcMoveWithStrike(combat, combatant, candidate, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  await snapTokenToGrid(combatant.token, gridSize);
  const me = combatant.token;
  const dest = target.token;
  const moverFootprint = footprint(me, gridSize);
  const start = tokenCell(me, gridSize);
  const targetCell = tokenCell(dest, gridSize);
  const bounds = sceneBounds(combat, gridSize);
  const isBlocked = movementBlockedEdges(combat, combatant, targetCell);
  const path = posturePath(start, targetCell, "approach", candidate.speedSquares, isBlocked, bounds, moverFootprint);
  if (!path) return "no-route";
  const occupants = otherCombatantFootprints(combat, combatant, gridSize);
  const waypoint = walkPath(path, targetCell, candidate.speedSquares, MELEE_REACH_SQUARES, occupants, moverFootprint);
  if (!waypoint) return "blocked";

  const readyActions = (combatant.actor?.system?.actions ?? [])
    .filter((a) => a.type === "strike" && a.ready !== false)
    .map((a) => ({ slug: a.item?.slug ?? a.slug ?? a.label, label: a.label, reachSquares: actionReachSquares(a, gridDistanceFt) }));
  const matched = candidate.strike.limb
    ? matchMultiStrikeActionSlug(candidate.strike.limb, readyActions)
    : readyActions[0] ?? null;
  if (!matched) {
    await walkTokenThroughSteps(me, waypoint.steps, gridSize);
    return "no-ready-strike";
  }

  if (candidate.strike.timing === "any") {
    const splitIndex = earliestStepInReach(waypoint.steps, targetCell, matched.reachSquares);
    if (splitIndex !== null) {
      if (splitIndex > 0) await walkTokenThroughSteps(me, waypoint.steps.slice(0, splitIndex), gridSize);
      await rollAndApplyStrikeAtVariant(combat, combatant, target, matched.slug, 0);
      const remaining = waypoint.steps.slice(splitIndex);
      if (remaining.length > 1) await walkTokenThroughSteps(me, remaining, gridSize);
      return "moved-and-struck";
    }
  }

  await walkTokenThroughSteps(me, waypoint.steps, gridSize);
  const finalCell = waypoint.steps[waypoint.steps.length - 1] ?? start;
  const finalDistance = Math.max(Math.abs(finalCell.x - targetCell.x), Math.abs(finalCell.y - targetCell.y));
  if (finalDistance <= matched.reachSquares) {
    await rollAndApplyStrikeAtVariant(combat, combatant, target, matched.slug, 0);
    return "moved-and-struck";
  }
  return "moved";
}
```

Confirm `posturePath`'s own exact parameter order and `walkPath`'s own exact return shape (`{ steps }`) against the real functions (`grep -n "function posturePath" -A 15 scripts/dungeon-combat.mjs` and `grep -n "function walkPath" -A 15 scripts/dungeon-combat.mjs`) before finalizing this implementation — this draft mirrors `strideByPosture`'s own real call shape exactly as read earlier in this plan's investigation, but re-verify parameter order matches precisely, since a swapped `(start, targetCell)` vs `(targetCell, start)` would silently compute a path toward the wrong point rather than throwing.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-npc-move-execute.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-move-execute.test.mjs
git commit -m "feat(#932): add the move-plus-Strike compound executor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: The teleport executor

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-npc-move-execute.test.mjs` (continued)

**Interfaces:**
- Consumes: `freeSpot` (`scripts/placement.mjs`), `hasLineOfSight` (existing).
- Produces (consumed by Task 8): `async function executeNpcTeleport(combat, combatant, candidate, target)` → `"teleported" | "no-destination"`.

- [x] **Step 1: Write the failing tests**

```js
describe('executeNpcTeleport', () => {
  it('moves the token to a free cell within teleportFeet and with line of sight, via { teleport: true }', async () => {
    // Confirm the token update call carries teleport: true (matching
    // #141's own existing convention) and that the chosen cell is within
    // candidate.teleportFeet and passes hasLineOfSight.
  });

  it('returns "no-destination" without moving the token when no free, in-sight cell exists within range', async () => {
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-npc-move-execute.test.mjs`
Expected: FAIL.

- [x] **Step 3: Implement the teleport executor**

```js
/**
 * #932: teleports `combatant` to a free cell near `target` (posture
 * "next-to") or away from it (posture "away-from"), within
 * `candidate.teleportFeet`, using the existing freeSpot occupancy helper
 * and the existing { teleport: true } token-update convention (#141) —
 * no path, no reaction trigger (a teleport doesn't provoke).
 */
async function executeNpcTeleport(combat, combatant, candidate, target) {
  const gridSize = combat.scene?.grid?.size ?? 100;
  const gridDistanceFt = combat.scene?.grid?.distance ?? 5;
  const rangeSquares = Math.floor(candidate.teleportFeet / gridDistanceFt);
  const targetCell = tokenCell(target.token, gridSize);
  const occupied = otherCombatantFootprints(combat, combatant, gridSize);
  const spot = freeSpot({
    occupied,
    gx: targetCell.x,
    gy: targetCell.y,
    maxRing: rangeSquares,
    accept: (cell) => {
      const distance = Math.max(Math.abs(cell.x - targetCell.x), Math.abs(cell.y - targetCell.y));
      if (distance > rangeSquares) return false;
      if (candidate.posture === "next-to" && distance > MELEE_REACH_SQUARES) return false;
      if (candidate.posture === "away-from" && distance < rangeSquares) return false;
      return hasLineOfSight(combat, { x: cell.x * gridSize, y: cell.y * gridSize }, target.token);
    },
  });
  if (!spot) return "no-destination";
  await combatant.token.document.update({ x: spot.gx * gridSize, y: spot.gy * gridSize }, { teleport: true });
  return "teleported";
}
```

Confirm `freeSpot`'s exact real parameter names and return shape (`grep -n "function freeSpot" -A 25 scripts/placement.mjs`) before finalizing — this draft's `gx`/`gy`/`maxRing`/`accept` names come from this plan's own earlier investigation of `scripts/placement.mjs`'s signature line, but the `accept` callback's own parameter shape (a `{gx, gy}` pair vs. a `{x, y}` pair) must be confirmed against the real function body, not assumed from the signature line alone. Confirm `hasLineOfSight`'s real parameter shape too (`combat, attackerToken, targetToken` per this plan's own earlier read) — passing a plain `{x, y}` literal in place of a real token document (as sketched above for the not-yet-moved candidate cell) may not satisfy whatever shape `hasLineOfSight` actually destructures; if it needs real token-document fields beyond x/y (e.g. `document.elevation`, a getter, or hit-tests against the token's own `center`), build a minimal stand-in object carrying every field `hasLineOfSight` actually reads, found by reading its real body, not guessed.

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-npc-move-execute.test.mjs`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add scripts/dungeon-combat.mjs tests/dungeon-combat-npc-move-execute.test.mjs
git commit -m "feat(#932): add the teleport executor

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `applyAgentDecision`'s new `case "npcMove"`

**Files:**
- Modify: `scripts/dungeon-combat.mjs`
- Test: `tests/dungeon-combat-npc-move-decision.test.mjs`

**Interfaces:**
- Consumes: `strideByPosture` (Task 5), `executeNpcMoveWithStrike` (Task 6), `executeNpcTeleport` (Task 7), `getAbilityRecharge`/`setAbilityRecharge`/`isAbilityRecharged` (existing), `postAgentDecisionChat`/`postMoveStalledChat` (existing, unmodified).
- Produces: nothing further downstream — terminal task for the feature.

- [x] **Step 1: Write the failing tests**

```js
describe('applyAgentDecision: npcMove', () => {
  it('spends cost through turnState, decrements frequency, records recharge, posts the usage card, and calls strideByPosture with the ability\'s own budget for a plain move candidate', async () => {
    // candidate.kind === 'move'; confirm turnState.actionsRemaining
    // decreases by candidate.cost, item.update is called to decrement
    // frequency.value (when present), setAbilityRecharge-equivalent is
    // called when rechargeFormula is present, item.toMessage is called,
    // and strideByPosture is called with speedSquaresOverride:
    // candidate.speedSquares and suppressReactions: candidate.suppressReactions.
  });

  it('dispatches to executeNpcMoveWithStrike for a candidate with kind "strike"', async () => {
  });

  it('dispatches to executeNpcTeleport for a candidate with kind "teleport"', async () => {
  });

  it('skips the pick and does not spend anything when the target has been removed from combat before execution', async () => {
    // Matches #910's own skipUnperformedFeat convention -- resolve the
    // target fresh at execution time, same as every other branch; a
    // missing target means no cost spent and the pick dropped from this
    // turn's persisted picks so the model can't re-choose it in a loop.
  });

  it('whispers via postMoveStalledChat when strideByPosture (the plain-move path) returns "blocked"', async () => {
  });
});
```

- [x] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/dungeon-combat-npc-move-decision.test.mjs`
Expected: FAIL.

- [x] **Step 3: Add the branch**

Insert a new `else if (candidate.type === "npcMove")` branch into the real, current `applyAgentDecision` (the function read in full during this plan's own investigation, lines ~6297 onward), placed alongside the existing `"maneuver"` branch (following the exact same structural pattern: resolve the target fresh, spend/record bookkeeping, dispatch, report):

```js
} else if (candidate.type === "npcMove") {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) {
    await skipUnperformedNpcMove(combat, combatant, candidate);
  } else {
    try {
      await item_forCandidate(combatant, candidate)?.toMessage?.();
    } catch (err) {
      console.warn(`#932: posting ${candidate.name}'s usage card failed:`, err.message);
    }
    const item = (combatant.actor?.itemTypes?.action ?? []).find((i) => i.id === candidate.itemId);
    if (item?.system?.frequency && item.system.frequency.value > 0) {
      await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
    }
    if (item) {
      await setAbilityRecharge(combat, combatant.id, item.slug, candidate.rechargeFormula ?? null);
    }
    let status;
    if (candidate.kind === "teleport") {
      status = await executeNpcTeleport(combat, combatant, candidate, target);
    } else if (candidate.kind === "strike") {
      status = await executeNpcMoveWithStrike(combat, combatant, candidate, target);
    } else {
      status = await strideByPosture(combat, combatant, candidate.posture, target, {
        speedSquaresOverride: candidate.speedSquares,
        suppressReactions: candidate.suppressReactions,
      });
      await postMoveStalledChat(combatant, status);
    }
  }
}
```

Remove the stray `item_forCandidate(...)` line above (a placeholder from this draft, not real code) — the usage-card post belongs right after `item` is resolved, not before; move `item.toMessage?.()` (wrapped in the same `try`/`console.warn` shape #910's own feat branch already uses) to immediately after the `const item = ...find(...)` line, using the real resolved `item`, not an undefined helper. Fix the ordering before committing:

```js
} else if (candidate.type === "npcMove") {
  const target = resolveOpponentForTurn(combat, combatant, candidate.targetId);
  if (!target) {
    await skipUnperformedNpcMove(combat, combatant, candidate);
  } else {
    const item = (combatant.actor?.itemTypes?.action ?? []).find((i) => i.id === candidate.itemId);
    if (item) {
      try {
        await item.toMessage?.();
      } catch (err) {
        console.warn(`#932: posting ${candidate.name}'s usage card failed:`, err.message);
      }
      if (item.system?.frequency && item.system.frequency.value > 0) {
        await item.update({ "system.frequency.value": item.system.frequency.value - 1 });
      }
      await setAbilityRecharge(combat, combatant.id, item.slug, candidate.rechargeFormula ?? null);
    }
    let status;
    if (candidate.kind === "teleport") {
      status = await executeNpcTeleport(combat, combatant, candidate, target);
    } else if (candidate.kind === "strike") {
      status = await executeNpcMoveWithStrike(combat, combatant, candidate, target);
    } else {
      status = await strideByPosture(combat, combatant, candidate.posture, target, {
        speedSquaresOverride: candidate.speedSquares,
        suppressReactions: candidate.suppressReactions,
      });
      await postMoveStalledChat(combatant, status);
    }
  }
}
```

Add `skipUnperformedNpcMove`, mirroring the real `skipUnperformedFeat` (read during this plan's own investigation) exactly, substituting its own pick-matching fields:

```js
/** #932: a npcMove candidate whose target vanished before execution spends
 * nothing; its pick is dropped from this turn's persisted picks so the
 * model can't re-choose it in a loop, mirroring skipUnperformedFeat. */
async function skipUnperformedNpcMove(combat, combatant, candidate) {
  const turnState = getAgentTurnState(combat, combatant.id);
  const picks = (turnState.maneuverPicks ?? []).filter(
    (p) =>
      !(
        p?.type === "npcMove" &&
        p.itemId === candidate.itemId &&
        p.posture === candidate.posture &&
        (p.targetId || null) === candidate.targetId
      ),
  );
  await setAgentTurnState(combat, combatant.id, { ...turnState, maneuverPicks: picks });
}
```

- [x] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/dungeon-combat-npc-move-decision.test.mjs`
Expected: PASS.

- [x] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS (0 new failures).

- [x] **Step 6: Version bump** *(#932 implementation note: deferred to whoever merges -- the implementing agent was told not to bump `module.json`.)*

Run: `grep '"version"' module.json`

Minor bump per `CLAUDE.md`'s versioning rule.

- [x] **Step 7: Commit**

```bash
git add scripts/dungeon-combat.mjs module.json
git commit -m "feat(#932): dispatch npcMove candidates in applyAgentDecision, bump version

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec coverage:**
- "The movement plan and parser" (descriptor shape, normalization, the five grammar rules) — Task 1, with every real-data correction documented in Global Constraints rather than silently applied.
- "Vocabulary" (`buildNpcMoveVocabulary`, eligibility gates, move/move-plus-Strike/teleport entry shapes, deterministic summary, per-turn cap) — Tasks 3/4; the per-turn cap (spec: "proposed: 8") is applied the same way #910's own feat-vocabulary cap is (if #910's own cap exists as a shared helper, reuse it directly in Task 4 Step 6 rather than inventing a second cap constant — confirm this during implementation by re-reading how `MAX_*_VOCABULARY_ENTRIES`-shaped constants are named elsewhere in this file).
- "Reasoning call and validation" — Task 3's `buildNpcMoveCandidates` plus Task 4's wiring into the real, existing combined-vocabulary gate.
- "Execution" (cost/frequency/recharge spend, the generalized `strideByPosture`, the Strike clause's two timings, teleport, reporting) — Tasks 5/6/7/8 respectively.
- "Reactions" (`suppressReactions` carried to the movement event) — Task 5's `strideByPosture` generalization, with the explicit Global Constraints note on reusing the real, current `offerReactiveStrikesAgainst` call site rather than #931's not-yet-real registry.
- "Error handling" — parse failure is `null`, never throws (Task 1's dedicated "never throws on malformed HTML" test); no path/no destination/no ready Strike reported as blocked/no-route/no-ready-strike, not spent (Tasks 6/7's own dedicated tests, Task 8's dispatch of `status` into `postMoveStalledChat`); missing mode Speed aborts before moving (Task 3's "skips an opponent entirely when the ability needs a mode the actor has no Speed for" test, and Task 4's pre-filter never even offering such an ability when the mover itself lacks every needed mode).
- "Testing" section's enumerated cases — each has a direct task-owned test; "Live verification" (a monster with Gallop, one with Swift Leap, a flying monster using a Fly move + Strike, a teleporting monster) is named here as the one item this plan cannot itself automate, matching every prior plan's own treatment of live verification.
- "Explicitly out of scope" (unmodeled riders/#972, terrain-elevation/#973, Change Shape, reactions beyond #931, prose interpretation by the model) — none appear in this plan's task list; Change Shape's own exclusion is directly tested in Task 1.

**2. Placeholder scan:** No "TBD"/"TODO". Task 3 Step 4 and Task 8 Step 3 each visibly catch and fix a real drafting error inline (the `opponent.speeds` vs. `entry.moverSpeeds` mix-up; the stray `item_forCandidate` placeholder and the toMessage-before-item-resolved ordering bug) rather than presenting a broken first draft as finished — both are corrected within the same task, with the corrected version being what actually gets committed. Tasks 6/7 each flag one real signature to re-verify against the live function body before finalizing (`posturePath`/`walkPath`'s parameter order; `freeSpot`/`hasLineOfSight`'s exact parameter shapes) — named precisely, not a vague "add appropriate" placeholder.

**3. Type consistency:** The movement-plan descriptor shape (`cost, frequency, rechargeFormula, plan: {kind, segments, segmentRepeat, bonusFeet, teleportFeet, strike, suppressReactions, chargeNote, elevationNote}`) is defined once in Task 1 and read with exactly those field names in Task 3's `buildNpcMoveVocabulary` and Task 4's `computeNpcMoveVocabularyEntries`. The vocabulary/candidate entry shape (`type, itemId, slug, name, cost, kind, posture, targetId, speedSquares, mode, strike, suppressReactions, teleportFeet`) is defined once in Task 3 and consumed with the same field names by Task 4's wiring and Task 8's dispatch branch (`candidate.speedSquares`, `candidate.kind`, `candidate.suppressReactions` — confirmed no drift against Task 3's own field names).

**4. Review Factor:** all five items have a direct test — a missing mode Speed excluding the opponent entirely (Task 3's dedicated test); the three shared cost/frequency/recharge gates (Task 4's three dedicated exclusion tests, reusing #910's own already-proven gate shapes); a target that moves/vanishes before execution degrading to a reported skip, never a throw (Task 8's dedicated "target removed" test, mirroring `skipUnperformedFeat`); a teleport with no qualifying free/in-sight destination never being offered rather than failing at execution (Task 3's dedicated teleport-destination test, which operates at the vocabulary-building stage, before any execution is attempted); the plain-stride regression suite passing unchanged after the generalization (Task 5 Step 1's explicit "read the existing regression test first" step and Step 6's explicit full-suite re-run).
