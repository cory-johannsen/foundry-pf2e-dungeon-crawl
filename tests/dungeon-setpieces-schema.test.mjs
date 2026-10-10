import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import Ajv from "ajv";
import addFormats from "ajv-formats";

// #1276: `npm run validate:dungeon` is not run by CI, and the schema once
// drifted from the data (treasure setpieces from #89). This keeps them in sync.
const load = (rel) => JSON.parse(readFileSync(new URL(`../${rel}`, import.meta.url), "utf8"));

describe("data/dungeon-setpieces.json", () => {
  const schema = load("data/schema/dungeon-setpieces.schema.json");
  const setpieces = load("data/dungeon-setpieces.json");

  it("validates against data/schema/dungeon-setpieces.schema.json", () => {
    const ajv = new Ajv({ allErrors: true, strict: false });
    addFormats(ajv);
    const validate = ajv.compile(schema);
    const ok = validate(setpieces);
    const problems = (validate.errors ?? []).map((e) => `${e.instancePath} ${e.message}`);
    expect(problems).toEqual([]);
    expect(ok).toBe(true);
  });

  it("has unique ids", () => {
    const ids = setpieces.map((s) => s.id);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("every kind used in the data is allowed by the schema enum", () => {
    const allowed = schema.definitions.setpiece.properties.kind.enum;
    const used = [...new Set(setpieces.map((s) => s.kind))];
    expect(used.filter((k) => !allowed.includes(k))).toEqual([]);
  });
});
