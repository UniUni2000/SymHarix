export function renderRuntimeMarkup(): string {
  return `
    <div class="deck">
      <header class="topbar">
        <div>
          <div class="brand-kicker">Symphony Runtime / Command Deck</div>
          <h1 class="brand-title">Symphony Runtime</h1>
          <p id="status-summary" class="brand-summary">Loading the current operating picture...</p>
        </div>

        <div class="status-metrics">
          <div class="metric">
            <span class="metric-label">Needs decision</span>
            <strong id="metric-needs-decision" class="metric-value">0</strong>
          </div>
          <div class="metric note">
            <span class="metric-label">Running</span>
            <strong id="metric-running" class="metric-value">0</strong>
          </div>
          <div class="metric">
            <span class="metric-label">Failed</span>
            <strong id="metric-failed" class="metric-value">0</strong>
          </div>
        </div>

        <div class="topbar-actions">
          <span id="connection-badge" class="badge neutral">Connecting</span>
          <span id="access-badge" class="badge warn">Checking access</span>
          <button id="open-access-button" type="button" class="action-button secondary">Access token</button>
          <button id="refresh-button" type="button" class="action-button secondary">Refresh</button>
          <button id="open-create-button" type="button" class="action-button primary">New Issue</button>
        </div>
      </header>

      <div class="deck-grid">
        <aside class="panel queue-panel">
          <div class="panel-header">
            <div>
              <div class="panel-kicker">Queue</div>
              <h2 class="panel-title">Hot queue</h2>
              <p class="panel-copy">The issues that need a decision or intervention first.</p>
            </div>
          </div>

          <div class="queue-toolbar">
            <label class="sr-only" for="filter-input">Filter issues</label>
            <input id="filter-input" class="queue-search" placeholder="Filter by key, title, state, or phase" />
          </div>

          <div id="queue-list" class="queue-list"></div>
          <p class="queue-section-footer">Queue items show the current handling meaning, not every raw field.</p>
        </aside>

        <main class="focus-stack">
          <section id="focus-card" class="panel focus-card" data-tone="running">
            <div class="empty-state">Loading the current focus...</div>
          </section>

          <section class="signal-grid">
            <div class="signal-column">
              <section class="panel signal-panel">
                <div class="panel-header">
                  <div>
                    <div class="panel-kicker">Signals</div>
                    <h2 class="panel-title">High-signal timeline</h2>
                    <p id="timeline-caption" class="panel-copy">Only the events worth watching stay here.</p>
                  </div>
                </div>
                <div id="timeline-list" class="signal-list"></div>
              </section>

              <section class="panel signal-panel">
                <div class="panel-header">
                  <div>
                    <div class="panel-kicker">Replay</div>
                    <h2 class="panel-title">History replay</h2>
                    <p id="history-caption" class="panel-copy">Recent agent and review checkpoints for the selected issue.</p>
                  </div>
                </div>
                <div id="history-list" class="signal-list"></div>
              </section>
            </div>

            <div class="signal-column">
              <section class="panel signal-panel">
                <div class="panel-header">
                  <div>
                    <div class="panel-kicker">Inspector</div>
                    <h2 class="panel-title">Focus inspector</h2>
                    <p class="panel-copy">Evidence, governance, architecture, and child-thread meaning.</p>
                  </div>
                </div>
                <div id="inspector-content"></div>
              </section>
            </div>
          </section>
        </main>
      </div>

      <div id="access-drawer" class="drawer-root" aria-hidden="true">
        <div class="drawer-backdrop" data-close-drawer="access"></div>
        <section class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="access-drawer-title">
          <div class="drawer-header">
            <div>
              <div class="panel-kicker">Runtime Access</div>
              <h2 id="access-drawer-title" class="drawer-title">Access token</h2>
              <p id="access-copy" class="drawer-copy">Loading access controls...</p>
            </div>
            <button type="button" class="action-button secondary" data-close-drawer="access">Close</button>
          </div>

          <form id="access-form" class="drawer-form">
            <div>
              <label class="form-label" for="runtime-token-input">Write token</label>
              <input id="runtime-token-input" name="runtime_token" class="form-input" placeholder="Optional runtime write token" />
            </div>
            <div class="drawer-actions">
              <button id="save-token-button" type="submit" class="action-button primary">Save token</button>
              <button id="clear-token-button" type="button" class="action-button secondary">Clear token</button>
            </div>
          </form>
        </section>
      </div>

      <div id="create-drawer" class="drawer-root" aria-hidden="true">
        <div class="drawer-backdrop" data-close-drawer="create"></div>
        <section class="drawer-panel" role="dialog" aria-modal="true" aria-labelledby="create-drawer-title">
          <div class="drawer-header">
            <div>
              <div class="panel-kicker">New Issue</div>
              <h2 id="create-drawer-title" class="drawer-title">Create issue</h2>
              <p class="drawer-copy">Open a new issue without taking over the main control surface.</p>
            </div>
            <button type="button" class="action-button secondary" data-close-drawer="create">Close</button>
          </div>

          <form id="create-form" class="drawer-form">
            <div>
              <label class="form-label" for="create-title">Title</label>
              <input id="create-title" name="title" class="form-input" placeholder="Issue title" required />
            </div>
            <div>
              <label class="form-label" for="create-description">Description</label>
              <textarea id="create-description" name="description" class="form-textarea" placeholder="Describe the task"></textarea>
            </div>
            <div class="form-grid">
              <div>
                <label class="form-label" for="create-team-id">Team ID</label>
                <input id="create-team-id" name="team_id" class="form-input" placeholder="Optional team ID" />
              </div>
              <div>
                <label class="form-label" for="create-project-slug">Project slug</label>
                <input id="create-project-slug" name="project_slug" class="form-input" placeholder="Preferred project slug" />
              </div>
            </div>
            <div class="form-grid">
              <div>
                <label class="form-label" for="create-project-id">Project ID</label>
                <input id="create-project-id" name="project_id" class="form-input" placeholder="Optional project ID" />
              </div>
              <div>
                <label class="form-label" for="create-state-id">State ID</label>
                <input id="create-state-id" name="state_id" class="form-input" placeholder="Optional state ID" />
              </div>
            </div>
            <div class="drawer-actions">
              <button id="create-button" type="submit" class="action-button primary">Create issue</button>
            </div>
          </form>
        </section>
      </div>

      <p id="flash-message" class="flash" aria-live="polite"></p>
    </div>
  `;
}
