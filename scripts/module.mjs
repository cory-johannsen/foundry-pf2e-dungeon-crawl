import { generateEncounter } from "./encounter-generator.mjs";
import { DungeonApp, resolveCurrentRoom } from "./ui/dungeon-app.mjs";
import {
  abandonRun,
  getRunState,
  findActiveHostedRun,
  findHostedRunForBroadcast,
  getPendingSkillChallengeCustomization,
  applySkillChallengeCustomization,
  getPendingPuzzleCustomization,
  applyPuzzleCustomization,
  getPendingNarrativeCustomization,
  applyNarrativeCustomization,
} from "./dungeon-runner.mjs";
import {
  decideOpenDungeon,
  decideGmLessBroadcast,
} from "./dungeon-permissions.mjs";
import { registerDungeonActionSocket } from "./dungeon-remote.mjs";
import {
  handleDungeonDoorOpened,
  teardownDungeonRun,
  sweepLooseNpcActors,
} from "./dungeon-scene.mjs";
import {
  maybeResolveCombatForActor,
  maybeResolveCombatForCombatant,
  autoPlayCombatantTurnIfDue,
  getPendingAgentTurn,
  applyAgentDecision,
  toggleAgentControlled,
  agentLoopStatus,
  handleRangedAttackForReactiveStrike,
  handleManualStrikeDamage,
  offerReactiveStrikesAgainst,
} from "./dungeon-combat.mjs";
import {
  followLeaderIfDue,
  followLeaderOnDoorOpened,
} from "./dungeon-follow.mjs";
import {
  getPendingTrapCustomization,
  applyTrapCustomization,
} from "./trap-combat.mjs";
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
  game.settings.register(MODULE_ID, "agentServiceUrl", {
    name: "PF2EDC.Settings.AgentServiceUrlLabel",
    hint: "PF2EDC.Settings.AgentServiceUrlHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
  });
  game.settings.register(MODULE_ID, "agentServiceApiKey", {
    name: "PF2EDC.Settings.AgentServiceApiKeyLabel",
    hint: "PF2EDC.Settings.AgentServiceApiKeyHint",
    scope: "world",
    config: true,
    type: String,
    default: "",
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
    recordAgentLoopHeartbeat: ({
      provider = null,
      pollIntervalMs = null,
    } = {}) => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return game.settings.set(MODULE_ID, "agentLoopHeartbeat", {
        timestamp: Date.now(),
        provider,
        pollIntervalMs,
      });
    },
    getAgentLoopStatus: () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      return agentLoopStatus();
    },
    postAgentLoopStatus: async () => {
      if (!game.user.isGM)
        return ui.notifications.warn(
          game.i18n.localize("PF2EDC.Dungeon.GmOnlyWarning"),
        );
      const status = agentLoopStatus();
      const key = status.connected
        ? "PF2EDC.Dungeon.Combat.AgentLoopStatusConnected"
        : status.lastSeenMs
          ? "PF2EDC.Dungeon.Combat.AgentLoopStatusStale"
          : "PF2EDC.Dungeon.Combat.AgentLoopStatusNeverSeen";
      const content = game.i18n.format(key, {
        provider: status.provider ?? "?",
        seconds: status.secondsAgo ?? 0,
      });
      const gmIds = ChatMessage.getWhisperRecipients("GM").map((u) => u.id);
      return ChatMessage.create({ content, whisper: gmIds });
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

Hooks.on("updateActor", async (actor) =>
  onCombatAutoResolved(await maybeResolveCombatForActor(actor)),
);
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

/** #202: reactive/triggered NPC abilities (ranged-Strike-triggered Reactive
 * Strike/Attack of Opportunity). */
Hooks.on("createChatMessage", handleRangedAttackForReactiveStrike);

/** #47: auto-applies a human party member's manual Strike damage to its
 * roll's own already-correct target, instead of relying on PF2e's own
 * manual "Apply Damage" button (which resolves from live selection state). */
Hooks.on("createChatMessage", handleManualStrikeDamage);

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
