import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

let mockedEnvFileContent = '';
vi.mock('node:fs', () => ({
  readFileSync: () => {
    if (!mockedEnvFileContent) throw new Error('ENOENT: no such file');
    return mockedEnvFileContent;
  }
}));

const { resolveProvider } = await import('../tools/agent-service/providers/index.mjs');

describe('resolveProvider', () => {
  const originalProvider = process.env.PF2EDC_AGENT_PROVIDER;

  beforeEach(() => {
    delete process.env.PF2EDC_AGENT_PROVIDER;
    mockedEnvFileContent = '';
  });

  afterEach(() => {
    if (originalProvider === undefined) delete process.env.PF2EDC_AGENT_PROVIDER;
    else process.env.PF2EDC_AGENT_PROVIDER = originalProvider;
  });

  it('defaults to litellm when nothing is configured', async () => {
    const { decide: decideLitellm } = await import('../tools/agent-service/providers/litellm.mjs');
    expect(resolveProvider()).toBe(decideLitellm);
  });

  it('picks the provider named by an explicit argument, ignoring env entirely', async () => {
    const { decide: decideLaya } = await import('../tools/agent-service/providers/laya.mjs');
    expect(resolveProvider('laya')).toBe(decideLaya);
  });

  it('reads PF2EDC_AGENT_PROVIDER from .env when it is not a real shell environment variable', async () => {
    mockedEnvFileContent = 'PF2EDC_AGENT_PROVIDER=laya\n';
    const { decide: decideLaya } = await import('../tools/agent-service/providers/laya.mjs');
    expect(resolveProvider()).toBe(decideLaya);
  });

  it('a real shell environment variable still works and is not shadowed by .env', async () => {
    process.env.PF2EDC_AGENT_PROVIDER = 'laya';
    mockedEnvFileContent = 'PF2EDC_AGENT_PROVIDER=litellm\n';
    const { decide: decideLaya } = await import('../tools/agent-service/providers/laya.mjs');
    expect(resolveProvider()).toBe(decideLaya);
  });

  it('throws a helpful error for an unknown provider name', () => {
    expect(() => resolveProvider('not-a-real-provider')).toThrow(/Unknown PF2EDC_AGENT_PROVIDER/);
  });
});
