export type DiscoveryDomain = 'skill' | 'mcp';

export type DiscoveryProviderKind =
  | 'local'
  | 'curated'
  | 'github-repo'
  | 'github-code'
  | 'npm'
  | 'mcp-registry'
  | 'mcp-reference'
  | 'url';

export type DiscoveryProviderState = 'ok' | 'failed' | 'disabled' | 'unknown';

export interface DiscoveryProviderStatus {
  id: string;
  name: string;
  kind: DiscoveryProviderKind;
  domains: DiscoveryDomain[];
  state: DiscoveryProviderState;
  requiresNetwork: boolean;
  supportsImportPreview: boolean;
  targetUrl?: string;
  lastCheckedAt?: number;
  lastError?: string;
  errorCode?: string;
  retryAt?: number;
  cache?: 'network' | 'memory' | 'revalidated';
  note?: string;
}

export interface DiscoverySearchResult {
  source: string;
  providerId: string;
  name: string;
  description?: string;
  url?: string;
  id?: string;
  category?: string;
  riskLevel?: 'low' | 'medium' | 'high';
  stars?: number;
  updatedAt?: string;
  packageName?: string;
  version?: string;
  type?: string;
  evidence?: string;
}

export interface DiscoverySearchResponse {
  query: string;
  domain: DiscoveryDomain;
  candidates: DiscoverySearchResult[];
  errors: string[];
  providers: Record<string, DiscoveryProviderState>;
  providerStatuses: DiscoveryProviderStatus[];
  note: string;
}
