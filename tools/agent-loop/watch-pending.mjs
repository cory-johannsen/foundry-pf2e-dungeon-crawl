#!/usr/bin/env node
/**
 * Dumb detector for #19: polls the Foundry relay for pending flavor-
 * customization requests and prints one line per newly-appeared entry.
 * Makes no judgment about content and holds no LLM/provider config at all —
 * it exists only to give an interactive agent session (via this harness's
 * Monitor tool) a fast wake signal, without reintroducing the
 * hardcoded-single-provider coupling `mcp-server.mjs` was built to avoid
 * (see tools/agent-loop/README.md's "Flavor customization... via MCP"
 * section). All triage and content generation still happens only in that
 * connected session, via mcp-server.mjs's five tools.
 *
 * Run: node tools/agent-loop/watch-pending.mjs
 * Requires: FOUNDRY_BASE_URL, FOUNDRY_REST_API_KEY (same as poll.mjs).
 * Optional: PF2EDC_WATCH_INTERVAL_MS (default 5000).
 */
import { readEnvOrDotenv } from "./foundry-client.mjs";
import { listPendingCustomizations } from "./mcp-server.mjs";

const WATCH_INTERVAL_MS = Number(
  readEnvOrDotenv("PF2EDC_WATCH_INTERVAL_MS") ?? 5000,
);

/** Identity key for one pending entry across polls. All four kinds carry
 * sceneId (confirmed against scripts/trap-combat.mjs and
 * scripts/dungeon-runner.mjs); a trap is scene+actor-scoped, the other
 * three kinds are scene+room-scoped. */
export function keyForPending(entry) {
  const id = entry.kind === "trap" ? entry.actorId : entry.roomId;
  return `${entry.kind}:${entry.sceneId}:${id}`;
}

/** Pure diff over one poll's snapshot against the previous poll's key set. */
export function diffPending(previousKeys, currentEntries) {
  const currentKeys = new Set(currentEntries.map(keyForPending));
  const newEntries = currentEntries.filter(
    (entry) => !previousKeys.has(keyForPending(entry)),
  );
  return { newEntries, currentKeys };
}

function describePending(entry) {
  const id = entry.kind === "trap" ? entry.actorId : entry.roomId;
  return `pending: ${entry.kind} id=${id} name=${JSON.stringify(entry.name ?? null)}`;
}

async function main() {
  console.error(
    `watch-pending: polling every ${WATCH_INTERVAL_MS}ms for new pending customizations`,
  );
  let previousKeys = new Set();
  for (;;) {
    try {
      const current = await listPendingCustomizations();
      const { newEntries, currentKeys } = diffPending(previousKeys, current);
      for (const entry of newEntries) {
        console.log(describePending(entry));
      }
      previousKeys = currentKeys;
    } catch (err) {
      // No escalation logic here by design (spec's Detector-script section)
      // — the connected session's own fallback wakeup is the safety net.
      console.error("watch-pending: poll failed, will retry:", err.message);
    }
    await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
