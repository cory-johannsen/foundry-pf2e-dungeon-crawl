import { readEnvOrDotenv } from '../env.mjs';
import { decide as decideLitellm } from './litellm.mjs';
import { decide as decideLaya } from './laya.mjs';
import { decide as decideOpenrouter } from './openrouter-decisions.mjs';

const PROVIDERS = { litellm: decideLitellm, laya: decideLaya, openrouter: decideOpenrouter };

/** Picks the decide() function named by PF2EDC_AGENT_PROVIDER — a real shell
 * env var if set, otherwise a `.env` entry, defaulting to "litellm". */
export function resolveProvider(name = resolveProviderName()) {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(unknownProviderMessage(name));
  return provider;
}

/** #952: the validated name resolveProvider() would pick (same env/.env
 * lookup, same default, same error) -- server.mjs reports it as the
 * decision's `meta.provider`. A sibling rather than a change to
 * resolveProvider's return shape, which validate-decision-model.mjs and the
 * server already depend on. */
export function resolveProviderName(name = readEnvOrDotenv('PF2EDC_AGENT_PROVIDER') ?? 'litellm') {
  if (!Object.hasOwn(PROVIDERS, name)) throw new Error(unknownProviderMessage(name));
  return name;
}

function unknownProviderMessage(name) {
  return `Unknown PF2EDC_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`;
}
