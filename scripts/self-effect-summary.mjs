/**
 * #914: pure helpers turning an effect's own rule elements/duration into
 * the short, deterministic labels the #909 reasoning model reads (per
 * this feature's spec, Decision 4: "the model chooses among entries by
 * purpose; it never reads raw rules"). No Foundry API surface at all.
 */

const RULE_LABEL_BUILDERS = {
  FlatModifier: (r) => `+${r.selector ?? "stat"}`,
  AdjustModifier: (r) => `${r.selector ?? "stat"} adj`,
  DamageDice: () => "+damage dice",
  TempHP: () => "temp HP",
  Resistance: (r) => `resist ${Array.isArray(r.type) ? r.type.join("/") : (r.type ?? "")}`.trim(),
  RollOption: () => "option",
  ActiveEffectLike: (r) => `${String(r.path ?? "stat").split(".").pop()} mod`,
  AdjustStrike: () => "strike adj",
  Aura: () => "aura",
  Note: () => "note",
  BaseSpeed: () => "+speed",
  Sense: (r) => `sense${r.selector ? `: ${r.selector}` : ""}`,
  ItemAlteration: () => "item alteration",
  Strike: (r) => `grants strike${r.label ? `: ${r.label}` : ""}`,
  CreatureSize: () => "size change",
  FastHealing: () => "fast healing",
  RollTwice: () => "roll twice",
  GrantItem: () => "grants item",
  AdjustDegreeOfSuccess: () => "degree adjustment",
  TokenLight: () => "light",
};

export function summarizeEffect(rules = []) {
  if (!rules.length) return "(no mechanical rules)";
  const labels = rules.map((r) => RULE_LABEL_BUILDERS[r.key]?.(r) ?? r.key);
  return [...new Set(labels)].join(", ");
}

export function effectDurationLabel(duration) {
  if (!duration) return "unknown";
  if (duration.unit === "unlimited") return "unlimited";
  if (duration.unit === "encounter") return "until encounter ends";
  return `${duration.value} ${duration.unit}`;
}

const TIER_0_KEYS = new Set(["FlatModifier", "AdjustModifier", "DamageDice", "AdjustStrike", "BaseSpeed", "Strike"]);
const TIER_1_KEYS = new Set(["Resistance"]);

export function effectRelevanceTier(rules = []) {
  const keys = new Set(rules.map((r) => r.key));
  if ([...TIER_0_KEYS].some((k) => keys.has(k))) return 0;
  if ([...TIER_1_KEYS].some((k) => keys.has(k))) return 1;
  return 2;
}
