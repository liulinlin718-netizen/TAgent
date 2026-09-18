export interface ModelConnectionPreview {
  id: string;
  token: string;
  expiresAt: number;
  provider: string;
  model: string;
  endpoint: string;
  prompt: string;
  maxModelCalls: 1;
  maxOutputTokens: 64;
  timeoutMs: number;
  estimatedCost: number | null;
  requiresConfirmation: true;
  willWrite: false;
  willExecute: false;
}

export interface ModelConnectionCheck {
  id: string;
  provider: string;
  model: string;
  endpoint: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
  startedAt: number;
  completedAt?: number;
  tokens: { input: number; output: number } | null;
  estimatedCost: number | null;
  unsettled: boolean;
  error?: string;
  persisted: boolean;
}

export interface ModelConnectionView {
  configured: boolean;
  provider?: string;
  model?: string;
  endpoint?: string;
  configurationError?: string;
  activeId?: string;
  retryAfterMs: number;
  checks: ModelConnectionCheck[];
}
