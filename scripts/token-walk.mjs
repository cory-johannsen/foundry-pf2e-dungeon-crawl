// Shared hop-by-hop token walking (#479 combat, #610 followers). A leaf
// module so both dungeon-combat.mjs and dungeon-follow.mjs can use it
// without importing each other.

const MODULE_ID = "pf2e-dungeon-crawl";

// #479: how long each individual grid-square hop of an AI-controlled
// token's movement pauses before the next one, so players can actually see
// it move instead of it jumping straight to its destination. Every hop
// still writes via { teleport: true } -- this paces the write-by-write
// sequence, it does not reintroduce Foundry's own animated movement
// pipeline (see #87/#141/#361: that pipeline's own wall-collision check
// silently relocates a token to the wrong cell; { teleport: true }
// bypasses it on every single hop, same as before).
// DEFAULT value (ms); the live value is the world setting
// `movementStepDelayMs`, read at call time by movementStepDelayMs().
export const MOVEMENT_STEP_DELAY_MS = 600;

export function readPacingSetting(key, fallback) {
  try {
    const v = game.settings.get(MODULE_ID, key);
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) return v;
  } catch {
    // settings unavailable or key unregistered: use the default
  }
  return fallback;
}

export const movementStepDelayMs = () =>
  readPacingSetting("movementStepDelayMs", MOVEMENT_STEP_DELAY_MS);

// #689: out-of-combat followers pause less per square than AI combat
// movers; the live value is the world setting `followerStepDelayMs`.
export const FOLLOWER_STEP_DELAY_MS = 150;

export const followerStepDelayMs = () =>
  readPacingSetting("followerStepDelayMs", FOLLOWER_STEP_DELAY_MS);

/** Writes `token`'s position through each cell in `steps` in order (an
 * ordered list of {gx, gy} cells, not including the token's own starting
 * cell), each still via { teleport: true } so Foundry's wall-collision
 * check never relocates a single hop (#87/#141/#361), with
 * `delayMs` (default movementStepDelayMs(), #689) between each write except after the last one.
 * `onHop` (optional) is called immediately before and after every write
 * (#610: lets the follow module keep its #87 resnap-suppression window
 * covering each hop). */
export async function walkTokenThroughSteps(token, steps, gridSize, onHop, delayMs) {
  for (let i = 0; i < steps.length; i += 1) {
    onHop?.();
    await token.update(
      { x: steps[i].gx * gridSize, y: steps[i].gy * gridSize },
      { teleport: true },
    );
    onHop?.();
    if (i < steps.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs ?? movementStepDelayMs()));
    }
  }
}
