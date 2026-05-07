export interface SupervisorRepoUnderstandingData {
  project_purpose: string;
  tech_stack: string[];
  key_paths: string[];
  architecture_notes: string[];
  artifact_opportunities: string[];
  test_commands: string[];
  risks: string[];
}

export interface SupervisorRepoUnderstandingSnapshot {
  repo_ref: string;
  commit_sha: string;
  summary: string;
  understanding: SupervisorRepoUnderstandingData;
  evidence_paths: string[];
  source: 'cache' | 'claude_code' | 'fallback';
}

export interface SupervisorRepoUnderstandingInput {
  repoRef: string;
  localPath: string | null;
  forceRefresh?: boolean;
  cacheOnly?: boolean;
}

export interface SupervisorRepoUnderstandingService {
  understand(input: SupervisorRepoUnderstandingInput): Promise<SupervisorRepoUnderstandingSnapshot>;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item) => normalizeString(item))
    .filter(Boolean)
    .slice(0, 12);
}

export function normalizeRepoUnderstandingRecord(
  record: Record<string, unknown>,
): Pick<SupervisorRepoUnderstandingSnapshot, 'summary' | 'understanding' | 'evidence_paths'> {
  const summary = normalizeString(record.summary) || 'Repository understanding is available, but the summary was sparse.';
  const projectPurpose = normalizeString(record.project_purpose) || summary;

  return {
    summary,
    understanding: {
      project_purpose: projectPurpose,
      tech_stack: normalizeStringArray(record.tech_stack),
      key_paths: normalizeStringArray(record.key_paths),
      architecture_notes: normalizeStringArray(record.architecture_notes),
      artifact_opportunities: normalizeStringArray(record.artifact_opportunities),
      test_commands: normalizeStringArray(record.test_commands),
      risks: normalizeStringArray(record.risks),
    },
    evidence_paths: normalizeStringArray(record.evidence_paths),
  };
}
