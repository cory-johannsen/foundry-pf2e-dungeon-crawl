# Persistent token-art failure modes (ComfyUI DreamShaper Lightning cannot reliably do these)
Maintained during the #229 work. Check BEFORE writing a prompt; for these classes SKIP ComfyUI and go straight to OpenRouter (Muse -> Flux klein -> Krea, cheapest first; user directive 2026-10-02), and verify the result against the creature's defining trait.

## Hybrid / composite bodies (model blends or picks one half)
- centaur (draws a rider on a horse, or a bust) -> centaur-scout: Muse gave a stylized bust; needs full-body check
- owlbear / winged owlbear (draws an owl) -> winged-owlbear
- chimera, griffon-style, manticore, hippogriff: expect one half to win; check both halves present
- drider / death drider (spider lower body missing) -> death-drider
- serpent-lower-body demons/lamia/naga (draws legs) -> kimilekki
- hydra (draws one head) -> hooktongue-hydra
- multi-headed giants (athach: 3 heads + chest arm) -> bloomborn-athach
- beast-with-humanoid-parts (werewolf-like bodies) check anatomy

## Absence / negation (diffusion ignores "no X")
- featureless/blank face (faceless butcher, defaced naiad queen, Leng envoy) -> draws a normal face
- headless -> draws a head (headless-xulgath; Flux got closest)
- one-eyed cyclops -> draws two eyes (cyclops-zombie; Flux got it)
- no ground/no plinth/no scenery -> floor, rubble, ledges appear

## Incorporeal / translucent (draws a solid person with smoke)
- ghosts, spirits, wraiths, will-o-wisps: ghostly-guard, jin-durwhimmer, the-gardener, fionn, xae, nihiris, ulthadar, lyrt-cozurn, binumir
- go straight to OpenRouter (Muse/Flux); accept only if clearly see-through

## Name-cue traps (the NAME pulls a different subject)
- "wisp"/"candle"/"ichor"/"seugathi"/"pudding"/"fetch" -> woman or object; oozes get faces (luminous-ooze, viscous-black-pudding, tallow-ooze, fen-pudding, slithering-rift)
- "Dog X", "Tiger Lord", "Rabbit Prince", "Gardener" -> animal head / literal animal
- "Stag Lord" etc fine; check titles that contain an animal word
- "monocle/holy symbol/halo/sunburst/clock gear" -> ring/halo/frame behind subject

## Size/proportion (small folk drawn as normal humans)
- halflings, gnomes, shoony: kolo-harvan, nolly-peltry, shoony-*
- minor; fix only if cheap

## Shape limits that Muse also fails
- Muse content filter rejects some prompts (400): fall through to Flux (headless-xulgath, cyclops-zombie)
- If all models fail -> docs/gemini-hand-queue.tsv (hand-made)

## Review rule (user directive 2026-10-02)
Accept only if the creature's DEFINING TRAIT is present (head count, eye count, incorporeal, body plan, species). Clean background is not enough. Redo/audit lists: ~/src/art-tools/out/redo_list.md, ~/src/art-tools/out/audit_fails.md

## Model notes (audit 2026-10-02)
- Muse ($0.01): good for ghosts, blank faces, multi-head, oozes; draws centaurs as a bust only; content-filters violent wording ("stump", "severed").
- Flux klein ($0.014): drew the centaur as a plain horse; filters "graphic violence".
- Krea turbo ($0.015): the only model that drew a full-body centaur (human archer torso on horse body); use `--model=krea/krea-2-medium-turbo` for hybrids that need the whole body.
- ComfyUI repeated the SAME image for darklands-alchemical-golem despite a prompt rewrite (seed derives from the id): rewrites do not help ComfyUI on these classes.
