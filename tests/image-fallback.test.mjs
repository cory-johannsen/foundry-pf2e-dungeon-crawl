import { describe, it, expect } from 'vitest';
import {
  DEFAULT_OPENROUTER_MODELS,
  openrouterModels,
  runFallbackChain
} from '../tools/image-fallback.mjs';

describe('openrouterModels', () => {
  it('defaults to cheapest first: muse, then flux klein, with krea turbo last', () => {
    expect(openrouterModels({ env: {} })).toEqual([
      'meta/muse-image',
      'black-forest-labs/flux.2-klein-4b',
      'krea/krea-2-medium-turbo'
    ]);
    expect(DEFAULT_OPENROUTER_MODELS).toHaveLength(3);
  });

  it('prefers --model, then OPENROUTER_IMAGE_MODELS, then the legacy single var', () => {
    const env = { OPENROUTER_IMAGE_MODELS: 'a/x, b/y', OPENROUTER_IMAGE_MODEL: 'c/z' };
    expect(openrouterModels({ override: 'q/1', env })).toEqual(['q/1']);
    expect(openrouterModels({ env })).toEqual(['a/x', 'b/y']);
    expect(openrouterModels({ env: { OPENROUTER_IMAGE_MODEL: 'c/z' } })).toEqual(['c/z']);
  });

  it('falls back to the default list when the override is blank', () => {
    expect(openrouterModels({ override: ' , ', env: {} })).toEqual(DEFAULT_OPENROUTER_MODELS);
  });
});

describe('runFallbackChain', () => {
  it('returns the first model that succeeds and does not call the rest', async () => {
    const calls = [];
    const out = await runFallbackChain(['a', 'b', 'c'], async (m) => {
      calls.push(m);
      return `img-${m}`;
    });
    expect(out.model).toBe('a');
    expect(out.result).toBe('img-a');
    expect(calls).toEqual(['a']);
  });

  it('moves to the next model when one fails, as with a provider content filter', async () => {
    const failed = [];
    const out = await runFallbackChain(
      ['muse', 'flux', 'krea'],
      async (m) => {
        if (m === 'muse') throw new Error('request failed: 400 content policy');
        return `img-${m}`;
      },
      (m) => failed.push(m)
    );
    expect(out.model).toBe('flux');
    expect(failed).toEqual(['muse']);
    expect(out.errors).toHaveLength(1);
  });

  it('throws one error naming every model when all of them fail', async () => {
    await expect(
      runFallbackChain(['a', 'b'], async (m) => {
        throw new Error(`boom ${m}`);
      })
    ).rejects.toThrow(/all models failed.*a: boom a.*b: boom b/);
  });

  it('aborts immediately on a fatal error instead of trying the next model', async () => {
    const calls = [];
    const fatal = Object.assign(new Error('no key'), { fatal: true });
    await expect(
      runFallbackChain(['a', 'b'], async (m) => {
        calls.push(m);
        throw fatal;
      })
    ).rejects.toThrow('no key');
    expect(calls).toEqual(['a']);
  });
});
