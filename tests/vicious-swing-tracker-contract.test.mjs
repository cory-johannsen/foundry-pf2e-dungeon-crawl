import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { trackerHasViciousSwingEntry } from "../scripts/vicious-swing-logic.mjs";

// Contract guard (#1281): the slug list of pf2e-auto-action-tracker v0.19.1's
// compiled-in complex-action library. It has no `vicious-swing` entry, which
// is why this module corrects the log itself. A tracker update that adds one
// means that fixture must be refreshed and the module must stand down (the
// handler also stands down at runtime when the card's log entry is an activity).
const fixture = JSON.parse(readFileSync(new URL("./fixtures/tracker-library-vicious-swing-absent.json", import.meta.url), "utf8"));

describe("tracker library contract", () => {
  it("has no vicious-swing entry", () => {
    expect(trackerHasViciousSwingEntry(fixture.slugs)).toBe(false);
  });
  it("detects one if added", () => {
    expect(trackerHasViciousSwingEntry([...fixture.slugs, "vicious-swing"])).toBe(true);
  });
  it("still has the library entries the design leans on", () => {
    expect(fixture.slugs).toContain("penetrating-shot"); // mapIncrease2 precedent
    expect(fixture.slugs).toContain("defensive-advance");
  });
});
