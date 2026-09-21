import { describe, it, expect } from 'vitest';
import { traitOptionsHtml, traitFieldHtml } from '../scripts/trait-picker.mjs';

describe('traitOptionsHtml', () => {
  it('renders one option per trait', () => {
    const html = traitOptionsHtml(['undead', 'goblin']);
    expect(html).toBe('<option value="undead">undead</option><option value="goblin">goblin</option>');
  });

  it('marks selected traits, and only those', () => {
    const html = traitOptionsHtml(['undead', 'goblin', 'fiend'], ['goblin']);
    expect(html).toContain('<option value="goblin" selected>goblin</option>');
    expect(html).toContain('<option value="undead">undead</option>');
    expect(html).toContain('<option value="fiend">fiend</option>');
  });

  it('returns an empty string for no traits', () => {
    expect(traitOptionsHtml([])).toBe('');
  });
});

describe('traitFieldHtml', () => {
  it('includes the label, choose button and a hidden input with the given name', () => {
    const html = traitFieldHtml({ name: 'traits', label: 'Favor', buttonLabel: 'Choose traits…', selected: [] });
    expect(html).toContain('<label>Favor</label>');
    expect(html).toContain('data-for="traits"');
    expect(html).toContain('>Choose traits…</button>');
    expect(html).toContain('<input type="hidden" name="traits" value="" />');
  });

  it('shows a placeholder dash when nothing is selected', () => {
    const html = traitFieldHtml({ name: 'traits', label: 'Favor', buttonLabel: 'Choose', selected: [] });
    expect(html).toContain('>—</span>');
  });

  it('shows the joined selection and threads it into the hidden input', () => {
    const html = traitFieldHtml({ name: 'excludeTraits', label: 'Exclude', buttonLabel: 'Choose', selected: ['undead', 'fiend'] });
    expect(html).toContain('>undead, fiend</span>');
    expect(html).toContain('value="undead,fiend"');
  });

  it('carries the label through as the popup dialog\'s title', () => {
    const html = traitFieldHtml({ name: 'traits', label: 'Traits to favor', buttonLabel: 'Choose', selected: [] });
    expect(html).toContain('data-title="Traits to favor"');
  });
});
