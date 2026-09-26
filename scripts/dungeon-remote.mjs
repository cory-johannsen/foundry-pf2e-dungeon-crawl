/**
 * Routes a non-GM host's dungeon-crawl actions to whichever client is
 * actually logged in as GM (a human GM, or the world's standing "Agent"
 * GM login) — see docs/superpowers/specs/2026-09-20-gm-less-dungeon-crawl-agent-relay-design.md.
 * Mirrors player-choice.mjs's own GM-to-player prompt pattern, inverted: a
 * non-GM client asks whichever client is GM to act, instead of a GM asking
 * a specific player to answer. Shares that file's socket channel (a
 * Foundry module socket is conventionally exactly `module.<id>` — a second
 * ad-hoc channel name isn't guaranteed to be delivered the same way),
 * discriminated by `type`.
 */
import { SOCKET } from "./player-choice.mjs";
import { getRunState, findActiveHostedRun } from "./dungeon-runner.mjs";
import { isAuthorizedRequest } from "./dungeon-permissions.mjs";
import {
  startDungeonRun,
  resolveCurrentRoom,
  abandonDungeonRun,
  resolveCombatRoomOutcome,
  startCombatRecoveryFor,
  recordSkillChallengeOutcome,
  recordPuzzleStageOutcome,
  continueNarrativeRoom,
  chooseNarrativeOption,
  claimTreasureFor,
} from "./ui/dungeon-app.mjs";
import { undoRoomEntry } from "./dungeon-scene.mjs";
import { runFollowMoveNow, resnapTokenNow } from "./dungeon-follow.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";
const DEFAULT_TIMEOUT_MS = 15_000;
const pending = new Map();

/** One entry per routable action — every function here already exists as
 * one of dungeon-app.mjs's `sceneId`-parametrized exports (or
 * dungeon-scene.mjs's `undoRoomEntry`), so this table is pure dispatch,
 * nothing more. `args` always carries whatever the action needs, plus
 * `requestingUserId` (only `startRun` uses it — to set the new run's
 * `hostUserId` to whoever actually asked, not to this client's own id). */
const DUNGEON_ACTIONS = {
  startRun: (args) =>
    startDungeonRun({ ...args, hostUserId: args.requestingUserId }),
  resolveRoom: (args) =>
    resolveCurrentRoom(args.succeeded, {
      scene: game.scenes.get(args.sceneId),
    }),
  undoRoomEntry: (args) => undoRoomEntry(args.sceneId),
  abandonRun: (args) => abandonDungeonRun(args.sceneId),
  declareOutcome: (args) =>
    resolveCombatRoomOutcome(args.sceneId, args.succeeded),
  startCombatRecovery: (args) => startCombatRecoveryFor(args.sceneId),
  recordSkillChallengeOutcome: (args) =>
    recordSkillChallengeOutcome(args.sceneId, args.roomId, args.outcome),
  recordPuzzleStageOutcome: (args) =>
    recordPuzzleStageOutcome(
      args.sceneId,
      args.roomId,
      args.stageIndex,
      args.outcome,
    ),
  continueNarrativeRoom: (args) =>
    continueNarrativeRoom(args.sceneId, args.objective),
  chooseNarrativeOption: (args) =>
    chooseNarrativeOption(args.sceneId, args.optionIndex),
  claimTreasure: (args) => claimTreasureFor(args.sceneId),
  // #65: a non-GM host's own dungeon-follow.mjs hooks can't move followers
  // directly, so they request it — this is the one entry point that
  // actually runs on whichever client receives and executes the request.
  followMove: (args) => runFollowMoveNow(args.sceneId),
  // #141: same #65 pattern, for resnapDriftedTokens's own self-heal write.
  resnapToken: (args) => resnapTokenNow(args.sceneId, args.tokenId),
};

/**
 * Non-GM side: ask whichever client is GM to run `actionName` with `args`,
 * and wait for its ack (or time out). Resolves `true`/`false` — the caller
 * (dungeon-app.mjs's handlers) doesn't otherwise branch on the result, it
 * just re-renders either way and lets the broadcast (decideGmLessBroadcast)
 * deliver the actual state change once it lands.
 */
export function requestDungeonAction(
  actionName,
  args,
  { timeoutMs = DEFAULT_TIMEOUT_MS } = {},
) {
  const id = foundry.utils.randomID();
  return new Promise((resolve) => {
    const done = (ok) => {
      if (!pending.has(id)) return;
      clearTimeout(pending.get(id).timer);
      pending.delete(id);
      if (!ok)
        ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.RequestFailedWarning"),
        );
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    pending.set(id, { done, timer });

    game.socket.emit(SOCKET, {
      type: "dungeon-action-request",
      id,
      actionName,
      args,
      requestingUserId: game.user.id,
    });
  });
}

/**
 * Registered on every client (alongside registerChoiceSocket, same
 * channel). A non-GM client's own request never reaches here — only the
 * ack does; a GM client's own actions never emit a request either (they
 * call the dungeon-app.mjs functions directly). Only a client that is
 * genuinely GM ever executes an incoming request, and even then only
 * after isAuthorizedRequest confirms the requester is entitled to ask for
 * it — game.user.isGM alone answers "am I allowed to act," not "should I
 * honor THIS ask."
 */
export function registerDungeonActionSocket() {
  game.socket.on(SOCKET, async (msg) => {
    if (msg?.type === "dungeon-action-ack") {
      pending.get(msg.id)?.done(!!msg.ok);
      return;
    }
    if (msg?.type !== "dungeon-action-request") return;
    if (!game.user.isGM) return;

    const handler = Object.hasOwn(DUNGEON_ACTIONS, msg.actionName)
      ? DUNGEON_ACTIONS[msg.actionName]
      : undefined;
    const run =
      msg.actionName === "startRun"
        ? findActiveHostedRun()
        : getRunState(msg.args?.sceneId);
    let ok = false;
    if (
      handler &&
      isAuthorizedRequest(msg.actionName, msg.requestingUserId, run)
    ) {
      try {
        await handler({ ...msg.args, requestingUserId: msg.requestingUserId });
        ok = true;
      } catch (e) {
        console.error(
          `${MODULE_ID} | dungeon action "${msg.actionName}" failed`,
          e,
        );
      }
    }
    game.socket.emit(SOCKET, {
      type: "dungeon-action-ack",
      id: msg.id,
      ok,
    });
  });
}
