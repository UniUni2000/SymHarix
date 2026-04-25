export const runtimePageStyles = `
  :root {
    --bg: #061019;
    --bg-soft: #0b1622;
    --panel: rgba(10, 19, 31, 0.88);
    --panel-strong: rgba(13, 24, 38, 0.96);
    --panel-muted: rgba(17, 29, 45, 0.9);
    --ink: #edf3fb;
    --muted: #8fa3b8;
    --line: rgba(143, 163, 184, 0.16);
    --line-strong: rgba(143, 163, 184, 0.24);
    --accent: #8ee6b0;
    --accent-strong: #1f8f52;
    --accent-soft: rgba(52, 211, 153, 0.14);
    --info: #9cccff;
    --info-soft: rgba(96, 165, 250, 0.14);
    --warn: #f6c98a;
    --warn-soft: rgba(245, 158, 11, 0.16);
    --danger: #ffb4b4;
    --danger-soft: rgba(248, 113, 113, 0.16);
    --shadow: 0 22px 80px rgba(2, 7, 16, 0.42);
  }

  * {
    box-sizing: border-box;
  }

  html {
    color-scheme: dark;
  }

  body {
    margin: 0;
    min-height: 100vh;
    color: var(--ink);
    font-family: "Sohne", "IBM Plex Sans", "Avenir Next", "Segoe UI", sans-serif;
    background:
      radial-gradient(circle at top left, rgba(30, 64, 175, 0.16), transparent 28%),
      radial-gradient(circle at top right, rgba(15, 118, 110, 0.14), transparent 22%),
      linear-gradient(180deg, #07111b 0%, var(--bg) 100%);
  }

  button,
  input,
  textarea {
    font: inherit;
  }

  button {
    border: 0;
    cursor: pointer;
  }

  .deck {
    min-height: 100vh;
    padding: 20px;
  }

  .topbar {
    position: sticky;
    top: 0;
    z-index: 20;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(260px, 0.8fr) auto;
    gap: 18px;
    align-items: center;
    padding: 18px 22px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: rgba(7, 17, 27, 0.82);
    backdrop-filter: blur(24px);
    box-shadow: var(--shadow);
  }

  .brand-kicker,
  .panel-kicker {
    margin: 0 0 8px;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.18em;
    text-transform: uppercase;
  }

  .brand-title {
    margin: 0;
    font-size: 34px;
    line-height: 1;
    letter-spacing: -0.04em;
    font-weight: 720;
  }

  .brand-summary {
    margin: 8px 0 0;
    max-width: 720px;
    color: var(--muted);
    line-height: 1.6;
    font-size: 14px;
  }

  .status-metrics {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
  }

  .metric {
    padding: 12px 14px;
    border: 1px solid var(--line);
    border-radius: 18px;
    background: rgba(15, 24, 37, 0.92);
    transition: transform 180ms ease, border-color 180ms ease;
  }

  .metric:hover {
    transform: translateY(-1px);
    border-color: var(--line-strong);
  }

  .metric-label {
    display: block;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .metric-value {
    display: block;
    margin-top: 6px;
    font-size: 26px;
    line-height: 1;
    letter-spacing: -0.04em;
    font-weight: 760;
  }

  .metric.note .metric-value {
    color: var(--info);
  }

  .topbar-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    justify-content: flex-end;
    align-items: center;
  }

  .action-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 44px;
    padding: 11px 16px;
    border-radius: 14px;
    font-weight: 650;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid var(--line);
    transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
  }

  .action-button:hover:not(:disabled) {
    transform: translateY(-1px);
    border-color: var(--line-strong);
    background: rgba(255, 255, 255, 0.1);
  }

  .action-button:disabled {
    opacity: 0.52;
    cursor: not-allowed;
  }

  .action-button.primary {
    color: #041017;
    background: linear-gradient(135deg, #c7f9dc 0%, #8ee6b0 100%);
    border-color: rgba(142, 230, 176, 0.34);
  }

  .action-button.primary:hover:not(:disabled) {
    background: linear-gradient(135deg, #ddffe9 0%, #9df0bc 100%);
  }

  .action-button.secondary {
    color: var(--ink);
  }

  .action-button.warn {
    color: #fef3c7;
    background: rgba(146, 64, 14, 0.3);
    border-color: rgba(245, 158, 11, 0.22);
  }

  .action-button.danger {
    color: #ffe2e2;
    background: rgba(127, 29, 29, 0.48);
    border-color: rgba(248, 113, 113, 0.24);
  }

  .badge-row {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    align-items: center;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    padding: 6px 10px;
    border-radius: 999px;
    border: 1px solid transparent;
    font-size: 11px;
    line-height: 1;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    font-weight: 700;
  }

  .badge.neutral {
    color: var(--ink);
    background: rgba(255, 255, 255, 0.08);
    border-color: var(--line);
  }

  .badge.accent {
    color: var(--accent);
    background: var(--accent-soft);
    border-color: rgba(142, 230, 176, 0.16);
  }

  .badge.info {
    color: var(--info);
    background: var(--info-soft);
    border-color: rgba(156, 204, 255, 0.18);
  }

  .badge.warn {
    color: var(--warn);
    background: var(--warn-soft);
    border-color: rgba(246, 201, 138, 0.16);
  }

  .badge.danger {
    color: var(--danger);
    background: var(--danger-soft);
    border-color: rgba(255, 180, 180, 0.16);
  }

  .deck-grid {
    display: grid;
    grid-template-columns: minmax(300px, 360px) minmax(0, 1fr);
    gap: 18px;
    margin-top: 18px;
    align-items: start;
  }

  .panel {
    border: 1px solid var(--line);
    border-radius: 26px;
    background: var(--panel);
    box-shadow: var(--shadow);
    backdrop-filter: blur(18px);
  }

  .panel-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 14px;
  }

  .panel-title {
    margin: 0;
    font-size: 17px;
    line-height: 1.15;
    font-weight: 700;
  }

  .panel-copy {
    margin: 6px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .queue-panel {
    position: sticky;
    top: 110px;
    padding: 18px;
    background:
      linear-gradient(180deg, rgba(8, 17, 28, 0.94) 0%, rgba(8, 17, 28, 0.84) 100%);
  }

  .queue-toolbar {
    display: flex;
    gap: 10px;
    align-items: center;
    margin-bottom: 14px;
  }

  .queue-search {
    width: 100%;
    min-height: 42px;
    padding: 10px 12px;
    border-radius: 14px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
    color: var(--ink);
  }

  .queue-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    max-height: calc(100vh - 220px);
    overflow: auto;
    padding-right: 4px;
  }

  .queue-card {
    width: 100%;
    padding: 14px 14px 15px;
    text-align: left;
    border-radius: 20px;
    border: 1px solid var(--line);
    background: rgba(17, 29, 45, 0.78);
    color: inherit;
    transition: transform 180ms ease, border-color 180ms ease, background 180ms ease;
  }

  .queue-card:hover:not(:disabled),
  .queue-card.active {
    transform: translateY(-1px);
    border-color: rgba(156, 204, 255, 0.28);
    background: rgba(21, 35, 53, 0.98);
  }

  .queue-card-title {
    margin: 10px 0 0;
    font-size: 15px;
    line-height: 1.4;
    font-weight: 700;
  }

  .queue-card-copy {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .queue-section-footer {
    margin-top: 12px;
    color: var(--muted);
    font-size: 12px;
    line-height: 1.6;
  }

  .focus-stack {
    display: grid;
    grid-template-rows: auto auto;
    gap: 18px;
  }

  .focus-card {
    min-height: 360px;
    padding: 24px;
    overflow: hidden;
    background:
      radial-gradient(circle at top right, rgba(96, 165, 250, 0.12), transparent 24%),
      linear-gradient(180deg, rgba(11, 22, 34, 0.96) 0%, rgba(7, 17, 27, 0.98) 100%);
    animation: riseIn 220ms ease-out;
  }

  .focus-card[data-tone="needs_decision"] {
    background:
      radial-gradient(circle at top right, rgba(248, 113, 113, 0.14), transparent 28%),
      linear-gradient(180deg, rgba(14, 22, 35, 0.98) 0%, rgba(9, 18, 29, 0.98) 100%);
  }

  .focus-card[data-tone="delivery_failed"] {
    background:
      radial-gradient(circle at top right, rgba(245, 158, 11, 0.16), transparent 28%),
      linear-gradient(180deg, rgba(17, 23, 31, 0.98) 0%, rgba(9, 18, 29, 0.98) 100%);
  }

  .focus-card[data-tone="running"] {
    background:
      radial-gradient(circle at top right, rgba(52, 211, 153, 0.12), transparent 24%),
      linear-gradient(180deg, rgba(10, 20, 31, 0.98) 0%, rgba(7, 17, 27, 0.98) 100%);
  }

  .focus-layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(240px, 320px);
    gap: 18px;
    align-items: start;
  }

  .focus-headline {
    margin: 14px 0 0;
    max-width: 840px;
    font-size: 38px;
    line-height: 1.04;
    letter-spacing: -0.045em;
    font-weight: 760;
  }

  .focus-summary {
    margin: 14px 0 0;
    max-width: 780px;
    color: #a3b7cb;
    font-size: 15px;
    line-height: 1.7;
  }

  .focus-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin-top: 22px;
  }

  .focus-callout {
    padding: 15px 16px;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
  }

  .focus-callout-label {
    display: block;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .focus-callout-value {
    display: block;
    margin-top: 8px;
    font-size: 16px;
    line-height: 1.55;
    font-weight: 600;
  }

  .focus-side {
    display: grid;
    gap: 12px;
  }

  .focus-side-card {
    padding: 16px;
    border-radius: 20px;
    border: 1px solid var(--line);
    background: rgba(255, 255, 255, 0.04);
  }

  .focus-side-card .focus-callout-value {
    font-size: 18px;
  }

  .focus-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 22px;
  }

  .signal-grid {
    display: grid;
    grid-template-columns: minmax(0, 1.05fr) minmax(300px, 0.95fr);
    gap: 18px;
  }

  .signal-column {
    display: grid;
    gap: 18px;
  }

  .signal-panel {
    padding: 18px;
    background: var(--panel-strong);
  }

  .signal-list {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 14px;
  }

  .signal-item {
    padding: 14px;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: var(--panel-muted);
    transition: border-color 180ms ease, transform 180ms ease;
  }

  .signal-item:hover {
    transform: translateY(-1px);
    border-color: var(--line-strong);
  }

  .signal-item-title {
    margin: 10px 0 0;
    font-size: 14px;
    line-height: 1.45;
    font-weight: 680;
  }

  .signal-item-copy {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .signal-item small {
    display: block;
    margin-top: 8px;
    color: var(--muted);
    font-size: 12px;
  }

  .insight-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
    margin-top: 14px;
  }

  .insight-stat {
    padding: 14px;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: var(--panel-muted);
  }

  .insight-stat-label {
    display: block;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.1em;
  }

  .insight-stat-value {
    display: block;
    margin-top: 8px;
    font-size: 24px;
    line-height: 1;
    letter-spacing: -0.04em;
    font-weight: 760;
  }

  .summary-stack {
    display: grid;
    gap: 10px;
    margin-top: 14px;
  }

  .summary-card {
    padding: 14px;
    border-radius: 18px;
    border: 1px solid var(--line);
    background: var(--panel-muted);
  }

  .summary-card-title {
    margin: 0;
    font-size: 14px;
    line-height: 1.4;
    font-weight: 680;
  }

  .summary-card-copy {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.6;
  }

  .summary-card details {
    margin-top: 10px;
  }

  .summary-card summary {
    cursor: pointer;
    color: var(--info);
    font-size: 12px;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .summary-card pre {
    margin: 10px 0 0;
    padding: 10px;
    overflow: auto;
    border-radius: 14px;
    background: rgba(4, 16, 23, 0.72);
    color: #cfdce8;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .drawer-root {
    position: fixed;
    inset: 0;
    z-index: 30;
    display: none;
  }

  .drawer-root.open {
    display: block;
  }

  .drawer-backdrop {
    position: absolute;
    inset: 0;
    background: rgba(1, 7, 14, 0.72);
    backdrop-filter: blur(8px);
  }

  .drawer-panel {
    position: absolute;
    top: 18px;
    right: 18px;
    width: min(460px, calc(100vw - 36px));
    max-height: calc(100vh - 36px);
    overflow: auto;
    padding: 20px;
    border: 1px solid var(--line);
    border-radius: 24px;
    background: rgba(8, 17, 28, 0.96);
    box-shadow: var(--shadow);
    animation: slideIn 180ms ease-out;
  }

  .drawer-header {
    display: flex;
    justify-content: space-between;
    gap: 12px;
    align-items: flex-start;
    margin-bottom: 16px;
  }

  .drawer-title {
    margin: 0;
    font-size: 24px;
    line-height: 1.1;
    letter-spacing: -0.03em;
    font-weight: 740;
  }

  .drawer-copy {
    margin: 8px 0 0;
    color: var(--muted);
    font-size: 14px;
    line-height: 1.6;
  }

  .drawer-form {
    display: grid;
    gap: 12px;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px;
  }

  .form-label {
    display: block;
    margin-bottom: 6px;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
  }

  .form-input,
  .form-textarea {
    width: 100%;
    min-height: 44px;
    padding: 11px 12px;
    border: 1px solid var(--line);
    border-radius: 14px;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.05);
  }

  .form-textarea {
    min-height: 120px;
    resize: vertical;
  }

  .drawer-actions {
    display: flex;
    gap: 10px;
    flex-wrap: wrap;
    margin-top: 4px;
  }

  .flash {
    min-height: 18px;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.4;
  }

  .empty-state {
    padding: 22px;
    border-radius: 20px;
    border: 1px dashed var(--line);
    color: var(--muted);
    text-align: center;
    line-height: 1.6;
    background: rgba(255, 255, 255, 0.03);
  }

  .stack {
    display: grid;
    gap: 10px;
  }

  .muted-inline {
    color: var(--muted);
  }

  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  @keyframes riseIn {
    from {
      opacity: 0;
      transform: translateY(10px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      transform: translateX(18px);
    }
    to {
      opacity: 1;
      transform: translateX(0);
    }
  }

  @media (max-width: 1180px) {
    .topbar {
      grid-template-columns: 1fr;
    }

    .focus-layout,
    .signal-grid {
      grid-template-columns: 1fr;
    }
  }

  @media (max-width: 920px) {
    .deck-grid {
      grid-template-columns: 1fr;
    }

    .queue-panel {
      position: static;
      order: 2;
    }

    .focus-stack {
      order: 1;
    }

    .queue-list {
      max-height: none;
    }
  }

  @media (max-width: 720px) {
    .deck {
      padding: 14px;
    }

    .topbar,
    .focus-card,
    .signal-panel,
    .queue-panel {
      border-radius: 22px;
    }

    .brand-title {
      font-size: 30px;
    }

    .focus-headline {
      font-size: 30px;
    }

    .status-metrics,
    .focus-grid,
    .insight-grid,
    .form-grid {
      grid-template-columns: 1fr;
    }

    .topbar-actions,
    .focus-actions,
    .drawer-actions {
      width: 100%;
    }

    .topbar-actions .action-button,
    .focus-actions .action-button,
    .drawer-actions .action-button {
      flex: 1 1 100%;
    }
  }
`;
