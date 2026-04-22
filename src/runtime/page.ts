export function renderRuntimePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Runtime</title>
    <style>
      :root {
        --bg: #f5f1e8;
        --panel: rgba(255, 252, 246, 0.94);
        --panel-strong: rgba(255, 255, 255, 0.9);
        --ink: #1f2933;
        --muted: #6b7280;
        --line: rgba(31, 41, 51, 0.14);
        --accent: #14532d;
        --accent-soft: rgba(20, 83, 45, 0.12);
        --warn: #92400e;
        --warn-soft: rgba(146, 64, 14, 0.12);
        --danger: #991b1b;
        --danger-soft: rgba(153, 27, 27, 0.12);
        --shadow: 0 24px 70px rgba(31, 41, 51, 0.12);
      }

      * {
        box-sizing: border-box;
      }

      body {
        margin: 0;
        min-height: 100vh;
        font-family: "IBM Plex Sans", "Helvetica Neue", sans-serif;
        color: var(--ink);
        background:
          radial-gradient(circle at top left, rgba(20, 83, 45, 0.09), transparent 28%),
          radial-gradient(circle at right, rgba(146, 64, 14, 0.08), transparent 24%),
          linear-gradient(180deg, #fcfaf5, var(--bg));
      }

      .shell {
        display: grid;
        grid-template-columns: minmax(330px, 420px) minmax(460px, 1fr);
        gap: 20px;
        padding: 20px;
      }

      .panel {
        background: var(--panel);
        border: 1px solid var(--line);
        border-radius: 22px;
        box-shadow: var(--shadow);
        backdrop-filter: blur(18px);
      }

      .sidebar {
        padding: 18px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }

      .content {
        display: grid;
        grid-template-rows: auto auto 1fr;
        gap: 16px;
      }

      .content > .panel {
        padding: 18px;
      }

      h1,
      h2,
      h3,
      p {
        margin: 0;
      }

      h1 {
        font-size: 25px;
        font-weight: 700;
      }

      h2 {
        font-size: 16px;
        font-weight: 700;
      }

      h3 {
        font-size: 14px;
        font-weight: 700;
      }

      .muted {
        color: var(--muted);
      }

      .status-row,
      .stats-row,
      .issue-meta,
      .toolbar,
      .action-row,
      .detail-meta {
        display: flex;
        gap: 12px;
        align-items: center;
        flex-wrap: wrap;
      }

      .badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 10px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: 600;
        background: var(--accent-soft);
        color: var(--accent);
      }

      .badge.warn {
        background: var(--warn-soft);
        color: var(--warn);
      }

      .badge.danger {
        background: var(--danger-soft);
        color: var(--danger);
      }

      .stat {
        min-width: 92px;
        padding: 10px 12px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.75);
      }

      .stat strong {
        display: block;
        font-size: 18px;
      }

      .section-copy {
        margin-top: 6px;
        line-height: 1.5;
      }

      .toolbar {
        justify-content: space-between;
      }

      .toolbar input,
      .toolbar button {
        height: 40px;
      }

      .toolbar .grow {
        flex: 1 1 200px;
      }

      .issue-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        max-height: calc(100vh - 330px);
        overflow: auto;
      }

      .issue-card {
        width: 100%;
        padding: 14px;
        text-align: left;
        border-radius: 16px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.74);
        color: inherit;
        cursor: pointer;
        transition: transform 140ms ease, border-color 140ms ease, background 140ms ease;
      }

      .issue-card:hover,
      .issue-card.active {
        transform: translateY(-1px);
        border-color: rgba(20, 83, 45, 0.3);
        background: rgba(255, 255, 255, 0.96);
      }

      .issue-card + .issue-card {
        margin-top: 0;
      }

      .issue-card-title {
        margin-top: 10px;
        font-size: 15px;
        line-height: 1.35;
      }

      .issue-card-copy {
        margin-top: 8px;
        font-size: 13px;
        line-height: 1.5;
      }

      .detail-card,
      .timeline-card {
        min-height: 160px;
      }

      .detail-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 12px;
        margin-top: 16px;
      }

      .detail-block {
        padding: 12px;
        border-radius: 15px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.75);
      }

      .detail-list {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-top: 10px;
        font-size: 13px;
      }

      .detail-list-item {
        padding: 9px 10px;
        border-radius: 12px;
        background: rgba(20, 83, 45, 0.04);
        line-height: 1.45;
      }

      .timeline-list {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 14px;
        max-height: calc(100vh - 335px);
        overflow: auto;
      }

      .timeline-item {
        padding: 12px 14px;
        border-radius: 14px;
        border: 1px solid var(--line);
        background: rgba(255, 255, 255, 0.78);
      }

      .timeline-item-copy {
        margin-top: 8px;
        line-height: 1.45;
      }

      .timeline-item small {
        display: block;
        margin-top: 8px;
        color: var(--muted);
      }

      .empty {
        padding: 24px;
        border-radius: 16px;
        border: 1px dashed var(--line);
        color: var(--muted);
        text-align: center;
      }

      code {
        font-family: "IBM Plex Mono", "SFMono-Regular", monospace;
        font-size: 12px;
        word-break: break-word;
      }

      button,
      input,
      textarea {
        font: inherit;
      }

      button {
        border: 0;
        border-radius: 12px;
        padding: 10px 14px;
        font-weight: 600;
        cursor: pointer;
        color: white;
        background: linear-gradient(135deg, #14532d, #166534);
      }

      button.secondary {
        color: var(--ink);
        background: rgba(255, 255, 255, 0.9);
        border: 1px solid var(--line);
      }

      button.warn {
        background: linear-gradient(135deg, #b45309, #92400e);
      }

      button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }

      form {
        display: flex;
        flex-direction: column;
        gap: 10px;
        margin-top: 10px;
      }

      input,
      textarea {
        width: 100%;
        border-radius: 12px;
        border: 1px solid var(--line);
        padding: 10px 12px;
        background: rgba(255, 255, 255, 0.84);
      }

      textarea {
        min-height: 96px;
        resize: vertical;
      }

      .form-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 10px;
      }

      .meta-strong {
        color: var(--ink);
        font-weight: 600;
      }

      .topline {
        display: flex;
        justify-content: space-between;
        gap: 12px;
        align-items: flex-start;
        flex-wrap: wrap;
      }

      @media (max-width: 980px) {
        .shell {
          grid-template-columns: 1fr;
        }

        .issue-list,
        .timeline-list {
          max-height: none;
        }

        .detail-grid,
        .form-grid {
          grid-template-columns: 1fr;
        }
      }
    </style>
  </head>
  <body>
    <div class="shell">
      <aside class="panel sidebar">
        <div>
          <h1>Symphony Runtime</h1>
          <p class="muted section-copy">A small runtime console for current issue, current phase, recent tools, recent file activity, and control actions.</p>
        </div>

        <div class="status-row">
          <span id="connection-badge" class="badge">Connecting</span>
          <span id="flash-message" class="muted"></span>
        </div>

        <div id="stats-row" class="stats-row"></div>

        <section>
          <div class="toolbar">
            <h2>Access</h2>
            <span id="access-badge" class="badge warn">Checking</span>
          </div>
          <p id="access-copy" class="muted section-copy">Runtime access is loading.</p>
          <form id="access-form">
            <input id="runtime-token-input" name="runtime_token" placeholder="Optional write token" />
            <div class="form-grid">
              <button id="save-token-button" type="submit" class="secondary">Save Token</button>
              <button id="clear-token-button" type="button" class="secondary">Clear Token</button>
            </div>
          </form>
        </section>

        <section>
          <div class="toolbar">
            <h2>Issues</h2>
            <button id="refresh-button" type="button" class="secondary">Refresh</button>
          </div>
          <div class="toolbar" style="margin-top: 10px;">
            <input id="filter-input" class="grow" placeholder="Filter by key, title, state, phase" />
          </div>
          <div id="issue-list" class="issue-list" style="margin-top: 12px;"></div>
        </section>

        <section>
          <h2>Create Issue</h2>
          <p class="muted section-copy">Title is required. Team, project slug, and state are optional; if team is omitted, Symphony asks Linear for a default team.</p>
          <form id="create-form">
            <input name="title" placeholder="Issue title" required />
            <textarea name="description" placeholder="Describe the task"></textarea>
            <div class="form-grid">
              <input name="team_id" placeholder="Optional team ID" />
              <input name="project_slug" placeholder="Preferred project slug" />
            </div>
            <div class="form-grid">
              <input name="project_id" placeholder="Optional project ID (compat)" />
            </div>
            <div class="form-grid">
              <input name="state_id" placeholder="Optional state ID" />
              <button id="create-button" type="submit">Create Issue</button>
            </div>
          </form>
        </section>
      </aside>

      <main class="content">
        <section id="detail-card" class="panel detail-card">
          <div class="empty">Select an issue to inspect its live session, recent tools, and file activity.</div>
        </section>

        <section class="panel timeline-card">
          <div class="topline">
            <div>
              <h2>History Replay</h2>
              <p id="history-caption" class="muted section-copy">Recent agent runs and review decisions appear here.</p>
            </div>
          </div>
          <div id="history-list" class="timeline-list"></div>
        </section>

        <section class="panel timeline-card">
          <div class="topline">
            <div>
              <h2>Timeline</h2>
              <p id="timeline-caption" class="muted section-copy">Live timeline updates appear here.</p>
            </div>
          </div>
          <div id="timeline-list" class="timeline-list"></div>
        </section>
      </main>
    </div>

    <script>
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
          action: null,
        },
        stream: null,
      };

      const connectionBadge = document.getElementById('connection-badge');
      const accessBadge = document.getElementById('access-badge');
      const accessCopy = document.getElementById('access-copy');
      const flashMessage = document.getElementById('flash-message');
      const statsRow = document.getElementById('stats-row');
      const issueList = document.getElementById('issue-list');
      const detailCard = document.getElementById('detail-card');
      const historyList = document.getElementById('history-list');
      const historyCaption = document.getElementById('history-caption');
      const timelineList = document.getElementById('timeline-list');
      const timelineCaption = document.getElementById('timeline-caption');
      const accessForm = document.getElementById('access-form');
      const runtimeTokenInput = document.getElementById('runtime-token-input');
      const clearTokenButton = document.getElementById('clear-token-button');
      const createForm = document.getElementById('create-form');
      const createButton = document.getElementById('create-button');
      const filterInput = document.getElementById('filter-input');
      const refreshButton = document.getElementById('refresh-button');
      runtimeTokenInput.value = state.runtimeToken;

      function escapeHtml(value) {
        return String(value == null ? '' : value)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#39;');
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

      function formatBadge(label, kind) {
        return '<span class="badge ' + (kind || '') + '">' + escapeHtml(label) + '</span>';
      }

      function formatTokenSummary(issue) {
        if (!issue || !issue.session) {
          return 'No live session';
        }
        const tokens = issue.session.tokens;
        return 'in ' + tokens.input_tokens + ' / out ' + tokens.output_tokens + ' / total ' + tokens.total_tokens;
      }

      function renderAccess() {
        const access = state.manifest && state.manifest.access
          ? state.manifest.access
          : null;
        if (!access) {
          accessBadge.textContent = 'Checking';
          accessBadge.className = 'badge warn';
          accessCopy.textContent = 'Runtime access is loading.';
          return;
        }

        accessBadge.textContent = access.viewer_role === 'operator' ? 'Operator' : 'Viewer';
        accessBadge.className = access.viewer_role === 'operator' ? 'badge' : 'badge warn';
        accessCopy.textContent = access.mode === 'open'
          ? 'Mutating actions are open on this runtime.'
          : (access.viewer_role === 'operator'
            ? 'Token accepted. Create, stop, and retry actions are enabled.'
            : 'Read-only mode. Save a valid token to enable create, stop, and retry.');
      }

      function getVisibleIssues() {
        const issues = state.overview ? state.overview.issues : [];
        if (!state.filter) {
          return issues;
        }
        const term = state.filter.toLowerCase();
        return issues.filter((issue) => {
          return [
            issue.identifier,
            issue.title,
            issue.tracker_state,
            issue.phase,
            issue.orchestrator_state || '',
          ].join(' ').toLowerCase().includes(term);
        });
      }

      function getSelectedIssueFromOverview() {
        return state.overview && state.selectedIssueId
          ? state.overview.issues.find((item) => item.issue_id === state.selectedIssueId) || null
          : null;
      }

      function syncSelectedIssueFromOverview() {
        const overviewIssue = getSelectedIssueFromOverview();
        if (overviewIssue) {
          state.selectedIssue = overviewIssue;
        }
      }

      function reconcileSelection() {
        const issues = state.overview ? state.overview.issues : [];
        if (!issues.length) {
          state.selectedIssueId = null;
          state.selectedIssue = null;
          state.historyView = null;
          state.timeline = [];
          return;
        }

        if (!state.selectedIssueId || !issues.some((issue) => issue.issue_id === state.selectedIssueId)) {
          state.selectedIssueId = issues[0].issue_id;
        }

        syncSelectedIssueFromOverview();
      }

      function getCurrentActionLabel(issue) {
        if (!issue) {
          return null;
        }
        if (state.pending.actionIssueId !== issue.issue_id) {
          return null;
        }
        if (state.pending.action === 'stop') {
          return 'Stopping...';
        }
        if (state.pending.action === 'retry') {
          return 'Retrying...';
        }
        if (state.pending.action === 'override') {
          return 'Overriding...';
        }
        if (state.pending.action === 'rewrite') {
          return 'Rewriting...';
        }
        if (state.pending.action === 'split') {
          return 'Splitting...';
        }
        return 'Working...';
      }

      function renderStats() {
        const counts = state.overview ? state.overview.counts : { running: 0, retrying: 0, total: 0 };
        statsRow.innerHTML = [
          '<div class="stat"><span class="muted">Running</span><strong>' + counts.running + '</strong></div>',
          '<div class="stat"><span class="muted">Retrying</span><strong>' + counts.retrying + '</strong></div>',
          '<div class="stat"><span class="muted">Tracked</span><strong>' + counts.total + '</strong></div>',
        ].join('');
      }

      function renderIssueList() {
        const issues = getVisibleIssues();
        if (!issues.length) {
          issueList.innerHTML = '<div class="empty">No issues match the current filter.</div>';
          return;
        }

        issueList.innerHTML = issues.map((issue) => {
          const active = issue.issue_id === state.selectedIssueId ? 'active' : '';
          const liveBadge = issue.session ? formatBadge('live', '') : '';
          const retryBadge = issue.actions.can_stop && !issue.session ? formatBadge('queued', 'warn') : '';
          const prBadge = issue.actions.can_open_pr && issue.active_pr_number ? formatBadge('PR #' + issue.active_pr_number, '') : '';
          const stageBadge = issue.session && issue.session.stage ? formatBadge(issue.session.stage, '') : '';
          const harnessBadge = issue.repo_harness_status
            ? formatBadge('harness ' + issue.repo_harness_status.status, issue.repo_harness_status.status === 'formal' ? '' : 'warn')
            : '';
          const governanceBadge = issue.governance_status
            ? formatBadge('governance ' + issue.governance_status, issue.governance_status === 'blocked' ? 'danger' : issue.governance_status === 'degraded' ? 'warn' : '')
            : '';
          const missingBadge = issue.missing_requirements && issue.missing_requirements.length
            ? formatBadge(issue.missing_requirements.length + ' missing', 'warn')
            : '';
          const lastTool = issue.session && issue.session.recent_tools.length
            ? issue.session.recent_tools[issue.session.recent_tools.length - 1]
            : null;
          const lastFile = issue.session && issue.session.recent_files.length
            ? issue.session.recent_files[issue.session.recent_files.length - 1]
            : null;
          const currentAction = getCurrentActionLabel(issue);
          return [
            '<button class="issue-card ' + active + '" data-issue-id="' + escapeHtml(issue.issue_id) + '" type="button">',
            '<div class="issue-meta">',
            formatBadge(issue.phase, ''),
            formatBadge(issue.tracker_state, issue.tracker_state.toLowerCase().includes('review') ? 'warn' : ''),
            stageBadge,
            liveBadge,
            retryBadge,
            prBadge,
            harnessBadge,
            governanceBadge,
            missingBadge,
            currentAction ? formatBadge(currentAction, 'warn') : '',
            '</div>',
            '<div class="issue-card-title"><strong>' + escapeHtml(issue.identifier) + '</strong> · ' + escapeHtml(issue.title) + '</div>',
            '<div class="issue-card-copy muted">' + escapeHtml(formatTokenSummary(issue)) + '</div>',
            lastTool
              ? '<div class="issue-card-copy"><span class="meta-strong">Tool</span> · ' + escapeHtml(lastTool.tool_name + ' ' + lastTool.status) + (lastTool.summary ? '<br><code>' + escapeHtml(lastTool.summary) + '</code>' : '') + '</div>'
              : '',
            lastFile
              ? '<div class="issue-card-copy"><span class="meta-strong">File</span> · <code>' + escapeHtml(lastFile.path) + '</code></div>'
              : '',
            issue.workspace_path
              ? '<div class="issue-card-copy muted"><code>' + escapeHtml(issue.workspace_path) + '</code></div>'
              : '',
            '</button>',
          ].join('');
        }).join('');

        issueList.querySelectorAll('[data-issue-id]').forEach((button) => {
          button.addEventListener('click', () => {
            const issueId = button.getAttribute('data-issue-id');
            if (issueId) {
              void selectIssue(issueId);
            }
          });
        });
      }

      function buildDetailList(items, emptyText) {
        if (!items || !items.length) {
          return '<div class="detail-list-item muted">' + escapeHtml(emptyText) + '</div>';
        }

        return items.map((item) => item).join('');
      }

      function renderDetail() {
        const issue = state.selectedIssue || getSelectedIssueFromOverview();
        if (!issue) {
          detailCard.innerHTML = '<div class="empty">Select an issue to inspect its live session, recent tools, and file activity.</div>';
          return;
        }

        const session = issue.session;
        const digest = state.historyView ? state.historyView.digest : null;
        const actionPending = state.pending.actionIssueId === issue.issue_id;
        const hasControlAccess = Boolean(state.manifest && state.manifest.access && state.manifest.access.can_control_issues);
        const stopDisabled = !issue.actions.can_stop || actionPending || !hasControlAccess;
        const retryDisabled = !issue.actions.can_retry || actionPending || !hasControlAccess;
        const overrideDisabled = !issue.actions.can_override_governance || actionPending || !hasControlAccess;
        const rewriteDisabled = !issue.actions.can_rewrite_governance || actionPending || !hasControlAccess;
        const splitDisabled = !issue.actions.can_split_governance || actionPending || !hasControlAccess;
        const toolItems = session && session.recent_tools.length
          ? session.recent_tools.map((tool) => {
              return [
                '<div class="detail-list-item">',
                '<strong>' + escapeHtml(tool.tool_name) + '</strong> · ' + escapeHtml(tool.status),
                tool.summary ? '<br><code>' + escapeHtml(tool.summary) + '</code>' : '',
                '<br><span class="muted">' + escapeHtml(formatDate(tool.timestamp)) + '</span>',
                '</div>',
              ].join('');
            })
          : [];
        const fileItems = session && session.recent_files.length
          ? session.recent_files.map((file) => {
              return [
                '<div class="detail-list-item">',
                '<strong>' + escapeHtml(file.operation) + '</strong> · <code>' + escapeHtml(file.path) + '</code>',
                '<br><span class="muted">' + escapeHtml(file.status + ' · ' + formatDate(file.timestamp)) + '</span>',
                '</div>',
              ].join('');
            })
          : [];
        const governanceItems = buildDetailList([
          '<div class="detail-list-item">Repo harness · <strong>' + escapeHtml(issue.repo_harness_status ? issue.repo_harness_status.status : 'missing') + '</strong>' + (issue.repo_harness_status && issue.repo_harness_status.adoption_suggested ? '<br><span class="muted">formalization suggested</span>' : '') + '</div>',
          '<div class="detail-list-item">Constitution · <strong>' + escapeHtml(issue.constitution_status || 'missing') + '</strong></div>',
          '<div class="detail-list-item">Decision · <strong>' + escapeHtml(issue.governance_decision || 'n/a') + '</strong></div>',
          '<div class="detail-list-item">Status · <strong>' + escapeHtml(issue.governance_status || 'n/a') + '</strong><br><span class="muted">' + escapeHtml(issue.governance_summary || 'No governance summary yet.') + '</span></div>',
          '<div class="detail-list-item">Override · <strong>' + escapeHtml(issue.governance_override && issue.governance_override.active ? 'approved' : 'inactive') + '</strong>' + (issue.governance_override && issue.governance_override.active ? '<br><span class="muted">' + escapeHtml((issue.governance_override.reason || 'Manual operator override') + (issue.governance_override.approved_at ? ' · ' + formatDate(issue.governance_override.approved_at) : '')) + '</span>' : '') + '</div>',
        ], 'No governance assessment yet.');
        const evidenceItems = buildDetailList([
          '<div class="detail-list-item">Change pack · <strong>' + escapeHtml(issue.change_pack_summary ? ((issue.change_pack_summary.profile || 'unknown') + ' · ' + (issue.change_pack_summary.complexity || 'unknown')) : 'n/a') + '</strong></div>',
          '<div class="detail-list-item">Tasks · <strong>' + escapeHtml(issue.task_status ? (String(issue.task_status.completed) + '/' + String(issue.task_status.total)) : '0/0') + '</strong></div>',
          '<div class="detail-list-item">Evidence · <strong>' + escapeHtml(issue.evidence_summary ? (String(issue.evidence_summary.satisfied) + '/' + String(issue.evidence_summary.total_requirements)) : '0/0') + '</strong></div>',
          '<div class="detail-list-item">Missing requirements · <strong>' + escapeHtml(issue.missing_requirements ? String(issue.missing_requirements.length) : '0') + '</strong>' + (issue.missing_requirements && issue.missing_requirements.length ? '<br><span class="muted">' + escapeHtml(issue.missing_requirements.map((item) => item.label).join(' · ')) + '</span>' : '') + '</div>',
          '<div class="detail-list-item">Suggestions · <strong>' + escapeHtml(issue.active_governance_suggestions ? String(issue.active_governance_suggestions.length) : '0') + '</strong>' + (issue.active_governance_suggestions && issue.active_governance_suggestions.length ? '<br><span class="muted">' + escapeHtml(issue.active_governance_suggestions.map((item) => item.suggestion_type + ': ' + item.title).join(' · ')) + '</span>' : '') + '</div>',
        ], 'No evidence summary yet.');
        const statusMessage = getCurrentActionLabel(issue) || 'Ready';

        detailCard.innerHTML = [
          '<div class="topline">',
          '<div>',
          '<h2>' + escapeHtml(issue.identifier) + ' · ' + escapeHtml(issue.title) + '</h2>',
          '<p class="muted section-copy">Tracker: ' + escapeHtml(issue.tracker_state) + ' · Orchestrator: ' + escapeHtml(issue.orchestrator_state || 'unknown') + '</p>',
          '</div>',
          '<div class="action-row">',
          formatBadge(issue.phase, ''),
          session && session.stage ? formatBadge(session.stage, '') : '',
          formatBadge(statusMessage, actionPending ? 'warn' : ''),
          '</div>',
          '</div>',
          '<div class="detail-grid">',
          '<div class="detail-block"><h3>Summary</h3><div class="detail-list">' + buildDetailList([
            '<div class="detail-list-item"><strong>' + escapeHtml(digest ? digest.headline : 'No digest yet.') + '</strong><br><span class="muted">' + escapeHtml(digest ? digest.detail : 'Load an issue to see summary and replay context.') + '</span>' + (digest && digest.history_blurb ? '<br><span class="muted">' + escapeHtml(digest.history_blurb) + '</span>' : '') + '</div>',
          ], 'No summary yet.') + '</div></div>',
          '<div class="detail-block"><h3>Session</h3><div class="detail-list">' + buildDetailList([
            '<div class="detail-list-item">Turn count · <strong>' + escapeHtml(session ? String(session.turn_count) : '0') + '</strong></div>',
            '<div class="detail-list-item">Tokens · <strong>' + escapeHtml(session ? String(session.tokens.total_tokens) : '0') + '</strong></div>',
            '<div class="detail-list-item">Started · <strong>' + escapeHtml(session ? formatDate(session.started_at) : 'n/a') + '</strong></div>',
            '<div class="detail-list-item">Last event · <strong>' + escapeHtml(session ? formatDate(session.last_event_at) : 'n/a') + '</strong></div>',
            '<div class="detail-list-item">Session id · <code>' + escapeHtml(session && session.session_id ? session.session_id : 'n/a') + '</code></div>',
          ], 'No live session yet.') + '</div></div>',
          '<div class="detail-block"><h3>Controls</h3><div class="detail-list">' + buildDetailList([
            '<div class="detail-list-item">Branch · <code>' + escapeHtml(issue.branch_name || 'n/a') + '</code></div>',
            '<div class="detail-list-item">Workspace · <code>' + escapeHtml(issue.workspace_path || 'n/a') + '</code></div>',
            '<div class="detail-list-item">GitHub repo · <code>' + escapeHtml(issue.github_repo || 'n/a') + '</code></div>',
            '<div class="detail-list-item">GitHub issue · <strong>' + escapeHtml(issue.github_issue_number || 'n/a') + '</strong></div>',
            '<div class="detail-list-item">Active PR · <strong>' + escapeHtml(issue.active_pr_number || 'n/a') + '</strong></div>',
          ], 'No linked workspace yet.') + '<div class="action-row" style="margin-top: 12px;"><button id="stop-button" class="warn" ' + (stopDisabled ? 'disabled' : '') + '>Stop</button><button id="retry-button" class="secondary" ' + (retryDisabled ? 'disabled' : '') + '>Retry</button><button id="override-button" class="secondary" ' + (overrideDisabled ? 'disabled' : '') + '>Override Gate</button><button id="rewrite-button" class="secondary" ' + (rewriteDisabled ? 'disabled' : '') + '>Rewrite Gate</button><button id="split-button" class="secondary" ' + (splitDisabled ? 'disabled' : '') + '>Split Gate</button><button id="refresh-issue-button" class="secondary">Refresh Issue</button></div></div></div>',
          '<div class="detail-block"><h3>Governance</h3><div class="detail-list">' + governanceItems + '</div></div>',
          '<div class="detail-block"><h3>Evidence</h3><div class="detail-list">' + evidenceItems + '</div></div>',
          '<div class="detail-block"><h3>Recent Tools</h3><div class="detail-list">' + buildDetailList(toolItems, 'No recent tool events yet.') + '</div></div>',
          '<div class="detail-block"><h3>Recent Files</h3><div class="detail-list">' + buildDetailList(fileItems, 'No recent file activity yet.') + '</div></div>',
          '</div>',
        ].join('');

        document.getElementById('stop-button').addEventListener('click', () => {
          void postIssueAction(issue.issue_id, 'stop');
        });
        document.getElementById('retry-button').addEventListener('click', () => {
          void postIssueAction(issue.issue_id, 'retry');
        });
        document.getElementById('override-button').addEventListener('click', () => {
          void postIssueAction(issue.issue_id, 'override');
        });
        document.getElementById('rewrite-button').addEventListener('click', () => {
          void postIssueAction(issue.issue_id, 'rewrite');
        });
        document.getElementById('split-button').addEventListener('click', () => {
          void postIssueAction(issue.issue_id, 'split');
        });
        document.getElementById('refresh-issue-button').addEventListener('click', () => {
          void refreshSelectedIssue();
        });
      }

      function renderHistory() {
        if (!state.selectedIssueId) {
          historyCaption.textContent = 'Recent agent runs and review decisions appear here.';
          historyList.innerHTML = '<div class="empty">Choose an issue to inspect historical replay.</div>';
          return;
        }

        const historyView = state.historyView;
        if (!historyView) {
          historyCaption.textContent = 'Loading replay history...';
          historyList.innerHTML = '<div class="empty">Loading replay history...</div>';
          return;
        }

        historyCaption.textContent = 'Replay for ' + (historyView.issue_identifier || state.selectedIssueId);
        if (!historyView.entries.length) {
          historyList.innerHTML = '<div class="empty">No historical runs or review events yet for this issue.</div>';
          return;
        }

        historyList.innerHTML = historyView.entries.map((entry) => {
          return [
            '<div class="timeline-item">',
            '<div class="detail-meta">',
            formatBadge(entry.source, ''),
            '</div>',
            '<div class="timeline-item-copy"><strong>' + escapeHtml(entry.title) + '</strong></div>',
            '<div class="timeline-item-copy">' + escapeHtml(entry.summary) + '</div>',
            '<small>' + escapeHtml(formatDate(entry.timestamp)) + '</small>',
            '</div>',
          ].join('');
        }).join('');
      }

      function renderTimeline() {
        if (!state.selectedIssueId) {
          timelineCaption.textContent = 'Live timeline updates appear here.';
          timelineList.innerHTML = '<div class="empty">Choose an issue to see its timeline.</div>';
          return;
        }

        const issue = state.selectedIssue || getSelectedIssueFromOverview();
        timelineCaption.textContent = issue
          ? 'Timeline for ' + issue.identifier
          : 'Timeline for selected issue';

        if (!state.timeline.length) {
          timelineList.innerHTML = '<div class="empty">No live timeline events yet for this issue.</div>';
          return;
        }

        timelineList.innerHTML = state.timeline.map((event) => {
          const detailValue = event.detail && typeof event.detail === 'object'
            ? event.detail.summary || event.detail.path || event.detail.command_preview || event.detail.url || null
            : null;
          return [
            '<div class="timeline-item">',
            '<div class="detail-meta">',
            formatBadge(event.category, ''),
            event.level === 'warn' ? formatBadge(event.level, 'warn') : '',
            event.level === 'error' ? formatBadge(event.level, 'danger') : '',
            event.turn ? formatBadge('turn ' + event.turn, '') : '',
            event.tool_name ? formatBadge(event.tool_name, '') : '',
            '</div>',
            '<div class="timeline-item-copy"><strong>' + escapeHtml(event.message) + '</strong></div>',
            detailValue ? '<div class="timeline-item-copy"><code>' + escapeHtml(detailValue) + '</code></div>' : '',
            '<small>' + escapeHtml(formatDate(event.timestamp)) + '</small>',
            '</div>',
          ].join('');
        }).join('');
      }

      function renderCreateState() {
        const canCreate = Boolean(state.manifest && state.manifest.access && state.manifest.access.can_create_issue);
        createButton.disabled = state.pending.create || !canCreate;
        createButton.textContent = state.pending.create ? 'Creating...' : (canCreate ? 'Create Issue' : 'Read-only');
      }

      function renderAll() {
        renderAccess();
        renderStats();
        renderIssueList();
        renderCreateState();
        renderDetail();
        renderHistory();
        renderTimeline();
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
        if (!state.selectedIssueId) {
          await Promise.all([
            loadManifest(),
            loadOverview(),
          ]);
          renderAll();
          return;
        }
        await Promise.all([
          loadManifest(),
          loadOverview(),
          loadIssue(state.selectedIssueId),
          loadHistory(state.selectedIssueId),
          loadTimeline(state.selectedIssueId),
        ]);
        renderAll();
      }

      async function selectIssue(issueId) {
        state.selectedIssueId = issueId;
        await Promise.all([
          loadIssue(issueId),
          loadHistory(issueId),
          loadTimeline(issueId),
        ]);
        renderAll();
      }

      async function postIssueAction(issueId, action) {
        state.pending.actionIssueId = issueId;
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
          state.pending.action = null;
          renderAll();
        }
      }

      function upsertIssue(updated) {
        if (!state.overview) {
          return;
        }
        const existingIndex = state.overview.issues.findIndex((issue) => issue.issue_id === updated.issue_id);
        if (existingIndex === -1) {
          state.overview.issues.unshift(updated);
        } else {
          state.overview.issues.splice(existingIndex, 1, updated);
        }
        reconcileSelection();
      }

      function connectStream() {
        if (state.stream) {
          state.stream.close();
        }

        const source = new EventSource('/api/v1/runtime/stream');
        state.stream = source;

        source.addEventListener('open', () => {
          connectionBadge.textContent = 'Live';
          connectionBadge.className = 'badge';
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
              loadHistory(state.selectedIssueId),
              loadTimeline(state.selectedIssueId),
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
          upsertIssue(updated);
          if (updated.issue_id === state.selectedIssueId) {
            state.selectedIssue = updated;
            void loadHistory(updated.issue_id).then(() => {
              renderDetail();
              renderHistory();
            }).catch(() => undefined);
          }
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
        state.filter = String(event.target.value || '').trim();
        renderIssueList();
      });

      refreshButton.addEventListener('click', () => {
        void refreshSelectedIssue();
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
        setFlash(
          role === 'operator'
            ? 'Write token accepted. Operator controls enabled.'
            : 'Token saved, but this runtime is still read-only.',
        );
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
              loadHistory(state.selectedIssueId),
              loadTimeline(state.selectedIssueId),
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
    </script>
  </body>
</html>`;
}
