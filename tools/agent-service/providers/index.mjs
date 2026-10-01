import { readEnvOrDotenv } from '../env.mjs';
import { decide as decideLitellm } from './litellm.mjs';
import { decide as decideLaya } from './laya.mjs';
import { decide as decideOpenrouter } from './openrouter-decisions.mjs';

const PROVIDERS = { litellm: decideLitellm, laya: decideLaya, openrouter: decideOpenrouter };

/** Picks the decide() function named by PF2EDC_AGENT_PROVIDER — a real shell
 * env var if set, otherwise a `.env` entry, defaulting to "litellm". */
export function resolveProvider(name = readEnvOrDotenv('PF2EDC_AGENT_PROVIDER') ?? 'litellm') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown PF2EDC_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
