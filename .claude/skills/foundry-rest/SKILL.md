---
name: foundry-rest
description: Use when reading from or writing to a running Foundry VTT world over the foundryrestapi.com relay — querying compendia, inspecting or editing actors and scenes, or verifying that a module behaves live. Covers connecting, the relay's script filter, and the failure modes that look like something else.
---

# Foundry REST API

Runs JavaScript inside a live Foundry world and returns the result. The world must be open in a browser with the relay module active; there is no headless mode.

## Running a script

```bash
.claude/skills/foundry-rest/foundry-exec.sh script.js
echo 'return game.actors.size;' | .claude/skills/foundry-rest/foundry-exec.sh
```

Run it from the repository root; it reads `FOUNDRY_REST_API_KEY` from the `.env` beside it.

It finds the client, posts the script, prints `result` as JSON, and exits non-zero on failure. `FOUNDRY_REST_API_KEY` comes from the environment or a `.env` in the working directory.

| exit | meaning | what to do |
|---|---|---|
| 2 | banned text, or no key | rename the variable; see the filter below |
| 3 | relay refused (`Invalid client ID`) | the socket dropped — wait and retry |
| 5 | the script threw | fix the code |

Overrides: `FOUNDRY_BASE_URL`, `FOUNDRY_CLIENT_ID`, `FOUNDRY_TIMEOUT` (seconds, default 300).

Scripts are async — top-level `await` works. Return a value explicitly; there is no implicit last-expression result. Return plain data: documents do not serialise, so map them to objects first.

## The script filter

The relay scans the **raw text** before running it. It does not parse, so a banned word inside a string, inside a comment, or inside unreachable code is refused just the same. Matching is case-sensitive.

Refused: `globalThis`, `import(`, `eval(`, `new Function`, `XMLHttpRequest`, `game.settings.set`, `apiKey`, `password`, `localStorage`, `sessionStorage`.

Allowed, despite looking risky: `window`, `document`, `process`, `require`, `fetch`, `WebSocket`, `Setup`, `location`, `game.settings.get`, `deleteDocuments`, `Scene#delete`.

Two consequences worth knowing before they cost an hour:

- **`apiKey` is the one that catches people.** A variable named `apiKeys` is refused; `apikey`, `API_KEY` and `rapidKey` are fine. The error says "forbidden patterns" and names nothing, so it reads like the surrounding code is at fault.
- **`game.settings.set` is refused, so module and world settings cannot be written.** Anything stored in settings — deck state, flags a module keeps there — can be read and not restored. Treat a script that mutates settings-backed state as one-way before running it.

`foundry-exec.sh` checks for these first and tells you which word to remove.

## "Invalid client ID" usually is not

The relay reports a dropped socket as an invalid client. The id is stable across reconnects, so the same id that just failed works again a minute later, and `/clients` may still list the client with `isOnline: true` while calls fail.

Do not conclude Foundry is closed. Retry, and only then check whether the world is actually open. Long scripts fail this way more often, so prefer several small queries over one large one.

```bash
curl -s "$FOUNDRY_BASE_URL/clients" -H "x-api-key: $FOUNDRY_REST_API_KEY"
# → clientId, isOnline, worldId, foundryVersion, systemId, systemVersion
```

## Reading compendia

Index first: `getIndex` is cheap and covers most questions. `getDocument` loads the whole actor and is slow enough that a loop over a pack needs a raised `FOUNDRY_TIMEOUT`.

An index carries only `_id`, `img`, `name`, `type` and `uuid` unless you ask for more.

```js
const pack = game.packs.get('pf2e.pathfinder-monster-core');
const idx = await pack.getIndex({
  fields: ['type', 'system.details.level.value', 'system.traits.value',
           'system.traits.size.value']
});
return idx.filter(e => e.type === 'npc'
    && (e.system?.traits?.value ?? []).includes('dragon'))
  .map(e => `${e.name} L${e.system.details.level.value}`);
```

Ask for every field you read. A field you did not request is `undefined`, which reads as a creature that has no level rather than a question you did not ask.

**The index is cached per pack and enriched in place.** A second `getIndex` with more fields mutates the same object an earlier call returned, so a result you are already holding gains fields retroactively. Two ways that misleads:

- A field looks like a default because something earlier in the session requested it. Checking against a pack the session has already touched will tell you it is free when it is not.
- A filter that ran correctly early on returns different rows when re-run, without the code changing.

Request what you need on every call rather than relying on a warm cache, and confirm assumptions about defaults against a pack nothing has read yet.

## Verifying a change without making one

Reading is free; writing is not. Before a script that creates or deletes, capture what exists so the change can be undone:

```js
const before = new Set(game.actors.map(a => a.id));
// ... do the thing ...
return game.actors.filter(a => !before.has(a.id)).map(a => ({ id: a.id, name: a.name }));
```

Deleting an unlinked token by its actor is unreliable — `token.actor.id` does not match the base actor the way you expect. Delete tokens by the ids you recorded when you made them, and check the scene afterwards rather than trusting the count.

## Before writing to someone's world

This runs against a real game, usually someone else's. A script is not a test.

- **Say what will change before running it**, and confirm anything that destroys or consumes. Depleting decks, spent resources and deleted documents are not restorable through this API, because settings cannot be written.
- **Clean up what you create**, and verify the cleanup rather than assuming it worked.
- Prefer planning or querying over applying. Many modules expose a dry-run path; use it.
