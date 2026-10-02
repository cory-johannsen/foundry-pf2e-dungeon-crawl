/**
 * Fallback hierarchy for paid image APIs (#429).
 *
 * `runFallbackChain` tries each model in order and returns the first success,
 * so one provider refusing a prompt (Meta's content filter returns 400 for
 * some prompts), being down, or being out of credit does not stop the run.
 * An error marked `fatal` (missing API key, say) aborts at once — trying the
 * next model would fail the same way and just burn time.
 */

// Owner's order: cheapest first. ComfyUI is always tried before any of these.
// Measured per-image cost on OpenRouter: Muse $0.01, Flux klein $0.014, Krea
// $0.015. Muse is first even though Meta's content filter rejects some
// prompts — a rejection just falls through to Flux, and Krea only runs if
// Flux cannot produce the image.
export const DEFAULT_OPENROUTER_MODELS = [
  'meta/muse-image',
  'black-forest-labs/flux.2-klein-4b',
  'krea/krea-2-medium-turbo'
];

/**
 * Model order for this run. Precedence: `--model=a,b` on the command line,
 * then OPENROUTER_IMAGE_MODELS (comma list), then the legacy single
 * OPENROUTER_IMAGE_MODEL, then the default hierarchy.
 */
export function openrouterModels({ override = null, env = process.env } = {}) {
  const raw = override ?? env.OPENROUTER_IMAGE_MODELS ?? env.OPENROUTER_IMAGE_MODEL ?? '';
  const list = String(raw).split(',').map((m) => m.trim()).filter(Boolean);
  return list.length ? list : [...DEFAULT_OPENROUTER_MODELS];
}

export async function runFallbackChain(models, attempt, onFail = () => {}) {
  const errors = [];
  for (const model of models) {
    try {
      const result = await attempt(model);
      return { model, result, errors };
    } catch (err) {
      if (err?.fatal) throw err;
      errors.push({ model, message: String(err?.message ?? err) });
      onFail(model, err);
    }
  }
  const summary = errors.map((e) => `${e.model}: ${e.message.slice(0, 140)}`).join(' | ');
  const err = new Error(`all models failed (${summary})`);
  err.errors = errors;
  throw err;
}
