import { readEnvOrDotenv } from '../foundry-client.mjs';
import { decide as decideClaude } from './claude.mjs';
import { decide as decideLaya } from './laya.mjs';

const PROVIDERS = { claude: decideClaude, laya: decideLaya };

/** Picks the decide() function named by DOMMT_AGENT_PROVIDER — a real shell
 * env var if set, otherwise a `.env` entry (same fallback every other
 * agent-loop setting uses), defaulting to "claude". Restart the poller to
 * switch providers, no runtime switching in v1. */
export function resolveProvider(name = readEnvOrDotenv('DOMMT_AGENT_PROVIDER') ?? 'claude') {
  const provider = PROVIDERS[name];
  if (!provider) throw new Error(`Unknown DOMMT_AGENT_PROVIDER "${name}" — options: ${Object.keys(PROVIDERS).join(', ')}`);
  return provider;
}
