import {
  loadRepositoryConstitution,
  loadRepositoryHarness,
} from '../contracts/repositoryContracts';
import { ShadowHarnessRepository } from '../database';
import { GovernanceMemoryService } from '../governance/repoIntelligence';
import type {
  ConstitutionStatus,
  RepositoryHarnessStatus,
  ResolvedRepositoryRoute,
} from '../types';

export interface SupervisorRepoIntelligenceSnapshot {
  repo_ref: string;
  harness_status: RepositoryHarnessStatus;
  constitution_status: ConstitutionStatus;
  decision_memory_count: number;
  related_conflict_count: number;
  related_debt_signal_count: number;
  top_conflict_summary: string | null;
  top_debt_summary: string | null;
}

export interface SupervisorRepoIntelligenceResolver {
  resolve(params: {
    projectSlug: string;
    route: ResolvedRepositoryRoute | null;
  }): Promise<SupervisorRepoIntelligenceSnapshot | null>;
}

export class DefaultSupervisorRepoIntelligenceResolver
  implements SupervisorRepoIntelligenceResolver {
  constructor(
    private readonly shadowHarnessRepository: ShadowHarnessRepository,
    private readonly governanceMemoryService: GovernanceMemoryService,
  ) {}

  async resolve(params: {
    projectSlug: string;
    route: ResolvedRepositoryRoute | null;
  }): Promise<SupervisorRepoIntelligenceSnapshot | null> {
    const route = params.route;
    if (!route) {
      return null;
    }

    let harnessStatus: RepositoryHarnessStatus = 'missing';
    let constitutionStatus: ConstitutionStatus = 'missing';

    if (route.local_path) {
      const [harness, constitution] = await Promise.all([
        loadRepositoryHarness(route.local_path),
        loadRepositoryConstitution(route.local_path),
      ]);
      harnessStatus = harness.status;
      constitutionStatus = constitution.status;
    }

    if (harnessStatus === 'missing' && this.shadowHarnessRepository.findByRepoKey(route.github_repo_full)) {
      harnessStatus = 'shadow';
    }

    const snapshot = this.governanceMemoryService.buildRepoSnapshot(route.github_repo_full);
    return {
      repo_ref: route.github_repo_full,
      harness_status: harnessStatus,
      constitution_status: constitutionStatus,
      decision_memory_count: snapshot.decision_memories.length,
      related_conflict_count: snapshot.conflict_memories.length,
      related_debt_signal_count: snapshot.debt_signals.length,
      top_conflict_summary: snapshot.conflict_memories[0]?.summary ?? null,
      top_debt_summary: snapshot.debt_signals[0]?.summary ?? null,
    };
  }
}
