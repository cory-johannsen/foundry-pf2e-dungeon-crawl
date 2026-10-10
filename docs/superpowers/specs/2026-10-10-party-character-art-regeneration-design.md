# Regenerate the Cleric and Thief Player Art (Live World Only)

**Issue:** #1260 — regenerate the token/portrait art for the player characters **Cleric** and **Thief** with the current token-art pipeline. The result is **live-world only**: nothing is saved into the module's assets, `data/creature-art.json` or the generated-creature-art pack.

**Builds on:** `tools/generate-token-art.mjs` (the ComfyUI pipeline: `STYLE`, `NEGATIVE`, the DreamShaper XL Lightning defaults, attempt/background-score logic, `shrink`, routing), `tools/token-prompts.mjs`, the existing `leshy` and `halfling` ancestry subjects, and the art-tools notes (`~/src/art-tools`, outside the repo). Related feedback already recorded by the owner: ComfyUI first (Gemini is out of credits), review defining features, never delete an image before the replacement has been seen.

**Status:** Approved. Scope was decided in a foreground question session with the owner on 2026-10-10 (see "Resolved decisions").

## Summary

Two player characters have art that was made on a poor model. This spec defines a **repeatable, reviewed, live-only workflow**: a small committed script that reuses the token-art pipeline to generate **four candidates per character** into a staging folder outside the repo; a **hand-reviewed subject line per character** (approved by the owner before any generation); a **contact sheet** for the owner to pick from; and an **apply step** that copies the chosen image to a **new versioned filename** in the Foundry data directory and updates the Actor, its prototype token and the placed scene tokens, keeping the old files until the owner approves.

## Investigation findings

- **Current state** (live world PF2ETest, read 2026-10-10). Cleric — actor `JXoEHUzeuuvD5m75`, Chrysanthemum Leshy cleric, level 3, scene token `izzH8gBZoGtuU2QJ` (linked). Thief — actor `Wd5KR4tYminiWPEh`, Hillock Halfling rogue, level 3, scene token `ptzg9gUHwunjMwzR` (linked). For each, `img` and `prototypeToken.texture.src` are the same file, `party-portraits/cleric.webp` / `thief.webp`, under the Foundry data directory (`/srv/foundry/data/Data/party-portraits/`), 512×512 webp.
- **What is wrong with them** (viewed 2026-10-10). The Cleric is a dark green humanoid face with leaves — the "green man" reading the pipeline's own notes warn about; a leshy's defining feature here is a carved wooden gourd head. The Thief is a near-monochrome hooded human; nothing reads as a halfling and the pipeline's style demands full, saturated colour.
- **The pipeline's shape.** `generate-token-art.mjs` works from fixed lists (`SUBJECTS` for ancestry warriors including `leshy` and `halfling`, `CREATURES`, `MONSTER_ART`, `ICONS`), composes a prompt from `STYLE` + the subject + a negative list, generates 1024×1024 through ComfyUI (DreamShaper XL Lightning, 6 steps, CFG 2, about 41 s/image), scores the border for a plain background (`backgroundScore`), retries up to `MAX_ATTEMPTS`, and stores a 512 webp (`shrink`). Seeds derive from the subject id plus `--reroll`. It writes into `assets/tokens` in the repo (`dirFor`) and has no way to write elsewhere. Its helpers are private to the file, and the subjects are "warriors" with no class or gear.
- **Backends.** ComfyUI is the default; OpenRouter fallbacks exist; the Gemini API is out of credits and paid backends are not to be used without the owner's say.
- **Tokens placed on the scene** are separate documents: updating the Actor's art and the prototype token does not rewrite the texture stored on an already-placed (even linked) scene token.
- **Cache.** Foundry and browsers cache by URL; replacing a file in place under the same name leaves open clients on the old image.

## Resolved decisions

1. **Tooling:** a new thin script, `tools/generate-party-art.mjs`, that reuses the generator's prompt and ComfyUI plumbing (the helpers it needs are exported from `generate-token-art.mjs`) and writes **outside the repo**. The script is committed; the generated images are not.
2. **Prompts:** reviewed, hand-written subject lines seeded from the live actor data and **shown to the owner for approval before generating**; the tuned leshy and halfling wording is reused.
3. **Placement:** new versioned filenames beside the old ones in the Foundry data directory (not in git), then update the Actor, prototype token and placed scene tokens; **keep the old files until the owner approves**. One 512 square bust serves portrait and token, as today.
4. **Review:** four candidates per character in a staging folder with a contact sheet; the owner picks; only then is anything applied.

## Design

### Script (`tools/generate-party-art.mjs`)

```
node tools/generate-party-art.mjs --subjects <file.json> --out <staging-dir> [--count 4] [--reroll N] [--only <id>]
node tools/generate-party-art.mjs --apply --manifest <staging-dir>/manifest.json --pick cleric=2,thief=3
```

- **Generation mode.** Reads a subject file (`[{ id, who, avoid?, notes? }]`; for example `{ id: "cleric", who: "…" }`), builds each prompt exactly as the token pipeline does (the shared `STYLE`, the subject sentence, the `NEGATIVE` list plus the subject's `avoid`), and generates `--count` candidates (default 4) per subject through ComfyUI with the pipeline defaults. Seeds derive from the subject id, the candidate index and `--reroll`, so a rerun reproduces. Each candidate is background-checked (`backgroundScore`) and shrunk to 512 webp. Outputs: `<out>/<id>/cand-1.webp … cand-4.webp`, `<out>/manifest.json` (prompts, negative lists, seeds, models, scores, timestamps) and `<out>/contact-sheet.png` (candidates side by side per character, labeled).
- **The shared helpers** (`enqueue`, `waitFor`, `fetchImage`, `backgroundScore`, `shrink`, the prompt composer) become named exports of `generate-token-art.mjs`; the module has no behavior change and the existing CLI is untouched.
- **Backend.** ComfyUI only. If every candidate for a character fails the background check after the retry budget, the script stops for that character and reports it (the owner then decides on a reroll, an alternative, or a hand-made image); it never calls a paid backend by itself.
- **Apply mode** is separate and explicit (below).

### Subject lines (approval gate)

Before generating, the working agent reads the two live actors (ancestry, heritage, class, deity, equipped weapons/armor, any identifying gear) and drafts one subject sentence each, shown to the owner for approval or edits. Starting seeds, to be refined with the live data:

- **Cleric:** a Chrysanthemum leshy cleric — a small plant creature whose entire head is a carved wooden gourd with cut-out eyes and mouth, a ring of chrysanthemum petals around it, body of bound vines and leaves, wearing cleric's vestments and a visible holy symbol of the character's deity — with the `leshy` subject's `avoid` list (human face, beard, antlers, laurel wreath, heraldic crest, …).
- **Thief:** a Hillock halfling rogue — small and round-cheeked with curly hair, a clever cheerful face under a dark hood, leather armor, a dagger at the belt — in full colour and not a human proportion.

The approved subjects are saved with the staging directory (`<out>/subjects.json`); they are not committed.

### Review gate

1. The agent inspects every candidate for **defining features** before showing it: the Cleric's gourd head and the holy symbol; the Thief's halfling proportions, colour and rogue gear; plus a plain dark background and one subject per image. Candidates that fail are marked and not offered as a pick.
2. The contact sheet (and the individual candidates) are shown to the owner, who picks one per character, or asks for a reroll (`--reroll`) or a prompt change.
3. Nothing touches the live actors, files in the data directory, or scene tokens before the pick.

### Apply (the only step that touches the live world)

For each picked candidate:

1. **Copy** the chosen webp to `/srv/foundry/data/Data/party-portraits/<id>-v2.webp` (the next free `-vN`; the old `<id>.webp` is left in place). The data directory is the Foundry user data, not the repo; nothing is committed.
2. **Update the documents** through the live-world access the project already uses (the `foundry-rest` skill's relay or an in-world script run as the GM): `Actor.update({ img, "prototypeToken.texture.src" })` to `party-portraits/<id>-v2.webp`; for the placed scene tokens (Cleric `izzH8gBZoGtuU2QJ`, Thief `ptzg9gUHwunjMwzR`, on every scene where the actor has a token) `TokenDocument.update({ "texture.src": … })`. The new filename also bypasses caches, so open clients refresh.
3. **Record** what changed in `<out>/applied.json` (the old and new paths and document ids) so the change can be reverted.
4. **Verify** by re-reading the actor and token documents and viewing the result in the world (a screenshot or the sheet), then ask the owner to confirm.

The old files are deleted only after the owner confirms the new art is accepted; until then a one-command revert (`--revert <staging>/applied.json`) restores the previous `img` and token textures.

### Where things live

- **Committed:** `tools/generate-party-art.mjs` and the exports in `tools/generate-token-art.mjs`, with a short usage note in the script header and an entry in `README.md`'s art-tools section.
- **Not committed:** subject files, staging directories, candidates, contact sheets, the manifest, and the images in the Foundry data directory. The staging directory defaults to `~/src/art-tools/out/party-art/<date>/` (outside the repo).

## Error handling

- ComfyUI unreachable or a workflow failure: the script reports it and writes nothing partial; a rerun resumes missing candidates.
- All candidates for a character fail the background check: report and stop for that character.
- Apply refuses to run without a manifest and an explicit `--pick`, refuses a candidate that doesn't exist, and does nothing to the live world on any earlier failure.
- A scene token or actor that can't be found is reported; the rest of the apply continues, and `applied.json` lists what was and wasn't changed.
- The revert uses `applied.json` only; it never deletes the new files unless asked.

## Testing

- **Pure units:** subject-file validation, prompt composition (shared with the token pipeline, so existing prompt tests keep passing), seed derivation per candidate and reroll, manifest and contact-sheet layout, the next-free `-vN` filename picker, the apply plan (documents and paths) built without touching Foundry.
- **Pipeline regression:** the exports added to `generate-token-art.mjs` do not change its CLI behavior or outputs (existing tests).
- **Dry-run apply:** `--apply --dry-run` prints the files and document updates it would make.
- **Live verification (the acceptance test):** generate four candidates per character; the owner approves the subject lines first and picks; apply; confirm in the world that both sheets, both prototype tokens and both placed tokens show the new art, that an open second client refreshes without a hard reload, that the old files remain until approval, and that the revert restores them.

## Explicitly out of scope

- Saving the images into module assets, `data/creature-art.json` or the generated-creature-art pack.
- The other party members, bestiary creatures, and any change to how the module's own art is generated.
- Paid image backends (Gemini, OpenRouter) unless the owner explicitly directs it.
- A separate portrait and cutout token (single image kept).

## Open questions

None blocking. Left to planning: the exact export refactor of `generate-token-art.mjs`, and which live-world access method (the relay or an in-world script) is the least fragile for the document updates.
