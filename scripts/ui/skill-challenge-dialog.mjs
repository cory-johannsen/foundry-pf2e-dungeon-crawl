/** #822: the prompt shown when a player clicks a skill-challenge
 * room-feature token — which of their party characters attempts, and
 * with which of the challenge's own specialty skills (#553: the
 * player's choice, unlike a puzzle stage's fixed skill). Mirrors #754's
 * trap-disable-dialog.mjs and #822's own puzzle-stage-dialog.mjs. */
import { skillLabel } from "./dungeon-app.mjs";

/** Pure: shape the dialog's options. Returns null when there is nothing
 * to choose from, so the caller shows a notice. */
export function buildSkillChallengeChoices(specialtySkills, characters) {
  if (!Array.isArray(specialtySkills) || specialtySkills.length === 0) return null;
  if (!Array.isArray(characters) || characters.length === 0) return null;
  return {
    skills: specialtySkills.map((slug) => ({ slug, label: skillLabel(slug) })),
    characters,
  };
}

/** Resolves `{actorId, skill}` or null (cancelled / nothing to choose). */
export async function promptSkillChallenge(specialtySkills, characters) {
  const choices = buildSkillChallengeChoices(specialtySkills, characters);
  if (!choices) return null;
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const who = choices.characters
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const skills = choices.skills
    .map((s) => `<option value="${esc(s.slug)}">${esc(s.label)}</option>`)
    .join("");
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogTitle") },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogCharacterLabel")}</label>
          <select name="actorId" style="width:100%;">${who}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogSkillLabel")}</label>
          <select name="skill" style="width:100%;">${skills}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: "attempt",
        label: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogConfirm"),
        default: true,
        callback: (_e, _b, dialog) => ({
          actorId: dialog.element.querySelector('[name="actorId"]').value,
          skill: dialog.element.querySelector('[name="skill"]').value,
        }),
      },
      {
        action: "cancel",
        label: game.i18n.localize("PF2EDC.Dungeon.SkillChallenge.DialogCancel"),
      },
    ],
    rejectClose: false,
  });
}
