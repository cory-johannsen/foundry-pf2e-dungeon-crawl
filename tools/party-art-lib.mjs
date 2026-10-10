// Pure helpers for tools/generate-party-art.mjs (#1260). No I/O, no imports.

const MOD = 2_000_000_000;

export function validateSubjects(list) {
  const errors = [];
  if (!Array.isArray(list)) return { ok: false, errors: ['subjects must be an array'] };
  const seen = new Set();
  list.forEach((s, i) => {
    const at = `subject[${i}]`;
    if (!s || typeof s !== 'object') { errors.push(`${at}: not an object`); return; }
    if (typeof s.id !== 'string' || !/^[a-z0-9-]+$/.test(s.id)) errors.push(`${at}: id must match /^[a-z0-9-]+$/`);
    else if (seen.has(s.id)) errors.push(`${at}: duplicate id ${s.id}`);
    else seen.add(s.id);
    if (typeof s.who !== 'string' || !s.who.trim()) errors.push(`${at}: who must be a non-empty string`);
    for (const k of ['avoid', 'notes']) {
      if (s[k] !== undefined && typeof s[k] !== 'string') errors.push(`${at}: ${k} must be a string`);
    }
    if (s.actorId !== undefined && !(typeof s.actorId === 'string' && /^[A-Za-z0-9]{16}$/.test(s.actorId))) {
      errors.push(`${at}: actorId must be a 16-character id`);
    }
  });
  return { ok: errors.length === 0, errors };
}

// Modulo on every reduce step: a plain a*31+c fold overflows double precision on long ids.
export function seedFor(id, index, reroll = 0) {
  const base = [...id].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % MOD, 7);
  return (base + reroll * 104729 + index * 7919) % MOD;
}

export const partyPromptFor = (subject, style) => `Portrait bust of ${subject.who}, ${style}`;

export const partyNegativeFor = (subject, negative) =>
  subject.avoid ? `${negative}, ${subject.avoid}` : negative;

export function nextVersionedName(existing, id) {
  const re = new RegExp(`^${id.replace(/[^a-z0-9-]/g, '\\$&')}-v(\\d+)\\.webp$`);
  let max = 1;
  for (const f of existing) {
    const m = re.exec(f);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `${id}-v${max + 1}.webp`;
}

export function contactSheetLayout(subjects, count, cell = 512, label = 40) {
  const tiles = [];
  subjects.forEach((s, row) => {
    for (let index = 0; index < count; index++) {
      tiles.push({ id: s.id, index, x: index * cell, y: row * (cell + label), w: cell, h: cell + label });
    }
  });
  return { width: count * cell, height: subjects.length * (cell + label), tiles };
}

const hasCandidate = (cands, n) => (cands || []).some((c) => (c && typeof c === 'object' ? c.index : c) === n);

export function buildApplyPlan({ picks, manifest, actors, existingFiles, dataDir, stagingDir }) {
  const copies = [];
  const documentUpdates = [];
  const errors = [];
  for (const [id, n] of Object.entries(picks)) {
    const subj = manifest?.subjects?.[id];
    if (!subj) { errors.push(`${id}: not in manifest`); continue; }
    if (!hasCandidate(subj.candidates, n)) { errors.push(`${id}: candidate ${n} not in manifest`); continue; }
    const mapping = actors?.[id];
    if (!mapping || !mapping.actorId) { errors.push(`${id}: no actor mapping`); continue; }
    const name = nextVersionedName(existingFiles, id);
    copies.push({ from: `${stagingDir}/${id}/cand-${n}.webp`, to: `${dataDir}/party-portraits/${name}` });
    documentUpdates.push({ actorId: mapping.actorId, img: `party-portraits/${name}`, tokens: mapping.tokens || [] });
  }
  return { copies, documentUpdates, errors };
}

export function buildRevertPlan(applied) {
  return {
    documentUpdates: applied.entries.map((e) => ({
      actorId: e.actorId,
      img: e.oldImg,
      proto: e.oldProto ?? e.oldImg,
      tokens: e.tokens.filter((t) => t.ok).map((t) => ({ tokenId: t.tokenId, sceneId: t.sceneId, oldSrc: t.oldSrc })),
    })),
  };
}

// Text the foundry-rest relay refuses anywhere in a script, comments included.
export const BANNED_SCRIPT_WORDS = [
  'apiKey', 'globalThis', 'eval(', 'import(', 'new Function',
  'localStorage', 'sessionStorage', 'password', 'game.settings.set', 'XMLHttpRequest'
];

/** Read-only: actor img/prototype src and every placed token on any scene. */
export const actorReadScript = (actorIds) => `
const ids = ${JSON.stringify(actorIds)};
const out = {};
for (const id of ids) {
  const actor = game.actors.get(id);
  if (!actor) { out[id] = { exists: false, tokens: [] }; continue; }
  const tokens = [];
  for (const scene of game.scenes) {
    for (const t of scene.tokens) {
      if (t.actorId === id) tokens.push({ sceneId: scene.id, tokenId: t.id, src: t.texture.src });
    }
  }
  out[id] = { exists: true, img: actor.img, proto: actor.prototypeToken.texture.src, tokens };
}
return out;
`;

/** Point actor, prototype token and placed tokens at update.img; reports old values. */
export const applyScript = (update) => `
const update = ${JSON.stringify(update)};
const actor = game.actors.get(update.actorId);
if (!actor) return { ok: false, error: "actor not found" };
const oldImg = actor.img;
const oldProto = actor.prototypeToken.texture.src;
await actor.update({ img: update.img, "prototypeToken.texture.src": update.img });
const tokens = [];
for (const t of update.tokens) {
  try {
    const doc = game.scenes.get(t.sceneId).tokens.get(t.tokenId);
    const oldSrc = doc.texture.src;
    await doc.update({ "texture.src": update.img });
    tokens.push({ tokenId: t.tokenId, sceneId: t.sceneId, oldSrc, ok: true });
  } catch (e) {
    tokens.push({ tokenId: t.tokenId, sceneId: t.sceneId, oldSrc: t.src ?? null, ok: false, error: String(e.message ?? e) });
  }
}
return { ok: true, oldImg, oldProto, tokens };
`;

/** Inverse of applyScript: restore update.img / update.proto and each token's oldSrc. */
export const revertScript = (update) => `
const update = ${JSON.stringify(update)};
const actor = game.actors.get(update.actorId);
if (!actor) return { ok: false, error: "actor not found" };
await actor.update({ img: update.img, "prototypeToken.texture.src": update.proto ?? update.img });
const tokens = [];
for (const t of update.tokens) {
  try {
    await game.scenes.get(t.sceneId).tokens.get(t.tokenId).update({ "texture.src": t.oldSrc });
    tokens.push({ tokenId: t.tokenId, ok: true });
  } catch (e) {
    tokens.push({ tokenId: t.tokenId, ok: false, error: String(e.message ?? e) });
  }
}
return { ok: true, tokens };
`;
