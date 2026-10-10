import { describe, it, expect, vi, beforeEach } from "vitest";
import { clearForceDecorations } from "../scripts/dungeon-combat.mjs";

const MOD = "pf2e-dungeon-crawl";
const tok = (flags, name = "Ghoul (Undead)", extra = {}) => ({
  name,
  flags: flags ? { [MOD]: flags } : {},
  update: vi.fn(async () => {}),
  ...extra,
});
const combatOf = (tokens) => ({ combatants: tokens.map((token) => ({ token })) });

beforeEach(() => {
  globalThis.game = { user: { isGM: true }, users: { activeGM: { isSelf: true } } };
});

describe("clearForceDecorations (#1083)", () => {
  it("restores name and clears tint on forceId-flagged tokens", async () => {
    const t = tok({ forceId: "u", originalName: "Ghoul" });
    await clearForceDecorations(combatOf([t]));
    expect(t.update).toHaveBeenCalledWith({ name: "Ghoul", "texture.tint": null });
  });

  it("falls back to the current name when originalName is missing", async () => {
    const t = tok({ forceId: "u" }, "Ghoul (Undead)");
    await clearForceDecorations(combatOf([t]));
    expect(t.update).toHaveBeenCalledWith({ name: "Ghoul (Undead)", "texture.tint": null });
  });

  it("is a no-op for legacy tokens without a forceId", async () => {
    const t = tok(null);
    await clearForceDecorations(combatOf([t]));
    expect(t.update).not.toHaveBeenCalled();
  });

  it("skips tokens already deleted", async () => {
    const t = tok({ forceId: "u", originalName: "Ghoul" });
    t.id = "t1";
    const c = { ...combatOf([t, { ...tok(null), flags: undefined }]), scene: { tokens: { get: () => undefined } } };
    await clearForceDecorations(c);
    expect(t.update).not.toHaveBeenCalled();
    await clearForceDecorations({ combatants: [{ token: null }] });
  });

  it("swallows update errors and continues", async () => {
    const bad = tok({ forceId: "u", originalName: "A" });
    bad.update = vi.fn(async () => { throw new Error("boom"); });
    const good = tok({ forceId: "u", originalName: "B" });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(clearForceDecorations(combatOf([bad, good]))).resolves.toBeUndefined();
    expect(good.update).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does nothing on a non-active-GM client", async () => {
    globalThis.game.users.activeGM.isSelf = false;
    const t = tok({ forceId: "u", originalName: "Ghoul" });
    await clearForceDecorations(combatOf([t]));
    expect(t.update).not.toHaveBeenCalled();
  });
});
