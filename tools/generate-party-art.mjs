#!/usr/bin/env node
/**
 * Regenerate party character (Cleric / Thief) portrait+token art with the
 * ComfyUI token pipeline (#1260). ComfyUI only: no Gemini/OpenRouter fallback.
 *
 * Generate:
 *   node tools/generate-party-art.mjs --subjects <file.json> --out <dir>
 *        [--count 4] [--reroll N] [--only id] [--force]
 * Apply / revert (live world through the foundry-rest relay):
 *   node tools/generate-party-art.mjs --apply --manifest <out>/manifest.json
 *        --pick cleric=2,thief=3 [--dry-run]
 *   node tools/generate-party-art.mjs --revert <out>/applied.json [--delete-new]
 *
 * Everything generated (staging dir, manifest, contact sheet, the files in the
 * Foundry data dir) stays OUTSIDE the repo and is never committed. Suggested
 * staging dir: ~/src/art-tools/out/party-art/<YYYY-MM-DD>/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync, unlinkSync, openSync, readSync, closeSync, readdirSync, copyFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  STYLE, NEGATIVE, CHECKPOINT, STEPS, CFG, CLEAN_THRESHOLD, MAX_ATTEMPTS,
  build, enqueue, waitFor, fetchImage, backgroundScore, shrink, trySalvage
} from './generate-token-art.mjs';
import {
  validateSubjects, seedFor, partyPromptFor, partyNegativeFor, contactSheetLayout,
  buildApplyPlan, buildRevertPlan, actorReadScript, applyScript, revertScript
} from './party-art-lib.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function argValue(args, name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(code, msg) {
  console.error(msg);
  process.exit(code);
}

/** The interpreter shrink()/backgroundScore() use (<root>/.venv), if it works. */
function workingPython() {
  const py = join(root, '.venv/bin/python3');
  if (!existsSync(py)) return null;
  try {
    execFileSync(py, ['-c', 'import PIL, numpy'], { stdio: 'ignore' });
    return py;
  } catch {
    return null;
  }
}

/** shrink() falls back to writing PNG bytes under a .webp name; detect that. */
function isWebp(path) {
  const buf = Buffer.alloc(12);
  const fd = openSync(path, 'r');
  try { readSync(fd, buf, 0, 12, 0); } finally { closeSync(fd); }
  return buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP';
}

async function generateCandidate(subject, index, reroll, outDir, tmpDir) {
  const prompt = partyPromptFor(subject, STYLE);
  const negative = partyNegativeFor(subject, NEGATIVE);
  const dest = join(outDir, subject.id, `cand-${index}.webp`);
  let best = null;   // { path, score }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const seed = (seedFor(subject.id, index, reroll) + attempt * 7919) % 2_000_000_000;
    const png = join(tmpDir, `${subject.id}-${index}-${attempt}.png`);
    try {
      const ref = await waitFor(await enqueue(build(prompt, seed, `pf2edc-party-${subject.id}`, negative)));
      writeFileSync(png, await fetchImage(ref));
    } catch (e) {
      console.error(`  ${subject.id} #${index} attempt ${attempt + 1}: ${e.message}`);
      continue;
    }
    let score = backgroundScore(png);
    if (score !== null && score >= CLEAN_THRESHOLD) {
      const salvaged = trySalvage(png, score);
      if (salvaged !== null) score = salvaged;
    }
    if (!best || (score ?? Infinity) < (best.score ?? Infinity)) best = { path: png, score, seed };
    if (score !== null && score < CLEAN_THRESHOLD) break;
  }
  if (!best) return { index, seed: seedFor(subject.id, index, reroll), score: null, ok: false };
  shrink(best.path, dest);
  if (!isWebp(dest)) {
    unlinkSync(dest);
    throw new Error('shrink produced a non-webp file; Pillow is not working');
  }
  return { index, seed: best.seed, score: best.score, ok: best.score !== null && best.score < CLEAN_THRESHOLD };
}

const SHEET_PY = `
import json, sys
from PIL import Image, ImageDraw
layout = json.loads(sys.argv[1]); out = sys.argv[2]; items = json.loads(sys.argv[3])
sheet = Image.new('RGB', (layout['width'], layout['height']), (24, 24, 24))
d = ImageDraw.Draw(sheet)
for t, it in zip(layout['tiles'], items):
    if it['path']:
        try:
            sheet.paste(Image.open(it['path']).convert('RGB').resize((t['w'], t['h'] - 40)), (t['x'], t['y'] + 40))
        except Exception:
            pass
    d.text((t['x'] + 8, t['y'] + 12), it['label'], fill=(255, 255, 255))
sheet.save(out)
`;

function writeContactSheet(py, outDir, subjects, count, manifest) {
  const layout = contactSheetLayout(subjects, count);
  const items = layout.tiles.map((t) => {
    const cand = manifest.subjects[t.id].candidates.find((c) => c.index === t.index + 1);
    const path = join(outDir, t.id, `cand-${t.index + 1}.webp`);
    return { path: existsSync(path) ? path : null, label: `${t.id} #${t.index + 1}${cand && !cand.ok ? ' FAIL' : ''}` };
  });
  execFileSync(py, ['-c', SHEET_PY, JSON.stringify(layout), join(outDir, 'contact-sheet.png'), JSON.stringify(items)]);
}

async function generateMode(args) {
  const subjectsFile = argValue(args, '--subjects');
  const outDir = argValue(args, '--out');
  if (!subjectsFile || !outDir) fail(2, 'usage: --subjects <file.json> --out <dir> [--count 4] [--reroll N] [--only id] [--force]');
  if (!existsSync(subjectsFile)) fail(2, `subjects file not found: ${subjectsFile}`);
  let subjects;
  try { subjects = JSON.parse(readFileSync(subjectsFile, 'utf8')); }
  catch (e) { fail(2, `subjects file is not valid JSON: ${e.message}`); }
  const valid = validateSubjects(subjects);
  if (!valid.ok) fail(2, `invalid subjects:\n  ${valid.errors.join('\n  ')}`);
  const py = workingPython();
  if (!py) fail(2, `Pillow/numpy required: create ${join(root, '.venv')} (python3 -m venv .venv && .venv/bin/pip install pillow numpy)`);

  const count = parseInt(argValue(args, '--count') ?? '4', 10);
  const reroll = parseInt(argValue(args, '--reroll') ?? '0', 10);
  const only = argValue(args, '--only');
  const force = args.includes('--force');
  const todo = only ? subjects.filter((s) => s.id === only) : subjects;
  if (only && !todo.length) fail(2, `--only ${only}: no such subject`);

  const outAbs = resolve(outDir);
  const tmpDir = join(outAbs, '.tmp');
  mkdirSync(tmpDir, { recursive: true });
  writeFileSync(join(outAbs, 'subjects.json'), JSON.stringify(subjects, null, 2));

  const manifestPath = join(outAbs, 'manifest.json');
  const manifest = existsSync(manifestPath) && !force
    ? JSON.parse(readFileSync(manifestPath, 'utf8'))
    : { createdAt: new Date().toISOString(), model: CHECKPOINT, steps: STEPS, cfg: CFG, subjects: {} };

  for (const s of todo) {
    mkdirSync(join(outAbs, s.id), { recursive: true });
    const prev = manifest.subjects[s.id]?.candidates ?? [];
    const entry = { who: s.who, prompt: partyPromptFor(s, STYLE), negative: partyNegativeFor(s, NEGATIVE), candidates: [] };
    for (let index = 1; index <= count; index++) {
      const dest = join(outAbs, s.id, `cand-${index}.webp`);
      const kept = prev.find((c) => c.index === index);
      if (existsSync(dest) && !force && kept) { entry.candidates.push(kept); continue; }
      console.log(`${s.id} #${index} ...`);
      const rec = await generateCandidate(s, index, reroll, outAbs, tmpDir);
      entry.candidates.push(rec);
      console.log(`  score ${rec.score} ${rec.ok ? 'ok' : 'FAIL'}`);
    }
    manifest.subjects[s.id] = entry;
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  rmSync(tmpDir, { recursive: true, force: true });

  const sheetSubjects = subjects.filter((s) => manifest.subjects[s.id]);
  writeContactSheet(py, outAbs, sheetSubjects, count, manifest);
  console.log(`contact sheet: ${join(outAbs, 'contact-sheet.png')}`);

  let failed = false;
  for (const s of todo) {
    if (!manifest.subjects[s.id].candidates.some((c) => c.ok)) {
      failed = true;
      console.log(`FAILED ${s.id}: no clean candidate (reroll, change the prompt, or hand-make)`);
    }
  }
  process.exit(failed ? 3 : 0);
}

const DEFAULT_DATA_DIR = '/srv/foundry/data/Data';

/** Run a script in the live world via the foundry-rest relay; retry when the socket drops (exit 3). */
function foundryExec(script) {
  const exec = join(root, '.claude/skills/foundry-rest/foundry-exec.sh');
  // foundry-exec.sh does `cat /dev/stdin`, which fails on the socket pair node uses for `input`, so pass a file.
  const file = join(tmpdir(), `party-art-${process.pid}-${Date.now()}.js`);
  writeFileSync(file, script);
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        return JSON.parse(execFileSync(exec, [file], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }));
      } catch (e) {
        if (e.status === 3 && attempt < 3) { console.error(`relay dropped, retry ${attempt}/3`); continue; }
        throw new Error(`foundry-exec failed (exit ${e.status}): ${e.stderr || e.message}`);
      }
    }
  } finally {
    rmSync(file, { force: true });
  }
}

function parsePicks(text) {
  const picks = {};
  for (const part of text.split(',')) {
    const m = /^([a-z0-9-]+)=(\d+)$/.exec(part.trim());
    if (!m) fail(2, `bad --pick entry: ${part}`);
    picks[m[1]] = parseInt(m[2], 10);
  }
  return picks;
}

async function applyMode(args) {
  const manifestPath = argValue(args, '--manifest');
  const pickText = argValue(args, '--pick');
  if (!manifestPath || !pickText) fail(2, 'usage: --apply --manifest <out>/manifest.json --pick cleric=2,thief=3 [--dry-run]');
  if (!existsSync(manifestPath)) fail(2, `manifest not found: ${manifestPath}`);
  const picks = parsePicks(pickText);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const stagingDir = dirname(resolve(manifestPath));
  const subjectsPath = join(stagingDir, 'subjects.json');
  if (!existsSync(subjectsPath)) fail(2, `subjects.json not found beside the manifest: ${subjectsPath}`);
  const subjects = JSON.parse(readFileSync(subjectsPath, 'utf8'));
  const dataDir = argValue(args, '--data-dir') ?? DEFAULT_DATA_DIR;
  const dryRun = args.includes('--dry-run');
  const portraitsDir = join(dataDir, 'party-portraits');

  const ids = Object.keys(picks);
  for (const id of ids) {
    const subj = subjects.find((s) => s.id === id);
    if (!subj) fail(2, `--pick ${id}: no such subject`);
    if (!subj.actorId) fail(2, `--pick ${id}: subject has no actorId`);
  }

  // Resolve actors and placed tokens live (read-only); tests/dry runs may inject them.
  let live;
  const injected = argValue(args, '--actors-json');
  if (injected) live = JSON.parse(readFileSync(injected, 'utf8'));
  else live = foundryExec(actorReadScript(ids.map((id) => subjects.find((s) => s.id === id).actorId)));
  const actors = {};
  for (const id of ids) {
    const actorId = subjects.find((s) => s.id === id).actorId;
    const info = live[actorId];
    if (!info || info.exists === false) fail(2, `${id}: actor ${actorId} not found in the world`);
    actors[id] = { actorId, img: info.img, proto: info.proto, tokens: info.tokens };
  }

  const existingFiles = existsSync(portraitsDir) ? readdirSync(portraitsDir) : [];
  const plan = buildApplyPlan({ picks, manifest, actors, existingFiles, dataDir, stagingDir });
  if (plan.errors.length) fail(2, `refusing to apply:\n  ${plan.errors.join('\n  ')}`);
  for (const c of plan.copies) if (!existsSync(c.from)) fail(2, `candidate file missing: ${c.from}`);

  if (dryRun) {
    console.log(JSON.stringify({ copies: plan.copies, documentUpdates: plan.documentUpdates }, null, 2));
    return;
  }

  mkdirSync(portraitsDir, { recursive: true });
  for (const c of plan.copies) copyFileSync(c.from, c.to);

  const appliedPath = join(stagingDir, 'applied.json');
  const applied = { appliedAt: new Date().toISOString(), entries: [] };
  plan.documentUpdates.forEach((u, i) => {
    const id = ids[i];
    const r = foundryExec(applyScript(u));
    if (!r.ok) console.error(`${id}: ${r.error}`);
    applied.entries.push({ id, actorId: u.actorId, oldImg: r.oldImg ?? actors[id].img, oldProto: r.oldProto ?? actors[id].proto, newImg: u.img, tokens: r.tokens ?? [] });
    writeFileSync(appliedPath, JSON.stringify(applied, null, 2));
  });

  const after = foundryExec(actorReadScript(applied.entries.map((e) => e.actorId)));
  console.log('id\timg\tprototype\ttokens');
  for (const e of applied.entries) {
    const a = after[e.actorId];
    console.log([e.id, a.img, a.proto, a.tokens.map((t) => `${t.tokenId}=${t.src}`).join(' ') || '(none)'].join('\t'));
  }
  console.log(`applied.json: ${appliedPath}`);
}

async function revertMode(args) {
  const appliedPath = argValue(args, '--revert');
  if (!appliedPath || !existsSync(appliedPath)) fail(2, `applied.json not found: ${appliedPath}`);
  const applied = JSON.parse(readFileSync(appliedPath, 'utf8'));
  const plan = buildRevertPlan(applied);
  plan.documentUpdates.forEach((u, i) => {
    const r = foundryExec(revertScript(u));
    console.log(`${applied.entries[i].id}: ${r.ok ? 'restored' : r.error}`);
  });
  if (args.includes('--delete-new')) {
    const dataDir = argValue(args, '--data-dir') ?? DEFAULT_DATA_DIR;
    for (const e of applied.entries) {
      const f = join(dataDir, e.newImg);
      if (existsSync(f)) { unlinkSync(f); console.log(`deleted ${f}`); }
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--apply')) return applyMode(args);
  if (args.includes('--revert')) return revertMode(args);
  await generateMode(args);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
