export type SupervisorControlPlaneIntent =
  | {
      kind: 'issue_list';
      activeOnly: boolean;
      stateFilter: IssueStateFilter | null;
      preferRuntime: true;
    }
  | {
      kind: 'external_sync';
      issueRef: string | null;
      preferRuntime: true;
    }
  | {
      kind: 'issue_status';
      issueRef: string | null;
      preferRuntime: true;
    }
  | {
      kind: 'project_status' | 'watch_status' | 'pending_action_status' | 'runtime_status';
      preferRuntime: true;
    };

export type IssueStateFilter =
  | 'active'
  | 'open'
  | 'failed'
  | 'cancelled'
  | 'completed'
  | 'review';

const ISSUE_NOUN = '(?:issues?|issue|tickets?|ticket|工单|任务|单子)';
const ACTIVE_MARKER = [
  '活跃',
  '运行中',
  '正在\\s*(?:跑|处理|开发|review|推进|执行)',
  '还在\\s*(?:跑|处理|开发|review|推进|执行)',
  '(?:开发|review|处理)\\s*中',
  '未完成',
  '没结束',
  '没有结束',
  '未结束',
  '没关闭',
  '未关闭',
  'open',
  'active',
  'running',
  'in\\s*progress',
].join('|');

const GENERAL_LIST_MARKER = [
  '有哪些',
  '有什么',
  '多少',
  '列(?:一下|出)?',
  '列表',
  'list',
  'what',
].join('|');

const ACTIVE_ISSUE_PATTERNS = [
  new RegExp(`(?:${ACTIVE_MARKER}).{0,24}${ISSUE_NOUN}`, 'i'),
  new RegExp(`${ISSUE_NOUN}.{0,24}(?:${ACTIVE_MARKER})`, 'i'),
  new RegExp(`(?:哪些|哪个|什么).{0,24}(?:${ACTIVE_MARKER}).{0,24}${ISSUE_NOUN}`, 'i'),
  new RegExp(`(?:${ACTIVE_MARKER}).{0,24}(?:哪些|哪个|什么|有吗|吗)`, 'i'),
  /现在在跑什么/i,
  /what(?:'s|\s+is).{0,16}running/i,
  /正在\s*(?:跑|处理|开发|review|推进|执行).{0,16}(?:哪些|哪个|什么|任务|单子|工单|吗)/i,
  /^(?:还有)?活跃(?:的)?(?:呢|吗|有哪些|是哪(?:些|个))?[？?]?$/i,
];

const GENERAL_ISSUE_LIST_PATTERNS = [
  new RegExp(`(?:${GENERAL_LIST_MARKER}).{0,24}${ISSUE_NOUN}`, 'i'),
  new RegExp(`${ISSUE_NOUN}.{0,24}(?:${GENERAL_LIST_MARKER}|tracked)`, 'i'),
  /list\s+(?:issues?|tickets?)/i,
  /what\s+(?:issues?|tickets?)/i,
];

const ISSUE_RECOMMENDATION_PATTERNS = [
  new RegExp(`(?:建议|推荐).{0,48}${ISSUE_NOUN}`, 'i'),
  new RegExp(`${ISSUE_NOUN}.{0,48}(?:建议|推荐|最能提升|最值得|最应该|应该提|做什么|提什么)`, 'i'),
  /\b(?:recommend|suggest)\b.{0,64}\b(?:issues?|tickets?|tasks?)\b/i,
  /\b(?:what|which)\b.{0,24}\b(?:issues?|tickets?|tasks?)\b.{0,64}\b(?:recommend|suggest|should|next|best|valuable|improve|worth)\b/i,
  /\b(?:what|which)\b.{0,24}\b(?:should|would)\b.{0,48}\b(?:issues?|tickets?|tasks?)\b/i,
];

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/g, ' ');
}

function explicitIssueRef(value: string): string | null {
  const match = value.match(/\b([A-Z][A-Z0-9]+)-(\d+)\b/i);
  if (!match) {
    return null;
  }
  const rawPrefix = match[1]!;
  const prefix = rawPrefix.toUpperCase();
  return rawPrefix === prefix || prefix === 'INT' ? `${prefix}-${match[2]}` : null;
}

function issueStateFilter(value: string): IssueStateFilter | null {
  if (/失败|failed|failure|halted|blocked|卡住|卡住了/i.test(value)) {
    return 'failed';
  }
  if (/取消|cancelled|canceled|作废/i.test(value)) {
    return 'cancelled';
  }
  if (/完成|done|completed|closed/i.test(value)) {
    return 'completed';
  }
  if (/review|审核|评审/i.test(value)) {
    return 'review';
  }
  if (ACTIVE_ISSUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return 'active';
  }
  if (/open|未关闭|没关闭|未完成|没结束|未结束/i.test(value)) {
    return 'open';
  }
  return null;
}

function isListLike(value: string): boolean {
  return new RegExp(`(?:${GENERAL_LIST_MARKER}|哪些|哪个|什么|有吗|吗)`, 'i').test(value);
}

function classifyIssueList(value: string): Extract<SupervisorControlPlaneIntent, { kind: 'issue_list' }> | null {
  if (explicitIssueRef(value)) {
    return null;
  }
  if (ISSUE_RECOMMENDATION_PATTERNS.some((pattern) => pattern.test(value))) {
    return null;
  }
  if (ACTIVE_ISSUE_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      kind: 'issue_list',
      activeOnly: true,
      stateFilter: 'active',
      preferRuntime: true,
    };
  }
  const stateFilter = issueStateFilter(value);
  const activeOnly = stateFilter === 'active';
  if (stateFilter && (isListLike(value) || new RegExp(ISSUE_NOUN, 'i').test(value))) {
    return {
      kind: 'issue_list',
      activeOnly,
      stateFilter,
      preferRuntime: true,
    };
  }
  if (GENERAL_ISSUE_LIST_PATTERNS.some((pattern) => pattern.test(value))) {
    return {
      kind: 'issue_list',
      activeOnly: false,
      stateFilter: null,
      preferRuntime: true,
    };
  }
  return null;
}

function isDeepIssueDiagnosis(value: string): boolean {
  return /\b[A-Z][A-Z0-9]+-\d+\b/i.test(value) &&
    /卡在哪里|卡在哪|为什么|预计|多久|什么时候完成|eta|why|blocked|stuck/i.test(value);
}

function isArtifactCreationRequest(value: string): boolean {
  return /(?:create|build|make|design|generate|draw|做|创建|生成|设计|画).{0,48}(?:artifact|visual|demo|page|component|card|plan\s*card|卡片|视觉|页面|组件|演示|原型)/i.test(value);
}

function isPlanCardConceptQuestion(value: string): boolean {
  return /plan\s*card|计划卡/i.test(value) &&
    /what\s+should|should|include|contain|look\s+like|design|visual|template|包含|包括|应该|该有|长什么|怎么设计|内容|元素/i.test(value);
}

function isPlanCardRuntimeQuestion(value: string): boolean {
  return /plan\s*card|计划卡/i.test(value) &&
    /状态|state|status|当前|现在|latest|最新|pending|waiting|approval|confirm|批准|审批|确认|卡住|卡在哪里|进度|progress/i.test(value);
}

export function classifySupervisorControlPlaneIntent(value: string): SupervisorControlPlaneIntent | null {
  const text = normalizeText(value);
  if (!text || isDeepIssueDiagnosis(text) || isArtifactCreationRequest(text) || isPlanCardConceptQuestion(text)) {
    return null;
  }

  const issueRef = explicitIssueRef(text);

  if (
    /supervisor|runtime|agent\s*session|session|会话|队列|正在运行|当前在跑|governance|治理/i.test(text) ||
    isPlanCardRuntimeQuestion(text)
  ) {
    return {
      kind: 'runtime_status',
      preferRuntime: true,
    };
  }

  if (/github|linear|pull\s*request|\bpr\b|tracker|同步|sync|残留|垃圾|清理|干净|clean|branch|分支|workspace|worktree/i.test(text)) {
    return {
      kind: 'external_sync',
      issueRef,
      preferRuntime: true,
    };
  }

  const issueList = classifyIssueList(text);
  if (issueList) {
    return issueList;
  }

  if (issueRef && /状态|state|进度|progress|现在怎么样|怎么样了|在哪|处于|phase/i.test(text)) {
    return {
      kind: 'issue_status',
      issueRef,
      preferRuntime: true,
    };
  }

  if (
    /默认项目.*(?:是什么|哪个|哪些|现在|当前|怎么|如何)|当前项目|(?:what|which).{0,16}(?:default|current)\s+project|(?:default|current)\s+project|project\s*(?:route|routing|status|default)|仓库路由|路由/i.test(text)
  ) {
    return {
      kind: 'project_status',
      preferRuntime: true,
    };
  }

  if (/\bwatch\b|\bunwatch\b|订阅|关注|通知|提醒/i.test(text)) {
    return {
      kind: 'watch_status',
      preferRuntime: true,
    };
  }

  if (/pending|待确认|确认|批准|审批|approval|confirm/i.test(text) && isListLike(text)) {
    return {
      kind: 'pending_action_status',
      preferRuntime: true,
    };
  }

  if (/现在在跑/i.test(text)) {
    return {
      kind: 'runtime_status',
      preferRuntime: true,
    };
  }

  return null;
}

export function isSupervisorControlPlaneQuestion(value: string): boolean {
  return classifySupervisorControlPlaneIntent(value) !== null;
}

export function classifyIssueQueryIntent(
  value: string,
): Extract<SupervisorControlPlaneIntent, { kind: 'issue_list' }> | null {
  const intent = classifySupervisorControlPlaneIntent(value);
  return intent?.kind === 'issue_list' ? intent : null;
}

export function isIssueListQuestion(value: string): boolean {
  return classifyIssueQueryIntent(value) !== null;
}

export function isActiveIssueListQuestion(value: string): boolean {
  return classifyIssueQueryIntent(value)?.activeOnly === true;
}
