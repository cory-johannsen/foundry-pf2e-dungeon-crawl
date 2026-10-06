/** #822: the prompt shown when a player clicks a puzzle room-feature
 * token — which of their party characters attempts which of the
 * puzzle's own not-yet-attempted stages (each stage's own skill is fixed,
 * #137, never the player's choice — only which stage and who). Mirrors
 * #754's trap-disable-dialog.mjs exactly. */

/** Pure: shape the dialog's options from the room's own persisted stage
 * list. Returns null when there is nothing left to attempt or no
 * characters to attempt it, so the caller shows a notice. */
export function buildPuzzleStageChoices(stages, characters) {
  if (!Array.isArray(characters) || characters.length === 0) return null;
  const remaining = (stages ?? [])
    .filter((s) => !s.attempted)
    .map(({ index, skill, dc, label }) => ({ index, skill, dc, label: label ?? skill }));
  if (remaining.length === 0) return null;
  return { stages: remaining, characters };
}

/** Resolves `{actorId, stageIndex}` or null (cancelled / nothing to choose). */
export async function promptPuzzleStage(stages, characters) {
  const choices = buildPuzzleStageChoices(stages, characters);
  if (!choices) return null;
  const { DialogV2 } = foundry.applications.api;
  const esc = (s) => foundry.utils.escapeHTML?.(String(s)) ?? String(s);
  const who = choices.characters
    .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
    .join("");
  const stageOptions = choices.stages
    .map(
      (s) =>
        `<option value="${s.index}">${esc(
          game.i18n.format("PF2EDC.Dungeon.Puzzle.DialogStageOption", {
            skill: s.label,
            dc: s.dc,
          }),
        )}</option>`,
    )
    .join("");
  return DialogV2.wait({
    window: { title: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogTitle") },
    content: `
      <form>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogCharacterLabel")}</label>
          <select name="actorId" style="width:100%;">${who}</select>
        </div>
        <div class="form-group">
          <label>${game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogStageLabel")}</label>
          <select name="stageIndex" style="width:100%;">${stageOptions}</select>
        </div>
      </form>`,
    buttons: [
      {
        action: "attempt",
        label: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogConfirm"),
        default: true,
        callback: (_e, _b, dialog) => ({
          actorId: dialog.element.querySelector('[name="actorId"]').value,
          stageIndex: Number(dialog.element.querySelector('[name="stageIndex"]').value),
        }),
      },
      {
        action: "cancel",
        label: game.i18n.localize("PF2EDC.Dungeon.Puzzle.DialogCancel"),
      },
    ],
    rejectClose: false,
  });
}
