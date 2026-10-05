/** #754: the prompt shown when a player clicks a detected trap token --
 * which of their party characters attempts the disable, and with which of
 * the trap's listed skills (shown with its DC). Data comes from token flags
 * (`trapDisableChecks`), never the hazard actor (players can't read it). */

/** Pure: shape the dialog's options. Returns null when there is nothing to
 * choose from (no checks or no characters) so the caller shows a notice. */
export function buildTrapDisableChoices(checks, characters) {
  if (!Array.isArray(checks) || checks.length === 0) return null;
  if (!Array.isArray(characters) || characters.length === 0) return null;
  return {
    skills: checks.map(({ skill, dc, label }) => ({
      skill,
      dc,
      label: label ?? skill,
    })),
    characters: characters.map(({ id, name }) => ({ id, name })),
  };
}

/** Resolves `{actorId, skill}` or null (cancelled / nothing to choose). */
export async function promptTrapDisable(checks, characters) {
  const choices = buildTrapDisableChoices(checks, characters);
  if (!choices) return null;
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const who = choices.characters
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const skills = choices.skills
    .map(
      (s) =>
        `<option value="${esc(s.skill)}">${esc(
          game.i18n.format("PF2EDC.Dungeon.Trap.DisableOption", {
            skill: s.label,
            dc: s.dc,
          }),
        )}</option>`,
    )
    .join("");
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Dungeon.Trap.DisableTitle") },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.Trap.CharacterLabel")}</label>
          <select name="actorId" style="width:100%;">${who}</select>
        </div>
        <div class="form-group">
          <select name="skill" style="width:100%;">${skills}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: "disable",
        label: game.i18n.localize("PF2EDC.Dungeon.Trap.DisableConfirm"),
        default: true,
        callback: (_e, _b, dialog) => ({
          actorId: dialog.element.querySelector('[name="actorId"]').value,
          skill: dialog.element.querySelector('[name="skill"]').value,
        }),
      },
      {
        action: "cancel",
        label: game.i18n.localize("PF2EDC.Dungeon.Trap.DisableCancel"),
      },
    ],
    rejectClose: false,
  });
}
