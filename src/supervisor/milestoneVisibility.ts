export interface SupervisorMilestoneVisibilityInput {
  kind?: string | null;
  key?: string | null;
  summary?: string | null;
  delivery_code?: string | null;
  deliveryCode?: string | null;
}

export function isInternalSupervisorTurnBudgetFailure(
  milestone: SupervisorMilestoneVisibilityInput | null | undefined,
): boolean {
  if (!milestone || milestone.kind !== 'delivery_failed') {
    return false;
  }
  const haystack = [
    milestone.key,
    milestone.summary,
    milestone.delivery_code,
    milestone.deliveryCode,
  ].filter(Boolean).join('\n');
  return /supervisor_turn_budget_exhausted|turn_budget_exhausted/i.test(haystack);
}
