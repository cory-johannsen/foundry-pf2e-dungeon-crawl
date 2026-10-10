import { describe, it, expect } from "vitest";
import * as gen from "../tools/generate-token-art.mjs";

describe("generate-token-art exports (#1260)", () => {
  it("exposes the pipeline helpers the party script reuses", () => {
    for (const name of ["promptFor","negativeFor","build","enqueue","waitFor","fetchImage","backgroundScore","shrink","trySalvage"])
      expect(typeof gen[name], name).toBe("function");
    expect(gen.CLEAN_THRESHOLD).toBe(45);
    expect(gen.MAX_ATTEMPTS).toBeGreaterThanOrEqual(1);
  });
  it("importing does not run the CLI", () => { /* reaching this line = main() did not execute/exit */ expect(true).toBe(true); });
  it("promptFor/negativeFor keep their existing behavior", () => {
    expect(gen.promptFor({ who: "a dwarf" })).toContain("Portrait bust of a dwarf, wearing full plate armour");
    expect(gen.promptFor({ prompt: "x" })).toBe(`x, ${gen.STYLE}`);
    expect(gen.negativeFor({})).toBe(gen.NEGATIVE);
    expect(gen.negativeFor({ avoid: "beard" })).toBe(`${gen.NEGATIVE}, beard`);
    expect(gen.build("p", 5, "pre")["5"].inputs.seed).toBe(5);
  });
});
