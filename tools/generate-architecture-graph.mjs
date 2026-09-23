#!/usr/bin/env node
/**
 * Regenerates the Mermaid dependency diagram embedded in
 * docs/architecture.md (#69) — walks scripts/ and tools/agent-loop/ for
 * .mjs files, parses each file's own relative `import ... from "./x.mjs"`
 * statements, and emits a `graph LR` grouped into subgraph clusters by
 * subsystem. Bare-specifier imports (npm packages like `zod`,
 * `@modelcontextprotocol/sdk`) are ignored — this is an internal
 * module-to-module graph, not a full dependency tree.
 *
 * The subsystem groupings below are hand-maintained, not derived — a file
 * that doesn't fit any of them falls into "Other" so it still shows up
 * (nothing is silently dropped), which is the signal to update this table
 * the next time `.claude/skills/update-architecture-docs` runs.
 *
 * Run: node tools/generate-architecture-graph.mjs (also `npm run
 * architecture:graph`) — prints the Mermaid block to stdout, ready to
 * paste into docs/architecture.md.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(fileURLToPath(new URL(".", import.meta.url).href)).replace(
  /\/tools$/,
  "",
);

function walk(dir) {
  let out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) out = out.concat(walk(full));
    else if (entry.endsWith(".mjs")) out.push(full);
  }
  return out;
}

const IMPORT_RE = /import\s+(?:[\s\S]*?)\s+from\s+["']([^"']+)["']/g;

function relativeImports(file) {
  const content = readFileSync(file, "utf8");
  const specs = [];
  let m;
  IMPORT_RE.lastIndex = 0;
  while ((m = IMPORT_RE.exec(content))) {
    if (m[1].startsWith(".")) specs.push(m[1]);
  }
  return specs.map((spec) => relative(ROOT, join(dirname(file), spec)));
}

// Subsystem groupings (#69's own scope) — order matters: first match wins,
// so more specific groups (agent-loop) are listed before the broad
// mechanics-pairs bucket that would otherwise also claim them.
const GROUPS = [
  {
    name: "Agent-loop (external LLM combat AI)",
    match: (p) => p.startsWith("tools/agent-loop/"),
  },
  {
    name: "GM-less relay & permissions",
    match: (p) =>
      [
        "scripts/dungeon-remote.mjs",
        "scripts/dungeon-permissions.mjs",
        "scripts/player-choice.mjs",
        "scripts/choice-prompts.mjs",
      ].includes(p),
  },
  {
    name: "Party-follow",
    match: (p) =>
      [
        "scripts/dungeon-follow.mjs",
        "scripts/dungeon-follow-mechanics.mjs",
      ].includes(p),
  },
  {
    name: "Combat automation (in-module heuristic)",
    match: (p) =>
      [
        "scripts/dungeon-combat.mjs",
        "scripts/combat-rewards.mjs",
        "scripts/agent-candidates.mjs",
        "scripts/dungeon-strike-riders.mjs",
        "scripts/dungeon-critical-deck.mjs",
      ].includes(p),
  },
  {
    name: "Puzzle / trap / skill-challenge / treasure mechanics",
    match: (p) =>
      [
        "scripts/puzzle-mechanics.mjs",
        "scripts/puzzle.mjs",
        "scripts/trap-mechanics.mjs",
        "scripts/trap-combat.mjs",
        "scripts/trap-library.mjs",
        "scripts/skill-challenge-mechanics.mjs",
        "scripts/skill-challenge.mjs",
        "scripts/treasure.mjs",
        "scripts/narrative-mechanics.mjs",
      ].includes(p),
  },
  {
    name: "Encounter generation",
    match: (p) =>
      [
        "scripts/encounter-generator.mjs",
        "scripts/encounter-deck.mjs",
        "scripts/encounter-roster.mjs",
        "scripts/generator-registry.mjs",
        "scripts/default-generator.mjs",
        "scripts/creature-art.mjs",
        "scripts/trait-picker.mjs",
        "scripts/cover-items.mjs",
      ].includes(p),
  },
  {
    name: "Dungeon generation / sequencing",
    match: (p) =>
      [
        "scripts/dungeon-deck.mjs",
        "scripts/dungeon-layout.mjs",
        "scripts/prng.mjs",
      ].includes(p),
  },
  {
    name: "Foundry scene building",
    match: (p) =>
      [
        "scripts/dungeon-scene.mjs",
        "scripts/foundry-api.mjs",
        "scripts/placement.mjs",
        "scripts/data-loader.mjs",
        "scripts/dungeon-sound.mjs",
        "scripts/audio.mjs",
      ].includes(p),
  },
  {
    name: "Run state & UI",
    match: (p) =>
      [
        "scripts/dungeon-runner.mjs",
        "scripts/module.mjs",
        "scripts/ui/dungeon-app.mjs",
        "scripts/world-macros.mjs",
      ].includes(p),
  },
];

function groupFor(path) {
  return GROUPS.find((g) => g.match(path))?.name ?? "Other";
}

function nodeId(path) {
  return path.replace(/[^a-zA-Z0-9]/g, "_");
}

function main() {
  const files = [
    ...walk(join(ROOT, "scripts")),
    ...walk(join(ROOT, "tools", "agent-loop")),
  ].map((f) => relative(ROOT, f));

  const edges = [];
  for (const file of files) {
    for (const dep of relativeImports(join(ROOT, file))) {
      edges.push([file, dep]);
    }
  }

  const byGroup = new Map();
  for (const file of files) {
    const g = groupFor(file);
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(file);
  }

  const lines = ["```mermaid", "graph LR"];
  for (const group of [...GROUPS.map((g) => g.name), "Other"]) {
    const members = byGroup.get(group);
    if (!members?.length) continue;
    lines.push(`  subgraph ${JSON.stringify(group)}`);
    for (const file of members.sort()) {
      const label = file
        .replace(/^scripts\//, "")
        .replace(/^tools\/agent-loop\//, "agent-loop/");
      lines.push(`    ${nodeId(file)}["${label}"]`);
    }
    lines.push("  end");
  }
  for (const [from, to] of edges) {
    lines.push(`  ${nodeId(from)} --> ${nodeId(to)}`);
  }
  lines.push("```");

  console.log(lines.join("\n"));
}

main();
