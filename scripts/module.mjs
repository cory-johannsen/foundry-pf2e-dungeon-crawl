import { generateEncounter } from "./encounter-generator.mjs";
import {
  DungeonApp,
  resolveCurrentRoom,
  retreatFromCard,
  claimTreasureFor,
  attemptPuzzleStageFor,
  attemptSkillChallengeFor,
  skillLabel,
} from "./ui/dungeon-app.mjs";
import { SoundPreviewApp } from "./ui/sound-preview-app.mjs";
import { retreatCardActionFor } from "./dungeon-retreat.mjs";
import {
  abandonRun,
  getRunState,
  revealRoomFeature,
  findActiveHostedRun,
  findHostedRunForBroadcast,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
  getPendingTreasureCustomization,
  applyTreasureCustomization,
} from "./dungeon-runner.mjs";
import {
  attemptableCharacters,
  decideOpenDungeon,
  decideGmLessBroadcast,
} from "./dungeon-permissions.mjs";
import {
  registerDungeonActionSocket,
  requestDungeonAction,
} from "./dungeon-remote.mjs";
import {
  routeTargetTokenEvent,
  runRoomFeatureAction,
} from "./room-feature-tokens.mjs";
import {
  handleDungeonDoorOpened,
  teardownDungeonRun,
  sweepLooseNpcActors,
  applyRoomFeatureUsedArtForScene,
} from "./dungeon-scene.mjs";
import {
  maybeResolveCombatForActor,
  maybeResolveCombatForCondition,
  autoDefeatZeroHpNpcs,
  maybeResolveCombatForCombatant,
  autoPlayCombatantTurnIfDue,
  getPendingAgentTurn,
  applyAgentDecision,
  toggleAgentControlled,
  handleRangedAttackForReactiveStrike,
  handleManualStrikeDamage,
  offerReactiveStrikesAgainst,
  clearDetection,
  handleStealthBreakMessage,
} from "./dungeon-combat.mjs";
import {
  followLeaderIfDue,
  followLeaderOnDoorOpened,
  resnapDriftedTokens,
} from "./dungeon-follow.mjs";
import {
  getPendingTrapCustomization,
  applyTrapCustomization,
  handleTrapTokenMove,
  attemptTrapDisableForScene,
} from "./trap-combat.mjs";
import { registerFlankedIndicator } from "./flanking-indicator.mjs";
import { promptTrapDisable } from "./ui/trap-disable-dialog.mjs";
import { promptPuzzleStage } from "./ui/puzzle-stage-dialog.mjs";
import { promptSkillChallenge } from "./ui/skill-challenge-dialog.mjs";
import { handleRoomFeatureClick } from "./room-feature-check.mjs";
import { registerGenerator } from "./generator-registry.mjs";
import { DefaultGenerator } from "./default-generator.mjs";
import { ensureWorldMacros } from "./world-macros.mjs";

const MODULE_ID = "pf2e-dungeon-crawl";

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "dungeonRuns", {
    scope: "world",
    config: false,
    type: Object,
    default: {},
  });
  // Client scope, not world: a world-scope setting's value syncs to every
  // connected client (players included) regardless of config visibility,
  // which would expose the GM's bearer token via game.settings.get(). Each
  // GM's browser holds its own copy instead.
  game.settings.register(MODULE_ID, "agentServiceUrl", {
    name: "PF2EDC.Settings.AgentServiceUrlLabel",
    hint: "PF2EDC.Settings.AgentServiceUrlHint",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "agentServiceApiKey", {
    name: "PF2EDC.Settings.AgentServiceApiKeyLabel",
    hint: "PF2EDC.Settings.AgentServiceApiKeyHint",
    scope: "client",
    config: true,
    type: String,
    default: "",
  });
  // #439: at a dead end, turn back to the last fork without a button press.
  game.settings.register(MODULE_ID, "autoRetreat", {
    name: "PF2EDC.Settings.AutoRetreat.Name",
    hint: "PF2EDC.Settings.AutoRetreat.Hint",
    scope: "world",
    config: true,
    type: Boolean,
    default: false,
  });
  // #479: live-tunable pacing of AI-controlled combat (milliseconds).
  game.settings.register(MODULE_ID, "movementStepDelayMs", {
    name: "PF2EDC.Settings.MovementStepDelayMs.Name",
    hint: "PF2EDC.Settings.MovementStepDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 100, max: 3000, step: 50 },
    default: 600,
  });
  // #689: pacing of out-of-combat followers.
  game.settings.register(MODULE_ID, "followerStepDelayMs", {
    name: "PF2EDC.Settings.FollowerStepDelayMs.Name",
    hint: "PF2EDC.Settings.FollowerStepDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 50, max: 3000, step: 50 },
    default: 150,
  });
  game.settings.register(MODULE_ID, "actionPaceDelayMs", {
    name: "PF2EDC.Settings.ActionPaceDelayMs.Name",
    hint: "PF2EDC.Settings.ActionPaceDelayMs.Hint",
    scope: "world",
    config: true,
    type: Number,
    range: { min: 0, max: 5000, step: 100 },
    default: 1200,
  });
  // #600: lets a GM audition every dungeon-crawl sound effect without
  // triggering the real game event each one is tied to.
  game.settings.registerMenu(MODULE_ID, "soundPreview", {
    name: "PF2EDC.SoundPreview.Title",
    label: "PF2EDC.Settings.SoundPreview.Label",
    hint: "PF2EDC.Settings.SoundPreview.Hint",
    icon: "fa-solid fa-volume-high",
    type: SoundPreviewApp,
    restricted: true,
  });
});

Hooks.once("ready", async () => {
  registerGenerator(DefaultGenerator);
  const module = game.modules.get(MODULE_ID);
  module.api = {
    generateEncounter: (options) => generateEncounter(options),
    openDungeon: () => {
      const decision = decideOpenDungeon(findActiveHostedRun());
      if (decision.action === "warnAlreadyHosted") {
        const hostUser = game.users.get(decision.hostUserId);
        return ui.notifications.warn(
          game.i18n.format("PF2EDC.Dungeon.AlreadyHostedWarning", {
            host: hostUser?.name ?? "?",
          }),
        );
      }
      return new DungeonApp().render(true);
    },
    resetDungeon: async (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const targetSceneId = sceneId ?? canvas?.scene?.id;
      if (!targetSceneId) return;
      const scene = game.scenes.get(targetSceneId);
      const state = getRunState(targetSceneId);
      await abandonRun({ sceneId: targetSceneId });
      if (scene)
        await teardownDungeonRun(scene, {
          previousSceneId: state?.previousSceneId ?? null,
        });
    },
    getPendingAgentTurn: async (combatId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId ?? game.combat?.id);
      return combat ? await getPendingAgentTurn(combat) : null;
    },
    applyAgentDecision: (
      combatId,
      combatantId,
      candidateId,
      rationale = null,
    ) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const combat = game.combats.get(combatId);
      return combat
        ? applyAgentDecision(combat, combatantId, candidateId, rationale)
        : null;
    },
    postAgentLoopStatus: async () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const baseUrl = game.settings.get(MODULE_ID, "agentServiceUrl");
      let reachable = false;
      if (baseUrl) {
        try {
          const res = await fetch(`${baseUrl.replace(/\/$/, "")}/v1/health`);
          reachable = res.ok;
        } catch {
          reachable = false;
        }
      }
      const key = !baseUrl
        ? "PF2EDC.Dungeon.Combat.AgentServiceStatusNotConfigured"
        : reachable
          ? "PF2EDC.Dungeon.Combat.AgentServiceStatusReachable"
          : "PF2EDC.Dungeon.Combat.AgentServiceStatusUnreachable";
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create({ content: game.i18n.localize(key), whisper: gmIds });
    },
    getPendingTrapCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return getPendingTrapCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyTrapCustomization: (actorId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return applyTrapCustomization(actorId, customization);
    },
    getPendingSkillChallengeCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return getPendingSkillChallengeCustomization(
        sceneId ?? canvas?.scene?.id,
      );
    },
    applySkillChallengeCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return applySkillChallengeCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    getPendingPuzzleCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return getPendingPuzzleCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyPuzzleCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return applyPuzzleCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    getPendingNarrativeCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return getPendingNarrativeCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyNarrativeCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return applyNarrativeCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    getPendingTreasureCustomization: (sceneId) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return getPendingTreasureCustomization(sceneId ?? canvas?.scene?.id);
    },
    applyTreasureCustomization: (sceneId, roomId, customization) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return applyTreasureCustomization(
        sceneId ?? canvas?.scene?.id,
        roomId,
        customization,
      );
    },
    registerGenerator,
  };
  if (game.user.isGM) {
    try {
      await ensureWorldMacros();
    } catch (e) {
      console.error(`${MODULE_ID} | ensureWorldMacros failed`, e);
    }
  }
  console.log(
    `${MODULE_ID} | ready — api attached to game.modules.get('${MODULE_ID}').api`,
  );
});

Hooks.once("ready", registerDungeonActionSocket);

/** #158: opens the Dungeon Crawl tracker if it isn't already rendered. */
function openDungeonTrackerIfNotOpen() {
  if (!foundry.applications.instances.get("pf2edc-dungeon-app"))
    new DungeonApp().render(true);
}

Hooks.on("updateWall", async (wall, changes) => {
  followLeaderOnDoorOpened(wall, changes);
  if (changes.ds !== CONST.WALL_DOOR_STATES.OPEN) return;
  const { autoOpenTracker } = await handleDungeonDoorOpened(
    wall.parent?.id,
    wall.id,
  );
  if (autoOpenTracker) openDungeonTrackerIfNotOpen();
});

/** #611/#623: a player targeting a room-feature prop token triggers its
 * room's treasure claim / puzzle or challenge reveal. Thin wrapper: the
 * decision is the pure routeTargetTokenEvent; a GM client runs the
 * authoritative runRoomFeatureAction itself, anyone else relays it.
 * `token` is the canvas Token placeable -- flags and scene come from its
 * document (`token.document`), with `token.*` fallbacks for a document. */
async function triggerRoomFeatureToken(user, token, targeted) {
  const doc = token?.document ?? token;
  const sceneId = doc?.parent?.id ?? token?.scene?.id;
  const route = routeTargetTokenEvent({
    userId: user?.id,
    gameUserId: game.user?.id,
    targeted,
    flags: doc?.flags?.[MODULE_ID],
    sceneId,
    state: sceneId ? getRunState(sceneId) : null,
  });
  if (!route) return;
  const isGM = game.user.isGM;
  const runState = getRunState(sceneId);
  try {
    await handleRoomFeatureClick(route, {
      isGM,
      relay: requestDungeonAction,
      runAction: (r) =>
        runRoomFeatureAction(r, {
          getRunState,
          claimTreasureFor,
          revealRoomFeature,
          applyUsedArt: applyRoomFeatureUsedArtForScene,
        }),
      onError: (err) =>
        console.error(`${MODULE_ID} | room-feature interaction failed`, err),
      getRunState,
      // #822: the GM/host may pick any party character; any other player
      // only the ones they own (the GM-side relay handler re-checks).
      characters: attemptableCharacters({
        userId: game.user.id,
        isGM,
        isHost: !!runState?.hostUserId && runState.hostUserId === game.user.id,
        partyMembers: game.actors?.party?.members ?? [],
      }).map(({ id, name }) => ({ id, name })),
      skillLabel,
      promptPuzzleStage,
      promptSkillChallenge,
      attemptPuzzleStageFor,
      attemptSkillChallengeFor,
      notify: (msg) => ui.notifications.warn(msg),
      localize: (key) => game.i18n.localize(key),
    });
  } catch (err) {
    console.error(`${MODULE_ID} | room-feature check prompt failed`, err);
  }
}

Hooks.on("targetToken", (user, token, targeted) =>
  triggerRoomFeatureToken(user, token, targeted),
);

/** A plain left-click on a token only selects it, and Foundry never routes a
 * click on a token the player doesn't own to it -- listeners bound on the
 * token (or the stage) don't see it either. Door clicks work for every
 * player because Foundry's DoorControl is not a placeable: it is a
 * standalone display object on the controls layer with its own pointerdown
 * handler. Do the same for room-feature props: one invisible, clickable
 * control per prop token, positioned over it. Rebuilt wholesale whenever
 * the canvas is ready or a prop token is created, moved or deleted. */
let roomFeatureControls = [];

function clearRoomFeatureControls() {
  for (const c of roomFeatureControls) c.destroy?.({ children: true });
  roomFeatureControls = [];
}

/** #754: token ids with a disable prompt currently open (no double dialogs). */
const trapDisableInFlight = new Set();

/** #754: click on a detected trap token. Reads only token-document data --
 * non-GM clients can't read the hazard actor. */
async function triggerTrapDisableClick(doc) {
  if (trapDisableInFlight.has(doc.id)) return;
  trapDisableInFlight.add(doc.id);
  try {
    const sceneId = doc.parent?.id;
    // The whole party, like the tracker's other skill checks; the GM-side
    // handler re-checks that the requester may roll for the party.
    const characters = (game.actors?.party?.members ?? []).filter(
      (actor) => actor.type === "character",
    );
    if (!characters.length) {
      ui.notifications.warn(
        game.i18n.localize("PF2EDC.Dungeon.Trap.DisableNoCharacters"),
      );
      return;
    }
    const checks = doc.flags?.[MODULE_ID]?.trapDisableChecks;
    if (!Array.isArray(checks) || checks.length === 0) {
      ui.notifications.warn(
        game.i18n.localize("PF2EDC.Dungeon.Trap.CannotDisable"),
      );
      return;
    }
    const choice = await promptTrapDisable(checks, characters);
    if (!choice?.actorId || !choice?.skill) return;
    if (game.user.isGM) {
      await attemptTrapDisableForScene(sceneId, choice.actorId, choice.skill);
    } else {
      await requestDungeonAction("attemptTrapDisable", {
        sceneId,
        actorId: choice.actorId,
        skill: choice.skill,
      });
    }
  } finally {
    trapDisableInFlight.delete(doc.id);
  }
}

function syncRoomFeatureControls() {
  clearRoomFeatureControls();
  const layer = canvas?.controls;
  const scene = canvas?.scene;
  if (!layer || !scene) return;
  const size = canvas.grid?.size ?? 100;
  for (const doc of scene.tokens) {
    const flags = doc.flags?.[MODULE_ID];
    const isFeature = !!flags?.roomFeatureKind;
    const isTrap = !!flags?.trapHazard && !doc.hidden && !flags?.trapSpent;
    if (!isFeature && !isTrap) continue;
    const control = new PIXI.Graphics();
    const w = (doc.width || 1) * size;
    const h = (doc.height || 1) * size;
    control.beginFill(0xffffff, 0.001);
    control.drawRect(0, 0, w, h);
    control.endFill();
    control.hitArea = new PIXI.Rectangle(0, 0, w, h);
    control.position.set(doc.x, doc.y);
    control.eventMode = "static";
    control.cursor = "pointer";
    control.on("pointerdown", (event) => {
      if (event?.button !== undefined && event.button !== 0) return;
      event.stopPropagation?.();
      if (!isFeature) {
        triggerTrapDisableClick(doc).catch((err) =>
          console.error(`${MODULE_ID} | trap disable click failed`, err),
        );
        return;
      }
      triggerRoomFeatureToken(game.user, { document: doc }, true).catch((err) =>
        console.error(`${MODULE_ID} | room-feature click failed`, err),
      );
    });
    layer.addChild(control);
    roomFeatureControls.push(control);
  }
}

Hooks.on("canvasReady", syncRoomFeatureControls);
Hooks.on("canvasTearDown", clearRoomFeatureControls);
for (const hook of ["createToken", "updateToken", "deleteToken"]) {
  Hooks.on(hook, (doc) => {
    // `doc` is the full document (updateToken's 2nd arg is only the changes),
    // so hidden / trapSpent changes on a trap token are covered by trapHazard.
    const f = doc?.flags?.[MODULE_ID];
    if (
      doc?.parent?.id === canvas?.scene?.id &&
      (f?.roomFeatureKind !== undefined || f?.trapHazard !== undefined)
    )
      syncRoomFeatureControls();
  });
}

/** #439: binds the "Turn back" button on the retreat chat card (posted by
 * dungeon-scene.mjs's announceRetreatIfAvailable). Disabled, not removed, for a
 * user who is neither a GM nor the run's host. */
Hooks.on("renderChatMessageHTML", (message, html) => {
  const action = retreatCardActionFor(message, {
    isGM: game.user.isGM,
    hostUserId: getRunState(message?.flags?.[MODULE_ID]?.retreatCard?.sceneId)
      ?.hostUserId,
    userId: game.user.id,
  });
  if (!action) return;
  const button = html.querySelector?.("button[data-pf2edc-retreat]");
  if (!button) return;
  button.disabled = !action.enabled;
  button.addEventListener("click", async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    button.disabled = true;
    try {
      await retreatFromCard(action.sceneId);
    } finally {
      // Re-enable so a refused press (e.g. active combat) can be retried; a
      // successful retreat makes a repeat press a refused no-op anyway.
      button.disabled = !action.enabled;
    }
  });
});

/** #109: keeps every non-host, non-GM client's DungeonApp in sync with a
 * GM-less run. */
function syncGmLessDungeonBroadcast() {
  const existing = foundry.applications.instances.get("pf2edc-dungeon-app");
  const decision = decideGmLessBroadcast(
    findHostedRunForBroadcast(),
    !!existing,
  );
  if (decision.action === "open") new DungeonApp().render(true);
  else if (decision.action === "render") existing.render();
  else if (decision.action === "close") existing.close();
}

function onDungeonRunsSettingChanged(setting) {
  if (setting.key !== `${MODULE_ID}.dungeonRuns`) return;
  syncGmLessDungeonBroadcast();
}
Hooks.on("updateSetting", onDungeonRunsSettingChanged);
Hooks.on("createSetting", onDungeonRunsSettingChanged);
Hooks.on("canvasReady", syncGmLessDungeonBroadcast);

/**
 * #14: a dungeon scene deleted outside the tracker's own Abandon flow (most
 * likely a GM deleting it directly via Foundry's Scene Directory) skips
 * teardownDungeonRun entirely, orphaning both its dungeonRuns settings entry
 * and any NPC/corpse actors its encounters spawned — Actors aren't embedded
 * in the Scene document, so Foundry's own delete cascade can't clean those
 * up for us. The normal Abandon flow (abandonDungeonRun) already prunes the
 * settings entry via abandonRun *before* calling teardownDungeonRun's own
 * scene.delete(), so by the time this hook fires for that path,
 * getRunState is already null and this is a no-op — it only ever does real
 * work for a scene deleted through some other path. Gated on isGM since
 * Actor.deleteDocuments is a GM-only operation; every connected client sees
 * this hook, but only the GM(s) among them can act on it.
 */
Hooks.on("deleteScene", async (scene) => {
  if (!game.user.isGM || !getRunState(scene.id)) return;
  await sweepLooseNpcActors(scene, { deleteTokens: false });
  await abandonRun({ sceneId: scene.id });
});

/** Advances a dungeon room the instant its Combat auto-resolves. */
async function onCombatAutoResolved(result) {
  if (result?.dungeonSlot != null)
    await resolveCurrentRoom(result.outcome === "victory", {
      scene: result.scene,
    });
}

Hooks.on("updateActor", async (actor) => {
  await autoDefeatZeroHpNpcs(actor);
  onCombatAutoResolved(await maybeResolveCombatForActor(actor));
});
Hooks.on("createItem", async (item) => {
  onCombatAutoResolved(await maybeResolveCombatForCondition(item));
});
Hooks.on("updateCombatant", async (combatant, changes) =>
  onCombatAutoResolved(
    await maybeResolveCombatForCombatant(combatant, changes),
  ),
);

/** ITEM-8: plays a non-player combatant's turn automatically. */
Hooks.on("updateCombat", (combat, changes) => {
  if (changes.turn === undefined && changes.round === undefined) return;
  autoPlayCombatantTurnIfDue(combat);
});

/** #20: moves AI-controlled party actors' tokens toward the run's leader
 * as the party explores between fights. */
Hooks.on("updateToken", followLeaderIfDue);

/** #141: self-heals any token that lands off-grid after a position update,
 * on any scene this module manages — a separate concern from
 * `followLeaderIfDue` on the same hook, not gated to the leader/followers
 * or to outside-combat only. */
Hooks.on("updateToken", resnapDriftedTokens);
/** #753: detect/trigger a trap when a party token approaches or steps
 * onto its footprint. */
Hooks.on("updateToken", (tokenDoc, changes) => handleTrapTokenMove(tokenDoc, changes));

/** #769: client-side, write-nothing "Flanked" badge on flanked tokens in combat. */
registerFlankedIndicator();

/** #202: reactive/triggered NPC abilities (ranged-Strike-triggered Reactive
 * Strike/Attack of Opportunity). */
Hooks.on("createChatMessage", handleRangedAttackForReactiveStrike);

/** #47: auto-applies a human party member's manual Strike damage to its
 * roll's own already-correct target, instead of relying on PF2e's own
 * manual "Apply Damage" button (which resolves from live selection state). */
Hooks.on("createChatMessage", handleManualStrikeDamage);

/** #616: remove the Stealth display conditions this module applied and the
 * detection flags when a combat ends (active GM only, so it runs once). */
Hooks.on("deleteCombat", async (combat) => {
  if (!(game.users?.activeGM?.isSelf ?? game.user?.isGM)) return;
  await clearDetection(combat);
});

/** #616: a sneaker's attack roll reveals it (active GM only, handled inside). */
Hooks.on("createChatMessage", handleStealthBreakMessage);

Hooks.on("getSceneControlButtons", (controls) => {
  const tokenControl =
    controls.find?.((c) => c.name === "token") ?? controls.token;
  if (!tokenControl) return;
  const agentLoopButton = {
    name: "pf2edc-agent-loop-status",
    title: game.i18n.localize("PF2EDC.SceneControl.AgentLoopStatusLabel"),
    icon: "fa-solid fa-robot",
    visible: game.user.isGM,
    button: true,
    onClick: () => game.modules.get(MODULE_ID).api.postAgentLoopStatus(),
  };
  if (Array.isArray(tokenControl.tools)) {
    tokenControl.tools.push(agentLoopButton);
  } else if (tokenControl.tools && typeof tokenControl.tools === "object") {
    tokenControl.tools["pf2edc-agent-loop-status"] = agentLoopButton;
  }
});

/** GM per-combatant override for the agentControlled default (Task 2). */
Hooks.on("getCombatTrackerEntryContext", (html, menuItems) => {
  menuItems.push({
    name: "PF2EDC.Dungeon.Combat.ToggleAgentControlLabel",
    icon: '<i class="fa-solid fa-robot"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return (
        !!combatant &&
        !game.actors?.party?.members?.some((m) => m.id === combatant.actor?.id)
      );
    },
    callback: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      if (combatant) toggleAgentControlled(combatant);
    },
  });
  menuItems.push({
    name: "PF2EDC.Dungeon.Combat.ReactiveStrikeCheckLabel",
    icon: '<i class="fa-solid fa-bolt"></i>',
    condition: (li) => {
      const combatant = game.combat?.combatants.get(li.dataset.combatantId);
      return game.user.isGM && !!combatant && !combatant.isDefeated;
    },
    callback: (li) => {
      if (!game.user.isGM) return;
      const combat = game.combat;
      const combatant = combat?.combatants.get(li.dataset.combatantId);
      if (combatant) offerReactiveStrikesAgainst(combat, combatant);
    },
  });
});
