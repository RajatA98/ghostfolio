// apps/api/src/app/agent/agent.config.ts
// Centralized configuration for the Ghostfolio Portfolio Analysis Agent (MVP)
//
// Uses getters so environment variables are read at access time (not module load time).
// This allows tests to modify process.env and have changes take effect.

export const agentConfig = {
  get defaultAccountId(): string {
    return process.env.AGENT_DEFAULT_ACCOUNT_ID || '';
  },

  get enableExternalMarketData(): boolean {
    return process.env.AGENT_ENABLE_MARKET === 'true';
  },

  get valuationFallback(): 'cost_basis' | 'error' {
    return (process.env.AGENT_VALUATION_FALLBACK || 'cost_basis') as
      | 'cost_basis'
      | 'error';
  },

  get defaultLookbackDays(): number {
    return Number(process.env.AGENT_DEFAULT_LOOKBACK_DAYS || 30);
  },

  get allowEducationalGuidance(): boolean {
    return process.env.AGENT_ALLOW_EDU === 'true' || true;
  },

  get anthropicApiKey(): string {
    return process.env.ANTHROPIC_API_KEY || '';
  },

  get anthropicModel(): string {
    return process.env.AGENT_MODEL || 'claude-sonnet-4-20250514';
  },

  get maxTokens(): number {
    return Number(process.env.AGENT_MAX_TOKENS || 4096);
  },

  get temperature(): number {
    return Number(process.env.AGENT_TEMPERATURE || 0.2);
  }
};
