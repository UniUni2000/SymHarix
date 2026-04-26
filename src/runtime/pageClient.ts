export const runtimePageClient = `
  const state = {
    manifest: null,
    overview: null,
    selectedIssueId: null,
    selectedIssue: null,
    historyView: null,
    timeline: [],
    runtimeToken: window.localStorage.getItem('symphony.runtime.writeToken') || '',
    filter: '',
    pending: {
      create: false,
      actionIssueId: null,
      actionSuggestionId: null,
      action: null,
    },
    panels: {
      accessOpen: false,
      createOpen: false,
    },
    stream: null,
  };

  const connectionBadge = document.getElementById('connection-badge');
  const accessBadge = document.getElementById('access-badge');
  const statusSummary = document.getElementById('status-summary');
  const metricNeedsDecision = document.getElementById('metric-needs-decision');
  const metricRunning = document.getElementById('metric-running');
  const metricFailed = document.getElementById('metric-failed');
  const queueList = document.getElementById('queue-list');
  const focusCard = document.getElementById('focus-card');
  const timelineList = document.getElementById('timeline-list');
  const historyList = document.getElementById('history-list');
  const historyCaption = document.getElementById('history-caption');
  const timelineCaption = document.getElementById('timeline-caption');
  const inspectorContent = document.getElementById('inspector-content');
  const flashMessage = document.getElementById('flash-message');
  const accessCopy = document.getElementById('access-copy');
  const runtimeTokenInput = document.getElementById('runtime-token-input');
  const clearTokenButton = document.getElementById('clear-token-button');
  const accessForm = document.getElementById('access-form');
  const createForm = document.getElementById('create-form');
  const createButton = document.getElementById('create-button');
  const filterInput = document.getElementById('filter-input');
  const refreshButton = document.getElementById('refresh-button');
  const openAccessButton = document.getElementById('open-access-button');
  const openCreateButton = document.getElementById('open-create-button');
  const accessDrawer = document.getElementById('access-drawer');
  const createDrawer = document.getElementById('create-drawer');
  runtimeTokenInput.value = state.runtimeToken;

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) {
      return 'n/a';
    }
    const value = new Date(iso);
    if (Number.isNaN(value.getTime())) {
      return 'n/a';
    }
    return value.toLocaleString();
  }

  function formatBadge(label, tone) {
    return '<span class="badge ' + escapeHtml(tone || 'neutral') + '">' + escapeHtml(label) + '</span>';
  }

  function setFlash(message) {
    flashMessage.textContent = message || '';
    if (!message) {
      return;
    }
    window.clearTimeout(setFlash.timer);
    setFlash.timer = window.setTimeout(() => {
      flashMessage.textContent = '';
    }, 4500);
  }

  function buildRuntimeHeaders(inputHeaders) {
    const headers = new Headers(inputHeaders || {});
    if (state.runtimeToken) {
      headers.set('x-symphony-runtime-token', state.runtimeToken);
    }
    return headers;
  }

  async function fetchJson(url, options) {
    const response = await fetch(url, {
      ...(options || {}),
      headers: buildRuntimeHeaders(options && options.headers),
    });
    const payload = await response.json();
    if (!response.ok || !payload.success) {
      throw new Error(payload.error || payload.message || 'Request failed');
    }
    return payload.data;
  }

  function normalizeText(value) {
    return String(value || '').trim();
  }

  function stripBoilerplate(value) {
    const text = normalizeText(value);
    if (!text) {
      return '';
    }
    return text
      .split(/\\n+/)
      .map((line) => line.trim())
      .filter((line) => line && !/^No \\.symphony-(constitution|repo)\\./i.test(line))
      .join(' ');
  }

  function getIssues() {
    return state.overview && Array.isArray(state.overview.issues) ? state.overview.issues : [];
  }

  function isRunningIssue(issue) {
    return Boolean(issue && (issue.session || issue.orchestrator_state === 'dev_running' || issue.orchestrator_state === 'review_running'));
  }

  function buildEvidenceSummary(issue) {
    const evidence = issue && issue.evidence_summary ? issue.evidence_summary : null;
    if (!evidence) {
      return 'No evidence summary yet.';
    }
    const missing = issue && Array.isArray(issue.missing_requirements) && issue.missing_requirements.length
      ? issue.missing_requirements.map((item) => item.label).join(' · ')
      : 'none';
    return String(evidence.satisfied) + '/' + String(evidence.total_requirements) + ' requirements satisfied · missing ' + missing;
  }

  function buildArchitectureSummary(issue) {
    if (!issue) {
      return 'No architecture summary yet.';
    }
    if (issue.architectural_target) {
      return 'Current target: ' + issue.architectural_target;
    }
    if (Array.isArray(issue.boundary_edges) && issue.boundary_edges.length) {
      return 'Crossing ' + issue.boundary_edges.join(', ');
    }
    if (Array.isArray(issue.path_families) && issue.path_families.length) {
      return 'Working in ' + issue.path_families.slice(0, 2).join(', ');
    }
    return 'No architecture summary yet.';
  }

  function buildDeliverySummary(issue) {
    if (!issue) {
      return 'No delivery summary yet.';
    }
    if (issue.delivery_summary) {
      return issue.delivery_summary;
    }
    const code = issue.delivery_code;
    if (code === 'review_submit_failed') {
      return 'Proof is ready, but review submission failed at the final delivery step.';
    }
    if (code === 'dirty_workspace_no_commit') {
      return 'The run ended with a dirty workspace and no clean commit to ship.';
    }
    if (code === 'tracker_state_conflict') {
      return 'Delivery is blocked by tracker state reconciliation instead of coding work.';
    }
    if (code === 'no_actionable_diff') {
      return 'No new actionable diff remained, so this item may close as a no-op.';
    }
    return 'No delivery summary yet.';
  }

  function getQueuedChildIdentifiers(issue) {
    if (!issue) {
      return [];
    }
    if (Array.isArray(issue.governance_queued_child_identifiers) && issue.governance_queued_child_identifiers.length) {
      return issue.governance_queued_child_identifiers.filter(Boolean);
    }
    const queue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue : [];
    return queue
      .filter((item) => item && item.queue_state === 'queued' && item.issue_identifier)
      .map((item) => item.issue_identifier);
  }

  function buildQueuedChildSummary(issue) {
    const identifiers = getQueuedChildIdentifiers(issue);
    if (!identifiers.length) {
      return 'No queued children right now.';
    }
    return identifiers.join(' · ');
  }

  function buildSupervisorSessionSummary(issue) {
    if (!issue) {
      return 'No supervisor session is linked yet.';
    }
    if (issue.supervisor_plan_summary) {
      return issue.supervisor_plan_summary;
    }
    if (issue.supervisor_session_state) {
      return 'Supervisor session state: ' + issue.supervisor_session_state + '.';
    }
    return 'No supervisor plan summary yet.';
  }

  function getCurrentChild(issue) {
    if (!issue) {
      return null;
    }
    if (issue.governance_current_child) {
      return issue.governance_current_child;
    }
    const queue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue : [];
    return queue.find((item) => item.queue_state === 'current') || queue[0] || null;
  }

  function buildGovernanceReason(issue) {
    if (!issue) {
      return 'No governance reason yet.';
    }
    const summary = stripBoilerplate(issue.governance_summary);
    if (summary) {
      return summary;
    }
    if (Array.isArray(issue.active_governance_suggestions) && issue.active_governance_suggestions.length) {
      return issue.active_governance_suggestions[0].summary || issue.active_governance_suggestions[0].title;
    }
    return 'No governance reason yet.';
  }

  function buildRecommendation(issue) {
    if (!issue) {
      return {
        label: 'Refresh issue',
        action: 'refresh',
        tone: 'secondary',
        kind: 'remote',
      };
    }

    const suggestions = Array.isArray(issue.active_governance_suggestions)
      ? issue.active_governance_suggestions.filter((item) => item.can_execute)
      : [];
    if (suggestions.length) {
      return {
        label: 'Execute suggestion',
        action: 'execute_suggestion',
        suggestionId: suggestions[0].id,
        tone: 'primary',
        kind: 'remote',
      };
    }

    if (issue.governance_thread_state === 'waiting_on_child' || issue.governance_thread_state === 'child_failed') {
      const currentChild = getCurrentChild(issue);
      if (currentChild) {
        return {
          label: 'Inspect ' + currentChild.issue_identifier,
          action: 'select_child',
          childIssueId: currentChild.issue_id,
          tone: 'primary',
          kind: 'local',
        };
      }
    }

    if (issue.governance_status === 'blocked' || issue.governance_thread_state === 'blocked') {
      if (issue.actions && issue.actions.can_split_governance) {
        return {
          label: 'Split scope',
          action: 'split',
          tone: 'primary',
          kind: 'remote',
        };
      }
      if (issue.actions && issue.actions.can_rewrite_governance) {
        return {
          label: 'Rewrite brief',
          action: 'rewrite',
          tone: 'primary',
          kind: 'remote',
        };
      }
    }

    if (issue.delivery_state === 'delivery_failed' || issue.delivery_code) {
      if (issue.actions && issue.actions.can_retry) {
        return {
          label: 'Retry delivery',
          action: 'retry',
          tone: 'primary',
          kind: 'remote',
        };
      }
    }

    const orchestratorState = normalizeText(issue.orchestrator_state).toLowerCase();
    if ((orchestratorState.includes('retry') || orchestratorState.includes('failed')) && issue.actions && issue.actions.can_retry) {
      return {
        label: 'Retry now',
        action: 'retry',
        tone: 'primary',
        kind: 'remote',
      };
    }

    return {
      label: 'Refresh issue',
      action: 'refresh',
      tone: 'secondary',
      kind: 'remote',
    };
  }

  function buildSecondaryActions(issue, model, recommendation) {
    const actions = [];
    if (!issue) {
      return actions;
    }

    function pushRemote(action, label, tone, disabled) {
      if (disabled) {
        return;
      }
      if (recommendation && recommendation.kind === 'remote' && recommendation.action === action) {
        return;
      }
      actions.push({ action, label, tone: tone || 'secondary', kind: 'remote' });
    }

    if (issue.actions && issue.actions.can_stop) {
      pushRemote('stop', 'Stop', 'warn', false);
    }
    if (issue.actions && issue.actions.can_retry) {
      pushRemote('retry', 'Retry', 'secondary', false);
    }
    if (issue.actions && issue.actions.can_rewrite_governance) {
      pushRemote('rewrite', 'Rewrite gate', 'secondary', false);
    }
    if (issue.actions && issue.actions.can_split_governance) {
      pushRemote('split', 'Split gate', 'secondary', false);
    }
    if (issue.actions && issue.actions.can_override_governance) {
      pushRemote('override', 'Danger: override gate', 'danger', false);
    }
    if (Array.isArray(issue.active_governance_suggestions)) {
      issue.active_governance_suggestions
        .filter((item) => item.can_dismiss)
        .slice(0, 1)
        .forEach((item) => {
          actions.push({
            action: 'dismiss_suggestion',
            suggestionId: item.id,
            label: 'Dismiss suggestion',
            tone: 'secondary',
            kind: 'remote',
          });
        });
    }

    if (model.kind !== 'running') {
      actions.push({
        action: 'refresh',
        label: 'Refresh issue',
        tone: 'secondary',
        kind: 'remote',
      });
    }

    return actions;
  }

  function buildIssueModel(issue) {
    const currentChild = getCurrentChild(issue);
    const orchestratorState = normalizeText(issue && issue.orchestrator_state).toLowerCase();
    const governanceBlocked = issue && (issue.governance_status === 'blocked' || issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming' || issue.governance_thread_state === 'executing');
    if (governanceBlocked) {
      return {
        kind: 'needs_decision',
        priority: 0,
        queueTone: 'danger',
        focusTone: 'needs_decision',
        statusLabel: 'Needs decision',
        headline: issue.identifier + ' is waiting for your decision',
        summary: 'This issue is paused at governance. Decide the next step before the system continues.',
        reason: buildGovernanceReason(issue),
        recommendationLabel: 'Recommended next step',
        recommendationText: buildRecommendation(issue).label,
        supportingLabel: 'Why it is blocked',
        supportingText: buildGovernanceReason(issue),
      };
    }

    if (issue && (issue.governance_thread_state === 'waiting_on_child' || issue.governance_thread_state === 'child_failed')) {
      const pauseReason = issue.governance_pause_reason
        || (currentChild
          ? currentChild.issue_identifier + ' is the current child. Remaining children stay queued until it finishes.'
          : 'The root thread is waiting on child work before it can continue.');
      const handoffSummary = issue.governance_expected_handoff
        || (currentChild && currentChild.governance_summary
          ? currentChild.governance_summary
          : 'Once the current child reaches a terminal state, the next child can take over automatically.');
      return {
        kind: 'waiting_on_child',
        priority: issue.governance_thread_state === 'child_failed' ? 1 : 2,
        queueTone: 'warn',
        focusTone: 'delivery_failed',
        statusLabel: issue.governance_thread_state === 'child_failed' ? 'Child failed' : 'Waiting on child',
        headline: issue.identifier + ' is paused while ' + (currentChild ? currentChild.issue_identifier : 'a child issue') + ' moves first',
        summary: issue.governance_thread_state === 'child_failed'
          ? 'The root thread is paused on a child delivery problem and needs attention before the queue can continue.'
          : 'The root thread stays paused while the current child handles the next concrete slice of work.',
        reason: pauseReason,
        recommendationLabel: 'Current child',
        recommendationText: currentChild ? currentChild.issue_identifier + ' · ' + currentChild.title : 'Inspect child queue',
        supportingLabel: 'Next handoff',
        supportingText: handoffSummary,
      };
    }

    if (issue && (issue.delivery_state === 'delivery_failed' || issue.delivery_code)) {
      return {
        kind: 'delivery_failed',
        priority: 1,
        queueTone: 'warn',
        focusTone: 'delivery_failed',
        statusLabel: 'Delivery failed',
        headline: issue.identifier + ' has proof, but the final delivery is still blocked',
        summary: 'The coding work progressed far enough to produce evidence, but the last shipping step needs attention.',
        reason: buildDeliverySummary(issue),
        recommendationLabel: 'Delivery risk',
        recommendationText: issue.delivery_code || 'delivery_failed',
        supportingLabel: 'Proof status',
        supportingText: buildEvidenceSummary(issue),
      };
    }

    if (issue && (orchestratorState.includes('retry') || orchestratorState.includes('failed'))) {
      return {
        kind: 'retrying_or_unstable',
        priority: 3,
        queueTone: 'warn',
        focusTone: 'delivery_failed',
        statusLabel: orchestratorState.includes('failed') ? 'Failed' : 'Retrying',
        headline: issue.identifier + ' is unstable, and the system is watching the next high-signal change',
        summary: 'You do not need every phase twitch. This surface only keeps the meaningful recovery signal.',
        reason: buildDeliverySummary(issue),
        recommendationLabel: 'Current posture',
        recommendationText: orchestratorState.includes('failed') ? 'Needs intervention or explicit retry' : 'Recovering automatically',
        supportingLabel: 'Most useful next step',
        supportingText: issue.actions && issue.actions.can_retry
          ? 'Retry is available if you want to intervene now.'
          : 'Keep watching for the next high-signal outcome.',
      };
    }

    return {
      kind: 'running',
      priority: 4,
      queueTone: 'accent',
      focusTone: 'running',
      statusLabel: 'Running',
      headline: issue.identifier + ' is moving forward and does not need intervention right now',
      summary: 'This issue is currently progressing. The deck keeps the important signals visible without crowding the page.',
      reason: state.historyView && state.historyView.digest ? state.historyView.digest.detail : 'The selected issue is active.',
      recommendationLabel: 'Current phase',
      recommendationText: issue.phase + ' · ' + issue.tracker_state,
      supportingLabel: 'Latest signal',
      supportingText: issue.session && issue.session.last_message
        ? issue.session.last_message
        : 'No recent live message is available yet.',
    };
  }

  function getIssuePriority(issue) {
    return buildIssueModel(issue).priority;
  }

  function getSortedIssues() {
    return getIssues()
      .slice()
      .sort((left, right) => {
        const priorityDiff = getIssuePriority(left) - getIssuePriority(right);
        if (priorityDiff !== 0) {
          return priorityDiff;
        }
        const leftTime = new Date(left.updated_at || left.created_at || 0).getTime();
        const rightTime = new Date(right.updated_at || right.created_at || 0).getTime();
        return rightTime - leftTime;
      });
  }

  function getVisibleIssues() {
    const term = normalizeText(state.filter).toLowerCase();
    const issues = getSortedIssues();
    if (!term) {
      return issues;
    }
    return issues.filter((issue) => {
      const model = buildIssueModel(issue);
      return [
        issue.identifier,
        issue.title,
        issue.tracker_state,
        issue.phase,
        issue.orchestrator_state || '',
        model.statusLabel,
        model.headline,
        model.reason,
      ].join(' ').toLowerCase().includes(term);
    });
  }

  function getDefaultIssueId() {
    const visible = getVisibleIssues();
    return visible.length ? visible[0].issue_id : null;
  }

  function reconcileSelection() {
    if (state.selectedIssueId) {
      const existing = getIssues().find((item) => item.issue_id === state.selectedIssueId);
      if (existing) {
        state.selectedIssue = existing;
      }
      if (state.selectedIssue) {
        return;
      }
    }

    const defaultIssueId = getDefaultIssueId();
    if (!defaultIssueId) {
      state.selectedIssueId = null;
      state.selectedIssue = null;
      state.historyView = null;
      state.timeline = [];
      return;
    }

    state.selectedIssueId = defaultIssueId;
    state.selectedIssue = getIssues().find((item) => item.issue_id === defaultIssueId) || null;
  }

  function isHighSignalTimelineEvent(event) {
    if (!event) {
      return false;
    }
    const code = normalizeText(event.code).toLowerCase();
    const category = normalizeText(event.category).toLowerCase();
    const message = normalizeText(event.message).toLowerCase();
    return (
      code.includes('governance')
      || code.includes('retry')
      || code.includes('failed')
      || code.includes('done')
      || code.includes('cancel')
      || code.includes('delivery')
      || code.includes('merge')
      || message.includes('blocked')
      || message.includes('retry')
      || message.includes('failed')
      || message.includes('done')
      || message.includes('delivery')
      || message.includes('waiting on child')
      || category === 'governance'
      || category === 'review'
      || category === 'sync'
    );
  }

  function buildOverviewSummary() {
    const issues = getIssues();
    if (!issues.length) {
      return 'No tracked issues yet. Use New Issue to start a fresh work item.';
    }
    const needsDecision = issues.filter((issue) => buildIssueModel(issue).kind === 'needs_decision').length;
    const failed = issues.filter((issue) => buildIssueModel(issue).kind === 'delivery_failed' || normalizeText(issue.orchestrator_state).toLowerCase().includes('failed')).length;
    const running = issues.filter((issue) => isRunningIssue(issue)).length;
    const topIssue = getVisibleIssues()[0];
    if (!topIssue) {
      return 'No issues match the current filter.';
    }
    const topModel = buildIssueModel(topIssue);
    return String(needsDecision) + ' waiting for a decision · ' + String(failed) + ' in delivery trouble · ' + String(running) + ' active now. Focus first: ' + topIssue.identifier + ' · ' + topModel.statusLabel + '.';
  }

  function renderTopBar() {
    const issues = getIssues();
    metricNeedsDecision.textContent = String(issues.filter((issue) => buildIssueModel(issue).kind === 'needs_decision').length);
    metricRunning.textContent = String(issues.filter((issue) => isRunningIssue(issue)).length);
    metricFailed.textContent = String(issues.filter((issue) => buildIssueModel(issue).kind === 'delivery_failed' || normalizeText(issue.orchestrator_state).toLowerCase().includes('failed')).length);
    statusSummary.textContent = buildOverviewSummary();
  }

  function renderAccess() {
    const access = state.manifest && state.manifest.access ? state.manifest.access : null;
    if (!access) {
      accessBadge.className = 'badge warn';
      accessBadge.textContent = 'Checking access';
      accessCopy.textContent = 'Loading access controls...';
      return;
    }

    accessBadge.className = 'badge ' + (access.viewer_role === 'operator' ? 'accent' : 'warn');
    accessBadge.textContent = access.viewer_role === 'operator' ? 'Operator' : 'Viewer';
    accessCopy.textContent = access.mode === 'open'
      ? 'Mutating actions are open on this runtime.'
      : access.viewer_role === 'operator'
        ? 'Write token accepted. Control actions are enabled.'
        : 'Read-only mode. Save a valid token to enable create, stop, retry, and governance actions.';
  }

  function renderQueue() {
    const issues = getVisibleIssues();
    if (!issues.length) {
      queueList.innerHTML = '<div class="empty-state">No issues match the current filter.</div>';
      return;
    }

    queueList.innerHTML = issues.map((issue) => {
      const model = buildIssueModel(issue);
      const active = issue.issue_id === state.selectedIssueId ? ' active' : '';
      return [
        '<button type="button" class="queue-card' + active + '" data-issue-id="' + escapeHtml(issue.issue_id) + '">',
        '<div class="badge-row">',
        formatBadge(model.statusLabel, model.queueTone),
        formatBadge(issue.phase, 'neutral'),
        issue.tracker_state ? formatBadge(issue.tracker_state, 'info') : '',
        '</div>',
        '<div class="queue-card-title">' + escapeHtml(issue.identifier) + ' · ' + escapeHtml(issue.title) + '</div>',
        '<p class="queue-card-copy">' + escapeHtml(model.summary) + '</p>',
        '</button>',
      ].join('');
    }).join('');

    queueList.querySelectorAll('[data-issue-id]').forEach((button) => {
      button.addEventListener('click', () => {
        const issueId = button.getAttribute('data-issue-id');
        if (issueId) {
          void selectIssue(issueId);
        }
      });
    });
  }

  function renderActionButton(action, pendingAction) {
    const isPending = pendingAction && pendingAction.action === action.action && pendingAction.suggestionId === action.suggestionId;
    const tone = action.tone || 'secondary';
    const label = isPending
      ? 'Working...'
      : action.label;
    const attrs = [
      'type="button"',
      'class="action-button ' + escapeHtml(tone) + '"',
      'data-action="' + escapeHtml(action.action) + '"',
    ];
    if (action.suggestionId) {
      attrs.push('data-suggestion-id="' + escapeHtml(action.suggestionId) + '"');
    }
    if (action.childIssueId) {
      attrs.push('data-child-issue-id="' + escapeHtml(action.childIssueId) + '"');
    }
    if (isPending) {
      attrs.push('disabled');
    }
    return '<button ' + attrs.join(' ') + '>' + escapeHtml(label) + '</button>';
  }

  function renderFocusCard() {
    const issue = state.selectedIssue;
    if (!issue) {
      focusCard.setAttribute('data-tone', 'running');
      focusCard.innerHTML = '<div class="empty-state">No issue is selected yet. Choose a queue item to inspect it here.</div>';
      return;
    }

    const model = buildIssueModel(issue);
    const recommendation = buildRecommendation(issue);
    const secondaryActions = buildSecondaryActions(issue, model, recommendation);
    const pendingAction = state.pending.actionIssueId === issue.issue_id
      ? {
          action: state.pending.action,
          suggestionId: state.pending.actionSuggestionId,
        }
      : null;
    const queuedChildSummary = buildQueuedChildSummary(issue);
    const showQueueHandoff = issue.governance_thread_state === 'waiting_on_child' || issue.governance_thread_state === 'child_failed';
    const supervisorSummary = buildSupervisorSessionSummary(issue);
    const actionButtons = [
      renderActionButton(recommendation, pendingAction),
      ...secondaryActions.map((action) => renderActionButton(action, pendingAction)),
    ].join('');

    focusCard.setAttribute('data-tone', model.focusTone);
    focusCard.innerHTML = [
      '<div class="focus-layout">',
      '<div>',
      '<div class="badge-row">',
      formatBadge(model.statusLabel, model.queueTone),
      issue.governance_status ? formatBadge('governance ' + issue.governance_status, issue.governance_status === 'blocked' ? 'danger' : 'neutral') : '',
      issue.github_repo ? formatBadge(issue.github_repo, 'info') : '',
      issue.repo_harness_status ? formatBadge('harness ' + issue.repo_harness_status.status, issue.repo_harness_status.status === 'formal' ? 'accent' : 'warn') : '',
      '</div>',
      '<h2 class="focus-headline">' + escapeHtml(model.headline) + '</h2>',
      '<p class="focus-summary">' + escapeHtml(model.summary) + '</p>',
      '<div class="focus-grid">',
      '<div class="focus-callout"><span class="focus-callout-label">' + escapeHtml(model.supportingLabel) + '</span><span class="focus-callout-value">' + escapeHtml(model.supportingText) + '</span></div>',
      '<div class="focus-callout"><span class="focus-callout-label">' + escapeHtml(model.recommendationLabel) + '</span><span class="focus-callout-value">' + escapeHtml(model.recommendationText) + '</span></div>',
      '</div>',
      '<div class="focus-actions">' + actionButtons + '</div>',
      '</div>',
      '<div class="focus-side">',
      '<div class="focus-side-card"><span class="focus-callout-label">Issue</span><span class="focus-callout-value">' + escapeHtml(issue.identifier) + '</span><p class="panel-copy">Phase ' + escapeHtml(issue.phase) + ' · tracker ' + escapeHtml(issue.tracker_state) + ' · orchestrator ' + escapeHtml(issue.orchestrator_state || 'unknown') + '</p></div>',
      issue.supervisor_session_state || issue.supervisor_plan_summary
        ? '<div class="focus-side-card"><span class="focus-callout-label">Supervisor plan</span><span class="focus-callout-value">' + escapeHtml(supervisorSummary) + '</span><p class="panel-copy">Session state: ' + escapeHtml(issue.supervisor_session_state || 'n/a') + '</p></div>'
        : '',
      '<div class="focus-side-card"><span class="focus-callout-label">Why now</span><span class="focus-callout-value">' + escapeHtml(model.reason) + '</span></div>',
      showQueueHandoff
        ? '<div class="focus-side-card"><span class="focus-callout-label">Queue handoff</span><span class="focus-callout-value">' + escapeHtml(issue.governance_expected_handoff || queuedChildSummary) + '</span><p class="panel-copy">Queued next: ' + escapeHtml(queuedChildSummary) + '</p></div>'
        : '',
      '</div>',
      '</div>',
    ].join('');

    focusCard.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => {
        const action = button.getAttribute('data-action');
        const suggestionId = button.getAttribute('data-suggestion-id');
        const childIssueId = button.getAttribute('data-child-issue-id');
        if (!action) {
          return;
        }
        if (action === 'refresh') {
          void refreshSelectedIssue();
          return;
        }
        if (action === 'select_child' && childIssueId) {
          void selectIssue(childIssueId);
          return;
        }
        if ((action === 'execute_suggestion' || action === 'dismiss_suggestion') && suggestionId) {
          void postGovernanceSuggestionAction(issue.issue_id, suggestionId, action === 'execute_suggestion' ? 'execute' : 'dismiss');
          return;
        }
        void postIssueAction(issue.issue_id, action);
      });
    });
  }

  function buildSignalItem(title, copy, badges, timestamp, rawDetail) {
    return [
      '<div class="signal-item">',
      badges && badges.length ? '<div class="badge-row">' + badges.join('') + '</div>' : '',
      '<div class="signal-item-title">' + escapeHtml(title) + '</div>',
      copy ? '<p class="signal-item-copy">' + escapeHtml(copy) + '</p>' : '',
      timestamp ? '<small>' + escapeHtml(timestamp) + '</small>' : '',
      rawDetail ? '<details><summary>Raw detail</summary><pre>' + escapeHtml(rawDetail) + '</pre></details>' : '',
      '</div>',
    ].join('');
  }

  function renderTimeline() {
    if (!state.selectedIssueId) {
      timelineCaption.textContent = 'Choose a queue item to inspect high-signal events.';
      timelineList.innerHTML = '<div class="empty-state">No selected issue yet.</div>';
      return;
    }

    const issue = state.selectedIssue;
    const events = state.timeline.filter(isHighSignalTimelineEvent);
    timelineCaption.textContent = issue
      ? 'High-signal timeline for ' + issue.identifier
      : 'High-signal timeline';
    if (!events.length) {
      timelineList.innerHTML = '<div class="empty-state">No high-signal timeline events yet for this issue.</div>';
      return;
    }

    timelineList.innerHTML = events.slice(-12).reverse().map((event) => {
      const detailText = event.detail && typeof event.detail === 'object'
        ? JSON.stringify(event.detail, null, 2)
        : null;
      const copy = stripBoilerplate(event.message) || 'Signal event';
      return buildSignalItem(
        event.message,
        event.code ? 'Code: ' + event.code : null,
        [
          formatBadge(event.category || 'timeline', 'neutral'),
          event.level === 'error' ? formatBadge('error', 'danger') : event.level === 'warn' ? formatBadge('warn', 'warn') : '',
          event.turn ? formatBadge('turn ' + event.turn, 'info') : '',
        ].filter(Boolean),
        formatDate(event.timestamp),
        detailText,
      );
    }).join('');
  }

  function renderHistory() {
    if (!state.selectedIssueId) {
      historyCaption.textContent = 'Choose a queue item to inspect replay history.';
      historyList.innerHTML = '<div class="empty-state">No selected issue yet.</div>';
      return;
    }

    const historyView = state.historyView;
    if (!historyView) {
      historyCaption.textContent = 'Loading history replay...';
      historyList.innerHTML = '<div class="empty-state">Loading replay history...</div>';
      return;
    }

    historyCaption.textContent = 'Recent replay checkpoints for ' + (historyView.issue_identifier || state.selectedIssueId);
    if (!Array.isArray(historyView.entries) || !historyView.entries.length) {
      historyList.innerHTML = '<div class="empty-state">No replay checkpoints yet for this issue.</div>';
      return;
    }

    historyList.innerHTML = historyView.entries.slice(0, 8).map((entry) => {
      return buildSignalItem(
        entry.title,
        entry.summary,
        [formatBadge(entry.source, 'info')],
        formatDate(entry.timestamp),
        entry.detail ? JSON.stringify(entry.detail, null, 2) : null,
      );
    }).join('');
  }

  function buildSummaryCard(title, copy, rawDetail) {
    return [
      '<div class="summary-card">',
      '<h3 class="summary-card-title">' + escapeHtml(title) + '</h3>',
      '<p class="summary-card-copy">' + escapeHtml(copy) + '</p>',
      rawDetail ? '<details><summary>View raw detail</summary><pre>' + escapeHtml(rawDetail) + '</pre></details>' : '',
      '</div>',
    ].join('');
  }

  function renderInspector() {
    const issue = state.selectedIssue;
    if (!issue) {
      inspectorContent.innerHTML = '<div class="empty-state">Choose a queue item to inspect evidence, governance, and architecture.</div>';
      return;
    }

    const evidence = issue.evidence_summary ? issue.evidence_summary : null;
    const suggestions = Array.isArray(issue.active_governance_suggestions) ? issue.active_governance_suggestions : [];
    const currentChild = getCurrentChild(issue);
    const childQueue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue : [];
    const governanceSummary = buildGovernanceReason(issue);
    const architectureSummary = buildArchitectureSummary(issue);
    const evidenceSummary = buildEvidenceSummary(issue);
    const deliverySummary = buildDeliverySummary(issue);
    const queuedChildSummary = buildQueuedChildSummary(issue);
    const supervisorSummary = buildSupervisorSessionSummary(issue);
    const pauseReason = issue.governance_pause_reason
      || (currentChild
        ? currentChild.issue_identifier + ' is the current child keeping the root thread paused.'
        : 'The root thread is not currently paused on a child issue.');
    const expectedHandoff = issue.governance_expected_handoff
      || (queuedChildSummary !== 'No queued children right now.'
        ? 'After the current child finishes, the queue will hand off to ' + queuedChildSummary + '.'
        : 'No queued handoff is waiting right now.');

    inspectorContent.innerHTML = [
      '<div class="insight-grid">',
      '<div class="insight-stat"><span class="insight-stat-label">Evidence</span><strong class="insight-stat-value">' + escapeHtml(evidence ? String(evidence.satisfied) + '/' + String(evidence.total_requirements) : '0/0') + '</strong></div>',
      '<div class="insight-stat"><span class="insight-stat-label">Suggestions</span><strong class="insight-stat-value">' + escapeHtml(String(suggestions.length)) + '</strong></div>',
      '<div class="insight-stat"><span class="insight-stat-label">Current child</span><strong class="insight-stat-value">' + escapeHtml(currentChild ? currentChild.issue_identifier : 'n/a') + '</strong></div>',
      '<div class="insight-stat"><span class="insight-stat-label">Delivery</span><strong class="insight-stat-value">' + escapeHtml(issue.delivery_code || issue.delivery_state || 'ok') + '</strong></div>',
      '</div>',
      '<div class="summary-stack">',
      buildSummaryCard('Supervisor plan', supervisorSummary, JSON.stringify({
        supervisor_session_state: issue.supervisor_session_state || null,
        supervisor_plan_summary: issue.supervisor_plan_summary || null,
      }, null, 2)),
      buildSummaryCard('Session state', issue.supervisor_session_state || 'n/a', JSON.stringify({
        supervisor_session_state: issue.supervisor_session_state || null,
      }, null, 2)),
      buildSummaryCard('Root-thread pause', pauseReason, JSON.stringify({
        governance_pause_reason: issue.governance_pause_reason || null,
        governance_thread_state: issue.governance_thread_state || null,
        governance_current_child: currentChild || null,
      }, null, 2)),
      buildSummaryCard('Expected handoff', expectedHandoff, JSON.stringify({
        governance_expected_handoff: issue.governance_expected_handoff || null,
        governance_queued_child_identifiers: issue.governance_queued_child_identifiers || [],
      }, null, 2)),
      buildSummaryCard('Queued children', queuedChildSummary, JSON.stringify({
        governance_queued_child_identifiers: issue.governance_queued_child_identifiers || [],
        governance_child_queue: childQueue,
      }, null, 2)),
      buildSummaryCard('Governance summary', governanceSummary, issue.governance_summary || null),
      buildSummaryCard('Evidence summary', evidenceSummary, evidence ? JSON.stringify(evidence, null, 2) : null),
      buildSummaryCard('Architecture summary', architectureSummary, JSON.stringify({
        architectural_target: issue.architectural_target || null,
        path_families: issue.path_families || [],
        boundary_edges: issue.boundary_edges || [],
        import_edges: issue.import_edges || [],
      }, null, 2)),
      buildSummaryCard('Delivery summary', deliverySummary, JSON.stringify({
        delivery_state: issue.delivery_state || null,
        delivery_code: issue.delivery_code || null,
        delivery_summary: issue.delivery_summary || null,
      }, null, 2)),
      childQueue.length
        ? buildSummaryCard(
            'Child queue',
            childQueue.map((item) => item.issue_identifier + ' · ' + (item.queue_state || 'unknown')).join(' · '),
            JSON.stringify(childQueue, null, 2),
          )
        : '',
      suggestions.length
        ? buildSummaryCard(
            'Active suggestions',
            suggestions.map((item) => item.title).join(' · '),
            JSON.stringify(suggestions, null, 2),
          )
        : '',
      '</div>',
    ].filter(Boolean).join('');
  }

  function renderCreateState() {
    const canCreate = Boolean(state.manifest && state.manifest.access && state.manifest.access.can_create_issue);
    createButton.disabled = state.pending.create || !canCreate;
    createButton.textContent = state.pending.create ? 'Creating issue...' : (canCreate ? 'Create issue' : 'Read-only');
  }

  function renderDrawers() {
    accessDrawer.classList.toggle('open', state.panels.accessOpen);
    createDrawer.classList.toggle('open', state.panels.createOpen);
    accessDrawer.setAttribute('aria-hidden', state.panels.accessOpen ? 'false' : 'true');
    createDrawer.setAttribute('aria-hidden', state.panels.createOpen ? 'false' : 'true');
  }

  function renderAll() {
    renderTopBar();
    renderAccess();
    renderQueue();
    renderCreateState();
    renderFocusCard();
    renderTimeline();
    renderHistory();
    renderInspector();
    renderDrawers();
  }

  async function loadManifest() {
    state.manifest = await fetchJson('/api/v1/runtime/manifest');
  }

  async function loadOverview() {
    state.overview = await fetchJson('/api/v1/runtime/overview');
    reconcileSelection();
  }

  async function loadIssue(issueId) {
    state.selectedIssue = await fetchJson('/api/v1/runtime/issues/' + encodeURIComponent(issueId));
    state.selectedIssueId = state.selectedIssue.issue_id;
  }

  async function loadTimeline(issueId) {
    state.timeline = await fetchJson('/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/timeline?limit=120');
  }

  async function loadHistory(issueId) {
    state.historyView = await fetchJson('/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/history?limit=20');
  }

  async function refreshSelectedIssue() {
    await Promise.all([
      loadManifest(),
      loadOverview(),
    ]);
    if (state.selectedIssueId) {
      await Promise.all([
        loadIssue(state.selectedIssueId),
        loadTimeline(state.selectedIssueId),
        loadHistory(state.selectedIssueId),
      ]);
    }
    renderAll();
  }

  async function selectIssue(issueId) {
    state.selectedIssueId = issueId;
    await Promise.all([
      loadIssue(issueId),
      loadTimeline(issueId),
      loadHistory(issueId),
    ]);
    renderAll();
  }

  async function postIssueAction(issueId, action) {
    state.pending.actionIssueId = issueId;
    state.pending.actionSuggestionId = null;
    state.pending.action = action;
    renderAll();
    try {
      const actionPath = action === 'override'
        ? '/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/governance/override'
        : action === 'rewrite'
          ? '/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/governance/rewrite'
          : action === 'split'
            ? '/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/governance/split'
            : '/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/' + action;
      const result = await fetchJson(actionPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      setFlash(result.message || (action + ' requested'));
      await refreshSelectedIssue();
    } catch (error) {
      setFlash(error.message);
    } finally {
      state.pending.actionIssueId = null;
      state.pending.actionSuggestionId = null;
      state.pending.action = null;
      renderAll();
    }
  }

  async function postGovernanceSuggestionAction(issueId, suggestionId, action) {
    state.pending.actionIssueId = issueId;
    state.pending.actionSuggestionId = suggestionId;
    state.pending.action = action === 'execute' ? 'execute_suggestion' : 'dismiss_suggestion';
    renderAll();
    try {
      const actionPath = '/api/v1/runtime/issues/' + encodeURIComponent(issueId) + '/governance/suggestions/' + encodeURIComponent(suggestionId) + '/' + action;
      const result = await fetchJson(actionPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      setFlash(result.message || (action + ' suggestion requested'));
      await refreshSelectedIssue();
    } catch (error) {
      setFlash(error.message);
    } finally {
      state.pending.actionIssueId = null;
      state.pending.actionSuggestionId = null;
      state.pending.action = null;
      renderAll();
    }
  }

  function openDrawer(kind) {
    if (kind === 'access') {
      state.panels.accessOpen = true;
    }
    if (kind === 'create') {
      state.panels.createOpen = true;
    }
    renderDrawers();
  }

  function closeDrawer(kind) {
    if (kind === 'access') {
      state.panels.accessOpen = false;
    }
    if (kind === 'create') {
      state.panels.createOpen = false;
    }
    renderDrawers();
  }

  function connectStream() {
    if (state.stream) {
      state.stream.close();
    }

    const source = new EventSource('/api/v1/runtime/stream');
    state.stream = source;

    source.addEventListener('open', () => {
      connectionBadge.textContent = 'Live';
      connectionBadge.className = 'badge accent';
    });

    source.addEventListener('error', () => {
      connectionBadge.textContent = 'Reconnecting';
      connectionBadge.className = 'badge warn';
    });

    source.addEventListener('snapshot', async (event) => {
      state.overview = JSON.parse(event.data);
      reconcileSelection();
      if (state.selectedIssueId) {
        await Promise.all([
          loadIssue(state.selectedIssueId),
          loadTimeline(state.selectedIssueId),
          loadHistory(state.selectedIssueId),
        ]);
      }
      renderAll();
    });

    source.addEventListener('overview', (event) => {
      state.overview = JSON.parse(event.data);
      reconcileSelection();
      renderAll();
    });

    source.addEventListener('issue', (event) => {
      const updated = JSON.parse(event.data);
      const issues = getIssues();
      const existingIndex = issues.findIndex((item) => item.issue_id === updated.issue_id);
      if (existingIndex === -1) {
        issues.unshift(updated);
      } else {
        issues.splice(existingIndex, 1, updated);
      }
      if (updated.issue_id === state.selectedIssueId) {
        state.selectedIssue = updated;
      }
      reconcileSelection();
      renderAll();
    });

    source.addEventListener('timeline', (event) => {
      const item = JSON.parse(event.data);
      if (item.issue_id !== state.selectedIssueId) {
        return;
      }
      state.timeline = state.timeline.concat([item]).slice(-120);
      renderTimeline();
    });
  }

  filterInput.addEventListener('input', (event) => {
    state.filter = String(event.target.value || '');
    if (!state.selectedIssueId) {
      reconcileSelection();
    }
    renderQueue();
    renderTopBar();
  });

  refreshButton.addEventListener('click', () => {
    void refreshSelectedIssue();
  });

  openAccessButton.addEventListener('click', () => {
    openDrawer('access');
  });

  openCreateButton.addEventListener('click', () => {
    openDrawer('create');
  });

  document.querySelectorAll('[data-close-drawer]').forEach((element) => {
    element.addEventListener('click', () => {
      const kind = element.getAttribute('data-close-drawer');
      if (kind) {
        closeDrawer(kind);
      }
    });
  });

  accessForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    state.runtimeToken = String(runtimeTokenInput.value || '').trim();
    if (state.runtimeToken) {
      window.localStorage.setItem('symphony.runtime.writeToken', state.runtimeToken);
    } else {
      window.localStorage.removeItem('symphony.runtime.writeToken');
    }
    await refreshSelectedIssue();
    if (!state.runtimeToken) {
      setFlash('Runtime token cleared. Read-only mode active.');
      return;
    }
    const role = state.manifest && state.manifest.access ? state.manifest.access.viewer_role : 'viewer';
    setFlash(role === 'operator'
      ? 'Write token accepted. Operator controls enabled.'
      : 'Token saved, but this runtime is still read-only.');
  });

  clearTokenButton.addEventListener('click', async () => {
    state.runtimeToken = '';
    runtimeTokenInput.value = '';
    window.localStorage.removeItem('symphony.runtime.writeToken');
    await refreshSelectedIssue();
    setFlash('Runtime token cleared. Read-only mode active.');
  });

  createForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const formData = new FormData(createForm);
    const payload = {
      title: String(formData.get('title') || '').trim(),
      description: String(formData.get('description') || '').trim() || null,
      team_id: String(formData.get('team_id') || '').trim() || null,
      project_slug: String(formData.get('project_slug') || '').trim() || null,
      project_id: String(formData.get('project_id') || '').trim() || null,
      state_id: String(formData.get('state_id') || '').trim() || null,
    };

    state.pending.create = true;
    renderCreateState();
    try {
      const result = await fetchJson('/api/v1/runtime/issues', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      createForm.reset();
      closeDrawer('create');
      setFlash(result.message || 'Issue created');
      await loadOverview();
      if (result.issue_id) {
        await selectIssue(result.issue_id);
      } else {
        renderAll();
      }
    } catch (error) {
      setFlash(error.message);
    } finally {
      state.pending.create = false;
      renderCreateState();
    }
  });

  Promise.all([
    loadManifest(),
    loadOverview(),
  ])
    .then(async () => {
      if (state.selectedIssueId) {
        await Promise.all([
          loadIssue(state.selectedIssueId),
          loadTimeline(state.selectedIssueId),
          loadHistory(state.selectedIssueId),
        ]);
      }
      renderAll();
      connectStream();
    })
    .catch((error) => {
      connectionBadge.textContent = 'Unavailable';
      connectionBadge.className = 'badge danger';
      setFlash(error.message);
    });
`;
