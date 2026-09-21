/**
 * A "Choose traits…" button that pops up a searchable multi-select dialog,
 * instead of an inline filterable list embedded directly in the form. The
 * inline version (still used inside the popup itself) turned out to be too
 * much — the full trait list runs to 200+ entries, and an 8-row `<select>`
 * sitting in the middle of the main dialog crowded out everything else.
 *
 * A typed word that isn't an actual trait (e.g. "castle", a setting rather
 * than a creature trait) is still impossible to submit — the popup only ever
 * offers real traits, exactly the same guarantee the inline version had.
 */
export function traitOptionsHtml(traits, selected = []) {
  return traits
    .map((t) => `<option value="${t}"${selected.includes(t) ? ' selected' : ''}>${t}</option>`)
    .join('');
}

export function wireTraitFilters(root) {
  root.querySelectorAll('.dommt-trait-filter').forEach((input) => {
    input.addEventListener('input', () => {
      const select = root.querySelector(`select[name="${input.dataset.for}"]`);
      if (!select) return;
      const q = input.value.trim().toLowerCase();
      for (const opt of select.options) opt.hidden = q.length > 0 && !opt.value.includes(q);
    });
  });
}

function summaryText(selected) {
  return selected.length ? selected.join(', ') : '—';
}

/** The field as it appears in the main form: a label, a read-only summary of
 * what's picked, a button that opens the picker, and a hidden input carrying
 * the comma-joined value other code reads back with `readTraitField`. */
export function traitFieldHtml({ name, label, buttonLabel, selected = [] }) {
  return `
    <div class="form-group">
      <label>${label}</label>
      <div class="dommt-trait-field">
        <span class="dommt-trait-field__summary" data-for="${name}">${summaryText(selected)}</span>
        <button type="button" class="dommt-trait-choose" data-for="${name}" data-title="${label}">${buttonLabel}</button>
      </div>
      <input type="hidden" name="${name}" value="${selected.join(',')}" />
    </div>`;
}

export function readTraitField(root, name) {
  const hidden = root.querySelector(`input[type="hidden"][name="${name}"]`);
  return hidden?.value ? hidden.value.split(',').filter(Boolean) : [];
}

async function openTraitPickerDialog({ title, traits, selected }) {
  const { DialogV2 } = foundry.applications.api;
  // `size="16"` alone doesn't reliably grow a multi-select's rendered height
  // in every browser — confirmed live it can render as a single 32px row
  // regardless of `size`. An explicit `!important` inline height is the only
  // thing that actually forced it to show more than one row.
  return DialogV2.wait({
    window: { title },
    position: { width: 480 },
    content: `
      <form>
        <input type="text" class="dommt-trait-filter" data-for="picker" placeholder="Filter…" />
        <select name="picker" multiple size="16" style="width:100%; height:420px !important;">${traitOptionsHtml(traits, selected)}</select>
      </form>`,
    render: (_event, dialog) => wireTraitFilters(dialog.element),
    buttons: [
      {
        action: 'ok',
        label: 'OK',
        default: true,
        callback: (_event, _button, dialog) =>
          Array.from(dialog.element.querySelector('select[name="picker"]').selectedOptions).map((o) => o.value)
      },
      { action: 'cancel', label: 'Cancel' }
    ],
    rejectClose: false
  });
}

/** Wires every `.dommt-trait-choose` button under `root` to open the popup
 * picker (fed by `traits`, the full available list) and write its result
 * back into that field's hidden input and summary text. */
export function wireTraitPickerButtons(root, traits) {
  root.querySelectorAll('.dommt-trait-choose').forEach((button) => {
    button.addEventListener('click', async () => {
      const name = button.dataset.for;
      const current = readTraitField(root, name);
      const result = await openTraitPickerDialog({ title: button.dataset.title, traits, selected: current });
      if (!result || result === 'cancel') return;
      root.querySelector(`input[type="hidden"][name="${name}"]`).value = result.join(',');
      root.querySelector(`.dommt-trait-field__summary[data-for="${name}"]`).textContent = summaryText(result);
    });
  });
}
