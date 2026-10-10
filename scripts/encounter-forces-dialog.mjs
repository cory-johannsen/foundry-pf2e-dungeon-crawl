/**
 * #1083: the advanced Generate Encounter dialog -- one fieldset per opposing
 * force. Force 1 reuses the original dialog's trait fields so a one-force
 * encounter looks the same as before. The pure helpers are unit-tested; the
 * DialogV2 wrapper (chooseEncounterForces) is covered by live verification.
 */
import {
  traitFieldHtml,
  wireTraitPickerButtons,
  readTraitField,
} from "./trait-picker.mjs";
import { splitBudget, validateShares } from "./force-budget.mjs";
import { xpBudget } from "./encounter-roster.mjs";

const HOSTILITIES = ["players", "all"];
const RARITIES = ["", "common", "uncommon", "rare", "unique"];

export function defaultForce(index, overrides = {}) {
  return {
    id: `f${index + 1}`,
    name: "",
    hostility: "players",
    share: 100,
    filters: {
      traits: [],
      excludeTraits: [],
      levelOffsetMin: null,
      levelOffsetMax: null,
      rarity: "",
    },
    placement: { mode: "nearParty" },
    ...overrides,
  };
}

export function equalShares(n) {
  if (!(n > 0)) return [];
  const base = Math.floor(100 / n);
  const shares = Array(n).fill(base);
  shares[0] += 100 - base * n;
  return shares;
}

function offset(v) {
  if (v === "" || v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function normalizeForce(raw = {}, index = 0) {
  const f = raw.filters ?? {};
  return {
    id: raw.id ?? `f${index + 1}`,
    name: String(raw.name ?? "").trim(),
    hostility: HOSTILITIES.includes(raw.hostility) ? raw.hostility : "players",
    share: Number(raw.share),
    filters: {
      traits: f.traits ?? [],
      excludeTraits: f.excludeTraits ?? [],
      levelOffsetMin: offset(f.levelOffsetMin),
      levelOffsetMax: offset(f.levelOffsetMax),
      rarity: RARITIES.includes(f.rarity) ? f.rarity : "",
    },
    placement: { mode: raw.placement?.mode || "nearParty" },
  };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

function options(values, selected, labels = {}) {
  return values
    .map((v) => `<option value="${v}"${v === selected ? " selected" : ""}>${labels[v] ?? (v || "—")}</option>`)
    .join("");
}

/** `labels` are pre-localized by the caller so this stays pure. */
export function forceSectionHtml(force, index, labels = {}) {
  const {
    traitsLabel = "Traits to favor",
    excludeTraitsLabel = "Traits to exclude",
    chooseLabel = "Choose traits…",
    nameLabel = "Force name",
    hostilityLabel = "Hostile to",
    hostilityOptions = { players: "Party only", all: "Everyone" },
    shareLabel = "Budget share (%)",
    levelMinLabel = "Min level offset",
    levelMaxLabel = "Max level offset",
    rarityLabel = "Rarity",
    placementLabel = "Placement",
    nearPartyLabel = "Near party",
    regions = [],
    removable = index > 0,
    removeLabel = "Remove",
  } = labels;
  const id = force.id;
  const f = force.filters ?? {};
  const placementOptions = [
    `<option value="nearParty"${force.placement?.mode === "nearParty" ? " selected" : ""}>${nearPartyLabel}</option>`,
    ...regions.map((r) => {
      const v = `region:${r.id}`;
      return `<option value="${esc(v)}"${force.placement?.mode === v ? " selected" : ""}>${esc(r.name ?? r.id)}</option>`;
    }),
  ].join("");
  return `
    <fieldset data-force="${id}">
      <legend>${esc(force.name) || `#${index + 1}`}${removable ? ` <button type="button" class="pf2edc-force-remove" data-force="${id}">${removeLabel}</button>` : ""}</legend>
      <div class="form-group"><label>${nameLabel}</label><input type="text" name="force-${id}-name" value="${esc(force.name)}" /></div>
      <div class="form-group"><label>${hostilityLabel}</label><select name="force-${id}-hostility">${options(HOSTILITIES, force.hostility, hostilityOptions)}</select></div>
      <div class="form-group"><label>${shareLabel}</label><input type="number" min="1" max="100" step="1" name="force-${id}-share" value="${force.share}" /></div>
      ${traitFieldHtml({ name: `traits-${id}`, label: traitsLabel, buttonLabel: chooseLabel, selected: f.traits ?? [] })}
      ${traitFieldHtml({ name: `excludeTraits-${id}`, label: excludeTraitsLabel, buttonLabel: chooseLabel, selected: f.excludeTraits ?? [] })}
      <div class="form-group"><label>${levelMinLabel}</label><input type="number" step="1" name="force-${id}-levelMin" value="${f.levelOffsetMin ?? ""}" /></div>
      <div class="form-group"><label>${levelMaxLabel}</label><input type="number" step="1" name="force-${id}-levelMax" value="${f.levelOffsetMax ?? ""}" /></div>
      <div class="form-group"><label>${rarityLabel}</label><select name="force-${id}-rarity">${options(RARITIES, f.rarity ?? "")}</select></div>
      <div class="form-group"><label>${placementLabel}</label><select name="force-${id}-placement">${placementOptions}</select></div>
    </fieldset>`;
}

export function readForcesFromForm(root) {
  const val = (name) => root.querySelector(`[name="${name}"]`)?.value ?? "";
  return Array.from(root.querySelectorAll("fieldset[data-force]")).map((fs, i) => {
    const id = fs.dataset.force;
    return normalizeForce(
      {
        id,
        name: val(`force-${id}-name`),
        hostility: val(`force-${id}-hostility`),
        share: val(`force-${id}-share`),
        filters: {
          traits: readTraitField(root, `traits-${id}`),
          excludeTraits: readTraitField(root, `excludeTraits-${id}`),
          levelOffsetMin: val(`force-${id}-levelMin`),
          levelOffsetMax: val(`force-${id}-levelMax`),
          rarity: val(`force-${id}-rarity`),
        },
        placement: { mode: val(`force-${id}-placement`) },
      },
      i,
    );
  });
}

const L = (k) => game.i18n.localize(`PF2EDC.Encounter.${k}`);

function sectionLabels(regions) {
  return {
    traitsLabel: L("ThemeLabel"),
    excludeTraitsLabel: L("ExcludeTraitsLabel"),
    chooseLabel: L("ChooseTraitsButton"),
    nameLabel: L("ForceNameLabel"),
    hostilityLabel: L("ForceHostilityLabel"),
    hostilityOptions: { players: L("ForceHostilityPlayers"), all: L("ForceHostilityAll") },
    shareLabel: L("ForceShareLabel"),
    levelMinLabel: L("ForceLevelMinLabel"),
    levelMaxLabel: L("ForceLevelMaxLabel"),
    rarityLabel: L("ForceRarityLabel"),
    placementLabel: L("ForcePlacementLabel"),
    nearPartyLabel: L("ForceNearParty"),
    removeLabel: L("ForceRemoveButton"),
    regions,
  };
}

/**
 * The multi-force Generate Encounter dialog. Resolves to
 * { difficulty, forces } or null if cancelled.
 */
export async function chooseEncounterForces({ api, scene, partySize = 4 } = {}) {
  const { DialogV2 } = foundry.applications.api;
  const traits = await api.listCreatureTraits();
  const regions = Array.from(scene?.regions ?? []).map((r) => ({ id: r.id, name: r.name }));
  let forces = [defaultForce(0)];
  let nextIndex = 1;

  const difficultyHtml = `
    <label>
      ${L("DifficultyLabel")}
      <select name="difficulty">
        <option value="trivial">${L("Difficulty.Trivial")}</option>
        <option value="low">${L("Difficulty.Low")}</option>
        <option value="moderate" selected>${L("Difficulty.Moderate")}</option>
        <option value="severe">${L("Difficulty.Severe")}</option>
        <option value="extreme">${L("Difficulty.Extreme")}</option>
      </select>
    </label>`;

  return DialogV2.wait({
    window: { title: L("Title") },
    position: { width: 520 },
    content: `<form>${difficultyHtml}
      <div class="pf2edc-forces"></div>
      <button type="button" class="pf2edc-force-add">${L("ForceAddButton")}</button>
      <p class="pf2edc-force-budget"></p></form>`,
    render: (_event, dialog) => {
      const root = dialog.element;
      const list = root.querySelector(".pf2edc-forces");
      const budgetEl = root.querySelector(".pf2edc-force-budget");
      const generate = root.querySelector('button[data-action="generate"]');

      const refreshBudget = () => {
        const current = readForcesFromForm(root);
        const shares = current.map((f) => f.share);
        const { ok, total } = validateShares(shares);
        const tier = root.querySelector('[name="difficulty"]')?.value ?? "moderate";
        const parts = splitBudget(xpBudget(tier, partySize), shares);
        budgetEl.textContent = ok
          ? `${L("ForceBudgetLabel")}: ${xpBudget(tier, partySize)} XP (${parts.join(" / ")})`
          : game.i18n.format("PF2EDC.Encounter.ForceSharesInvalid", { total });
        if (generate) generate.disabled = !ok;
      };

      const renderList = () => {
        list.innerHTML = forces.map((f, i) => forceSectionHtml(f, i, sectionLabels(regions))).join("");
        wireTraitPickerButtons(list, traits);
        list.querySelectorAll(".pf2edc-force-remove").forEach((b) =>
          b.addEventListener("click", () => {
            forces = readForcesFromForm(root).filter((f) => f.id !== b.dataset.force);
            renderList();
          }),
        );
        list.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", refreshBudget));
        refreshBudget();
      };

      root.querySelector(".pf2edc-force-add").addEventListener("click", () => {
        forces = readForcesFromForm(root);
        const shares = equalShares(forces.length + 1);
        forces = forces.map((f, i) => ({ ...f, share: shares[i] }));
        forces.push(defaultForce(nextIndex++, { share: shares[forces.length] }));
        renderList();
      });
      root.querySelector('[name="difficulty"]').addEventListener("change", refreshBudget);
      renderList();
    },
    buttons: [
      {
        action: "generate",
        label: L("GenerateButton"),
        default: true,
        callback: (_event, _button, dialog) => ({
          difficulty: dialog.element.querySelector('[name="difficulty"]')?.value ?? "moderate",
          forces: readForcesFromForm(dialog.element),
        }),
      },
      { action: "cancel", label: "Cancel" },
    ],
    rejectClose: false,
  }).then((r) => (r && typeof r === "object" ? r : null));
}
