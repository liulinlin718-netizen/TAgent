export type ResearchSearchProvider = 'auto' | 'parallel';
export type ResearchSearchSelection = ResearchSearchProvider | 'invalid';

export function resolveResearchSearchProvider(value?: string): ResearchSearchSelection {
  const provider = value?.trim() || 'auto';
  return provider === 'auto' || provider === 'parallel' ? provider : 'invalid';
}

export interface SearchProviderOption {
  id: ResearchSearchProvider;
  name: string;
  recipients: string[];
  disclosure: string;
  costNotice: string;
  documentationUrl?: string;
}

export interface SearchSettingsView {
  provider: ResearchSearchSelection;
  origin: 'default' | 'saved' | 'environment';
  locked: boolean;
  revision: number;
  updatedAt?: string;
  confirmationVersion: string;
  testQuery: string;
  options: SearchProviderOption[];
}

export interface SearchProbeDiagnostic {
  source: string;
  status: 'ok' | 'empty' | 'failed';
  parsedCount: number;
  relevantCount: number;
  error?: string;
}

export interface SearchProbeResult {
  provider: ResearchSearchProvider;
  status: 'available' | 'empty' | 'failed';
  checkedAt: string;
  elapsedMs: number;
  query: string;
  diagnostics: SearchProbeDiagnostic[];
}
