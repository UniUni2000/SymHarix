import type {
  RuntimeFileActivity,
  RuntimeIssueView,
  RuntimeMilestoneView,
  RuntimeToolActivity,
} from './types';
import * as cp from 'child_process';

export type RuntimeMiniAppLocale = 'zh' | 'en';

export type RuntimeMiniAppI18nKey =
  | 'tab.overview' | 'tab.activity' | 'tab.changes' | 'tab.delivery'
  | 'panel.judgment' | 'panel.next' | 'panel.round_goal' | 'panel.risk_delta'
  | 'panel.timeline' | 'panel.agents' | 'panel.milestones' | 'panel.changes'
  | 'panel.files' | 'panel.delivery' | 'panel.children' | 'panel.full_log'
  | 'panel.recovery'
  | 'chip.recent' | 'chip.recent3' | 'chip.milestones' | 'chip.diff'
  | 'label.repo' | 'label.overall_progress'
  | 'copy.loading_state' | 'copy.waiting_runtime' | 'copy.waiting_round'
  | 'copy.loading_timeline' | 'copy.waiting_history' | 'copy.recovery_idle'
  | 'copy.recovery_action' | 'copy.no_files' | 'copy.no_diff' | 'copy.no_agent'
  | 'copy.no_milestone' | 'copy.no_history'
  | 'copy.connection_offline' | 'copy.connection_reconnecting' | 'copy.connection_online'
  | 'copy.diff_no_patch' | 'copy.runtime_event'
  | 'action.pause' | 'action.request' | 'action.back' | 'action.view_pr'
  | 'action.pr_pending' | 'action.retry' | 'action.retrying' | 'action.full_log'
  | 'action.new_request' | 'action.expand_log' | 'action.collapse_log'
  | 'action.expand' | 'action.collapse'
  | 'state.completed' | 'state.waiting' | 'state.running'
  | 'state.awaiting_review' | 'state.approved'
  | 'state.pending' | 'state.done' | 'state.in_progress'
  | 'group.read_files' | 'group.edit_files' | 'group.write_files'
  | 'group.bash_commands' | 'group.test_runs' | 'group.tool_calls'
  | 'diag.summary' | 'diag.retry' | 'diag.ok' | 'diag.pending' | 'diag.fail'
  | 'diag.network' | 'diag.http' | 'diag.parse' | 'diag.soft'
  // state labels
  | 'label.completed' | 'label.final' | 'label.proof_satisfied' | 'label.needs_recovery'
  | 'label.running' | 'label.action' | 'label.live' | 'label.repo_pending'
  | 'label.offline' | 'label.closed' | 'label.delivery_done' | 'label.child_running'
  | 'label.root_issue' | 'label.supervisor_done' | 'label.claude_running'
  | 'label.supervisor' | 'label.round_format' | 'label.round_prefix' | 'label.root_format'
  // stage labels
  | 'stage.plan' | 'stage.dispatch' | 'stage.dev' | 'stage.review'
  // title
  | 'title.delivery_summary' | 'title.live_stream'
  // copy
  | 'copy.completed_pr' | 'copy.completed_no_pr' | 'copy.delivery_closed'
  | 'copy.round_goal_done' | 'copy.single_issue_done' | 'copy.single_issue_no_split'
  | 'copy.judgment_advancing' | 'copy.recovery_stuck' | 'copy.waiting_supervisor'
  | 'copy.waiting_signal' | 'copy.risk_stable' | 'copy.round_goal_waiting'
  | 'copy.waiting_events' | 'copy.no_history_log'
  // tool / file
  | 'tool.running' | 'tool.completed' | 'tool.activity' | 'tool.activity_named'
  | 'file.read' | 'file.write' | 'file.edit' | 'file.activity'
  | 'file.deleted' | 'file.added' | 'file.updated'
  | 'file.update_name' | 'file.delete_name' | 'file.add_name'
  | 'file.read_name' | 'file.write_name' | 'file.edit_name'
  | 'file.activity_started' | 'file.activity_completed'
  | 'diff.summary_test' | 'diff.summary_ui' | 'diff.summary_docs'
  | 'diff.summary_deps' | 'diff.summary_evidence'
  // bash
  | 'bash.view_pr' | 'bash.view_pr_status' | 'bash.git_status' | 'bash.run_tests'
  | 'bash.and_then' | 'bash.write_file' | 'bash.read_file' | 'bash.list_files'
  | 'bash.write_path' | 'bash.read_path'
  // milestone
  | 'milestone.plan_formed' | 'milestone.need_confirm' | 'milestone.in_channel'
  | 'milestone.ready_channel' | 'milestone.issue_done' | 'milestone.evidence_ok'
  | 'milestone.review_qa' | 'milestone.dev_advancing'
  // child
  | 'child.prefix' | 'child.queued' | 'child.pending'
  // hero action
  | 'hero.retry_submitted' | 'hero.retry_failed' | 'hero.retrying'
  | 'hero.pause_info' | 'hero.request_info'
  // error
  | 'error.load_failed' | 'error.unknown' | 'error.still_loading'
  | 'error.no_history_log' | 'error.no_replayable_log'
  | 'error.cannot_load' | 'error.cannot_load_tip'
  | 'label.unavailable' | 'label.event' | 'label.milestone'
  | 'label.recorded' | 'label.checkpoint' | 'label.log'
  // orchestrator states — prevent raw internal strings leaking to UI
  | 'state.orchestrator_discovering' | 'state.orchestrator_mapping'
  | 'state.orchestrator_workspace_ready' | 'state.orchestrator_dev_running'
  | 'state.orchestrator_dev_post_processing' | 'state.orchestrator_review_running'
  | 'state.orchestrator_review_post_processing' | 'state.orchestrator_needs_rework'
  | 'state.orchestrator_retry_scheduled' | 'state.orchestrator_halted'
  | 'state.orchestrator_completed' | 'state.orchestrator_cancelled'
  | 'state.orchestrator_failed';

export const MINI_APP_I18N: Record<RuntimeMiniAppLocale, Record<RuntimeMiniAppI18nKey, string>> = {
  zh: {
    'tab.overview': '全览',
    'tab.activity': '活动',
    'tab.changes': '改动',
    'tab.delivery': '交付',
    'panel.judgment': '全览 / Supervisor 判断',
    'panel.next': '下一步推荐',
    'panel.round_goal': '当前轮次目标',
    'panel.risk_delta': '风险变化',
    'panel.timeline': '实时事件流',
    'panel.agents': 'Agent 进度',
    'panel.milestones': '关键节点',
    'panel.changes': '代码改动',
    'panel.files': '文件活动',
    'panel.delivery': 'PR / Delivery',
    'panel.children': '子任务队列',
    'panel.full_log': '完整日志',
    'panel.recovery': '失败恢复',
    'chip.recent': '最近',
    'chip.recent3': '最近 3 条',
    'chip.milestones': '节点',
    'chip.diff': '差异',
    'label.repo': '仓库',
    'label.overall_progress': '整体进度',
    'copy.loading_state': '正在读取当前 issue 状态。',
    'copy.waiting_runtime': '等待运行时信号。',
    'copy.waiting_round': '等待 supervisor round 信号。',
    'copy.loading_timeline': '正在加载事件流…',
    'copy.waiting_history': '等待历史记录。',
    'copy.recovery_idle': '交付状态正常，暂无需要恢复的失败。',
    'copy.recovery_action': '交付出现可恢复的失败，可以一键重试。',
    'copy.no_files': '暂无文件活动。',
    'copy.no_diff': '还没有可展示的代码改动。',
    'copy.no_agent': '暂无 agent 最近进度。',
    'copy.no_milestone': '暂无关键节点总结。',
    'copy.no_history': '暂无历史检查点。',
    'copy.connection_offline': 'Live 已断开 · 点此重连',
    'copy.connection_reconnecting': 'Live 正在重连…',
    'copy.connection_online': 'Live 已恢复',
    'copy.diff_no_patch': '暂无补丁内容',
    'copy.runtime_event': '运行时事件',
    'action.pause': '暂停执行',
    'action.request': '补充要求',
    'action.back': '回 Telegram',
    'action.view_pr': '查看 PR',
    'action.pr_pending': 'PR 待生成',
    'action.retry': '修复交付并重试',
    'action.retrying': '正在重试…',
    'action.full_log': '完整日志',
    'action.new_request': '新需求',
    'action.expand_log': '展开',
    'action.collapse_log': '收起',
    'action.expand': '展开',
    'action.collapse': '收起',
    'state.completed': '完成',
    'state.waiting': '等待',
    'state.running': '运行中',
    'state.awaiting_review': '待审查',
    'state.approved': '已通过',
    'state.pending': '等待中',
    'state.done': '已完成',
    'state.in_progress': '进行中',
    'group.read_files': '读取 {n} 个文件',
    'group.edit_files': '编辑 {n} 个文件',
    'group.write_files': '写入 {n} 个文件',
    'group.bash_commands': '运行 {n} 条命令',
    'group.test_runs': '执行 {n} 次测试',
    'group.tool_calls': '调用 {n} 次工具',
    'diag.summary': '诊断 · 接口探测',
    'diag.retry': '重新检测',
    'diag.ok': '正常',
    'diag.pending': '加载中',
    'diag.fail': '失败',
    'diag.network': '网络错误',
    'diag.http': 'HTTP 错误',
    'diag.parse': '响应不是 JSON',
    'diag.soft': '业务返回失败',
    // state labels
    'label.completed': '已完成',
    'label.final': '终态',
    'label.proof_satisfied': '验证通过',
    'label.needs_recovery': '需恢复',
    'label.running': '运行中',
    'label.action': '操作',
    'label.live': '在线',
    'label.repo_pending': '仓库待识别',
    'label.offline': '离线',
    'label.closed': '已关闭',
    'label.delivery_done': '交付完成',
    'label.child_running': '子任务运行中',
    'label.root_issue': '根 issue',
    'label.supervisor_done': 'Supervisor 完成',
    'label.claude_running': 'Claude 运行中',
    'label.supervisor': 'Supervisor',
    'label.round_format': '轮次 {index}/{total}',
    'label.round_prefix': '轮次',
    'label.root_format': 'Root: {id}',
    // stage labels
    'stage.plan': '规划',
    'stage.dispatch': '调度',
    'stage.dev': '开发',
    'stage.review': '审查',
    // title
    'title.delivery_summary': '交付总结',
    'title.live_stream': '实时事件流',
    // copy
    'copy.completed_pr': '已完成，PR #{n} 已就绪。可以查看 PR，或回到 Telegram 发起下一条需求。',
    'copy.completed_no_pr': '已完成。可以回到 Telegram 发起下一条需求。',
    'copy.delivery_closed': '计划线程已完成，最终交付已闭环。',
    'copy.round_goal_done': '当前计划「{title}」已经完成，不再向 dev agent 追加指令。',
    'copy.single_issue_done': '单 issue 已完成，没有拆分子任务。',
    'copy.single_issue_no_split': '这是单 issue 执行，没有必要拆分子任务。',
    'copy.judgment_advancing': '当前只推进最有把握的下一步，保持 child 队列有序。',
    'copy.recovery_stuck': '交付恢复卡住了，但这类问题可以一键重试：先清理工作流产物，再重新进入交付。',
    'copy.waiting_supervisor': '等待 supervisor 写入下一步动作。',
    'copy.waiting_signal': '等待下一步运行时信号。',
    'copy.risk_stable': '稳定',
    'copy.round_goal_waiting': '等待 supervisor round 信号。',
    'copy.waiting_events': '等待事件流。',
    'copy.no_history_log': '暂无历史检查点。',
    // tool / file
    'tool.running': '{name} 运行中',
    'tool.completed': '{name} 完成',
    'tool.activity': '活动',
    'tool.activity_named': '{name} 活动',
    'file.read': '读取',
    'file.write': '写入',
    'file.edit': '编辑',
    'file.activity': '文件活动',
    'file.deleted': '删除文件。',
    'file.added': '新增文件。',
    'file.updated': '更新文件。',
    'file.update_name': '更新 {name}。',
    'file.delete_name': '删除 {name}。',
    'file.add_name': '新增 {name}。',
    'file.read_name': '读取 {name}',
    'file.write_name': '写入 {name}',
    'file.edit_name': '编辑 {name}',
    'file.activity_started': '{action}中 · {summary}',
    'file.activity_completed': '{action}完成 · {summary}',
    'diff.summary_test': '补充或更新回归测试。',
    'diff.summary_ui': '调整界面展示逻辑与排版。',
    'diff.summary_docs': '更新文档说明。',
    'diff.summary_deps': '更新依赖或脚本配置。',
    'diff.summary_evidence': '更新运行证据与交付状态。',
    // bash
    'bash.view_pr': '查看 PR #{pr}',
    'bash.view_pr_status': '查看 PR 状态',
    'bash.git_status': '检查 Git 状态',
    'bash.run_tests': '运行测试',
    'bash.and_then': '，然后 ',
    'bash.write_file': '写入文件',
    'bash.read_file': '读取文件',
    'bash.list_files': '检查文件列表',
    'bash.write_path': '写入 {path}',
    'bash.read_path': '读取 {path}',
    // milestone
    'milestone.plan_formed': '计划已形成，等待执行信号。',
    'milestone.need_confirm': '当前需要用户确认下一步。',
    'milestone.in_channel': '已进入运行通道，等待最近执行信号刷新。',
    'milestone.ready_channel': '已准备进入运行通道。',
    'milestone.issue_done': 'Issue 已完成，最终交付已闭环。',
    'milestone.evidence_ok': '证据已满足，正在等待最终交付。',
    'milestone.review_qa': 'Review 正在检查交付质量。',
    'milestone.dev_advancing': 'Dev agent 正在推进当前轮次。',
    // child
    'child.prefix': '子任务 {n}',
    'child.queued': '排队中',
    'child.pending': '等待中',
    // hero action
    'hero.retry_submitted': '恢复动作已提交。',
    'hero.retry_failed': '恢复动作提交失败。',
    'hero.retrying': '正在重试…',
    'hero.pause_info': '暂停执行会回到 Telegram 原生按钮确认。',
    'hero.request_info': '补充要求会回到 Telegram 对话继续输入。',
    // error
    'error.load_failed': '加载失败 · 点此重试',
    'error.unknown': '未知错误',
    'error.still_loading': '仍在加载… 点击 banner 可重试',
    'error.no_history_log': '这条 issue 暂时还没有可回放的完整日志。',
    'error.no_replayable_log': '暂无回放日志。',
    'error.cannot_load': '无法读取这条 issue。',
    'error.cannot_load_tip': '可能原因：运行时服务未启动 / 当前数据库里没有这个 issue id / 接口在另一个 origin。点击顶部 banner 可重试，或打开浏览器 DevTools 看 Network 详情。',
    'label.unavailable': '暂不可用',
    'label.event': '事件',
    'label.milestone': '关键节点',
    'label.recorded': '已记录',
    'label.checkpoint': '检查点',
    'label.log': '日志',
    // orchestrator states
    'state.orchestrator_discovering': '探索中',
    'state.orchestrator_mapping': '映射中',
    'state.orchestrator_workspace_ready': '工作区就绪',
    'state.orchestrator_dev_running': 'Dev 执行中',
    'state.orchestrator_dev_post_processing': 'Dev 收尾中',
    'state.orchestrator_review_running': 'Review 执行中',
    'state.orchestrator_review_post_processing': 'Review 收尾中',
    'state.orchestrator_needs_rework': '需要返工',
    'state.orchestrator_retry_scheduled': '已安排重试',
    'state.orchestrator_halted': '已暂停',
    'state.orchestrator_completed': '已完成',
    'state.orchestrator_cancelled': '已取消',
    'state.orchestrator_failed': '已失败',
  },
  en: {
    'tab.overview': 'Overview',
    'tab.activity': 'Activity',
    'tab.changes': 'Changes',
    'tab.delivery': 'Delivery',
    'panel.judgment': 'Overview / Supervisor judgment',
    'panel.next': 'Next recommendation',
    'panel.round_goal': 'Current round goal',
    'panel.risk_delta': 'Risk delta',
    'panel.timeline': 'Live event stream',
    'panel.agents': 'Agent progress',
    'panel.milestones': 'Milestones',
    'panel.changes': 'Code changes',
    'panel.files': 'File activity',
    'panel.delivery': 'PR / Delivery',
    'panel.children': 'Child queue',
    'panel.full_log': 'Full log',
    'panel.recovery': 'Failure recovery',
    'chip.recent': 'recent',
    'chip.recent3': 'last 3',
    'chip.milestones': 'Milestones',
    'chip.diff': 'Diff',
    'label.repo': 'Repo',
    'label.overall_progress': 'Overall progress',
    'copy.loading_state': 'Loading the current issue state…',
    'copy.waiting_runtime': 'Waiting for runtime signals.',
    'copy.waiting_round': 'Waiting for the supervisor round signal.',
    'copy.loading_timeline': 'Loading timeline…',
    'copy.waiting_history': 'Waiting for history records.',
    'copy.recovery_idle': 'Delivery is healthy. Nothing to recover.',
    'copy.recovery_action': 'Delivery hit a recoverable failure — retry to continue.',
    'copy.no_files': 'No recent file activity.',
    'copy.no_diff': 'No code changes to show yet.',
    'copy.no_agent': 'No recent agent progress.',
    'copy.no_milestone': 'No milestones recorded.',
    'copy.no_history': 'No checkpoints in history.',
    'copy.connection_offline': 'Live disconnected · tap to reconnect',
    'copy.connection_reconnecting': 'Reconnecting live stream…',
    'copy.connection_online': 'Live restored',
    'copy.diff_no_patch': 'No patch content available',
    'copy.runtime_event': 'Runtime event',
    'action.pause': 'Pause',
    'action.request': 'Add request',
    'action.back': 'Back to Telegram',
    'action.view_pr': 'View PR',
    'action.pr_pending': 'PR pending',
    'action.retry': 'Repair & retry delivery',
    'action.retrying': 'Retrying…',
    'action.full_log': 'Full log',
    'action.new_request': 'New request',
    'action.expand_log': 'Expand',
    'action.collapse_log': 'Collapse',
    'action.expand': 'Expand',
    'action.collapse': 'Collapse',
    'state.completed': 'Done',
    'state.waiting': 'Waiting',
    'state.running': 'Running',
    'state.awaiting_review': 'Pending',
    'state.approved': 'Approved',
    'state.pending': 'Pending',
    'state.done': 'Done',
    'state.in_progress': 'In progress',
    'group.read_files': 'Read {n} files',
    'group.edit_files': 'Edited {n} files',
    'group.write_files': 'Wrote {n} files',
    'group.bash_commands': 'Ran {n} shell commands',
    'group.test_runs': 'Ran {n} test runs',
    'group.tool_calls': 'Called tools {n} times',
    'diag.summary': 'Diagnostics · endpoint probe',
    'diag.retry': 'Re-test',
    'diag.ok': 'OK',
    'diag.pending': 'Pending',
    'diag.fail': 'Failed',
    'diag.network': 'Network error',
    'diag.http': 'HTTP error',
    'diag.parse': 'Response was not JSON',
    'diag.soft': 'API soft fail',
    // state labels
    'label.completed': 'Completed',
    'label.final': 'Final',
    'label.proof_satisfied': 'Proof satisfied',
    'label.needs_recovery': 'Needs recovery',
    'label.running': 'Running',
    'label.action': 'Action',
    'label.live': 'Live',
    'label.repo_pending': 'Repo pending',
    'label.offline': 'Offline',
    'label.closed': 'Closed',
    'label.delivery_done': 'Delivery done',
    'label.child_running': 'Child running',
    'label.root_issue': 'Root issue',
    'label.supervisor_done': 'Supervisor done',
    'label.claude_running': 'Claude running',
    'label.supervisor': 'Supervisor',
    'label.round_format': 'Round {index}/{total}',
    'label.round_prefix': 'Round',
    'label.root_format': 'Root: {id}',
    // stage labels
    'stage.plan': 'Plan',
    'stage.dispatch': 'Dispatch',
    'stage.dev': 'Dev',
    'stage.review': 'Review',
    // title
    'title.delivery_summary': 'Delivery summary',
    'title.live_stream': 'Live event stream',
    // copy
    'copy.completed_pr': 'Completed, PR #{n} is ready. View PR or return to Telegram.',
    'copy.completed_no_pr': 'Completed. Return to Telegram for next request.',
    'copy.delivery_closed': 'Plan thread completed, delivery closed.',
    'copy.round_goal_done': 'Plan "{title}" is complete, no more instructions to dev agent.',
    'copy.single_issue_done': 'Single issue completed, no child tasks.',
    'copy.single_issue_no_split': 'Single issue execution, no need to split.',
    'copy.judgment_advancing': 'Advancing the most confident next step, keeping child queue ordered.',
    'copy.recovery_stuck': 'Recovery stuck — retry to clean up workflow artifacts and re-enter delivery.',
    'copy.waiting_supervisor': 'Waiting for supervisor to write next action.',
    'copy.waiting_signal': 'Waiting for next runtime signal.',
    'copy.risk_stable': 'Stable',
    'copy.round_goal_waiting': 'Waiting for supervisor round signal.',
    'copy.waiting_events': 'Waiting for events…',
    'copy.no_history_log': 'No history checkpoints.',
    // tool / file
    'tool.running': '{name} running',
    'tool.completed': '{name} completed',
    'tool.activity': 'Activity',
    'tool.activity_named': '{name} activity',
    'file.read': 'Read',
    'file.write': 'Write',
    'file.edit': 'Edit',
    'file.activity': 'File activity',
    'file.deleted': 'Deleted file.',
    'file.added': 'Added file.',
    'file.updated': 'Updated file.',
    'file.update_name': 'Update {name}.',
    'file.delete_name': 'Delete {name}.',
    'file.add_name': 'Add {name}.',
    'file.read_name': 'Read {name}',
    'file.write_name': 'Write {name}',
    'file.edit_name': 'Edit {name}',
    'file.activity_started': '{action} in progress · {summary}',
    'file.activity_completed': '{action} completed · {summary}',
    'diff.summary_test': 'Add or update regression tests.',
    'diff.summary_ui': 'Adjust UI logic and layout.',
    'diff.summary_docs': 'Update documentation.',
    'diff.summary_deps': 'Update dependencies or script config.',
    'diff.summary_evidence': 'Update runtime evidence and delivery state.',
    // bash
    'bash.view_pr': 'View PR #{pr}',
    'bash.view_pr_status': 'View PR status',
    'bash.git_status': 'Check Git status',
    'bash.run_tests': 'Run tests',
    'bash.and_then': ', then ',
    'bash.write_file': 'Write file',
    'bash.read_file': 'Read file',
    'bash.list_files': 'Check file list',
    'bash.write_path': 'Write {path}',
    'bash.read_path': 'Read {path}',
    // milestone
    'milestone.plan_formed': 'Plan formed, waiting for execution signal.',
    'milestone.need_confirm': 'Awaiting user confirmation.',
    'milestone.in_channel': 'In run channel, awaiting latest execution signal.',
    'milestone.ready_channel': 'Ready to enter run channel.',
    'milestone.issue_done': 'Issue completed, delivery closed.',
    'milestone.evidence_ok': 'Evidence satisfied, awaiting final delivery.',
    'milestone.review_qa': 'Review checking delivery quality.',
    'milestone.dev_advancing': 'Dev agent advancing current round.',
    // child
    'child.prefix': 'Child {n}',
    'child.queued': 'Queued',
    'child.pending': 'Pending',
    // hero action
    'hero.retry_submitted': 'Recovery action submitted.',
    'hero.retry_failed': 'Failed to submit recovery action.',
    'hero.retrying': 'Retrying…',
    'hero.pause_info': 'Pausing returns to Telegram for native confirmation.',
    'hero.request_info': 'Add a follow-up request in the Telegram chat.',
    // error
    'error.load_failed': 'Load failed · tap to retry',
    'error.unknown': 'Unknown error',
    'error.still_loading': 'Still loading… tap banner to retry',
    'error.no_history_log': 'No replayable log for this issue yet.',
    'error.no_replayable_log': 'No replayable log.',
    'error.cannot_load': 'Could not load this issue.',
    'error.cannot_load_tip': 'Reasons: server is offline, the issue id does not exist in this deployment, or the API is on a different origin. Tap the banner to retry, or open DevTools to inspect.',
    'label.unavailable': 'Unavailable',
    'label.event': 'Event',
    'label.milestone': 'Milestone',
    'label.recorded': 'Recorded',
    'label.checkpoint': 'Checkpoint',
    'label.log': 'Log',
    // orchestrator states
    'state.orchestrator_discovering': 'Discovering',
    'state.orchestrator_mapping': 'Mapping',
    'state.orchestrator_workspace_ready': 'Workspace ready',
    'state.orchestrator_dev_running': 'Dev running',
    'state.orchestrator_dev_post_processing': 'Dev finishing',
    'state.orchestrator_review_running': 'Review running',
    'state.orchestrator_review_post_processing': 'Review finishing',
    'state.orchestrator_needs_rework': 'Needs rework',
    'state.orchestrator_retry_scheduled': 'Retry scheduled',
    'state.orchestrator_halted': 'Halted',
    'state.orchestrator_completed': 'Completed',
    'state.orchestrator_cancelled': 'Cancelled',
    'state.orchestrator_failed': 'Failed',
  },
};

export function translateRuntimeMiniApp(
  locale: RuntimeMiniAppLocale,
  key: RuntimeMiniAppI18nKey,
  vars?: Record<string, string | number | null | undefined>,
): string {
  const dict = MINI_APP_I18N[locale] || MINI_APP_I18N.zh;
  const raw = dict[key] || MINI_APP_I18N.zh[key] || key;
  const safe = vars || {};
  // Step 1 — bracketed placeholders: strip the whole bracket pair when the variable is missing.
  let out = raw.replace(
    /([「『"《(\[])\{(\w+)\}([」』"》)\]])/g,
    (_match, open: string, name: string, close: string) => {
      const value = safe[name];
      return value != null && value !== '' ? `${open}${String(value)}${close}` : '';
    },
  );
  // Step 2 — bare placeholders: substitute or drop, preserving a single space if needed.
  out = out.replace(/\s*\{(\w+)\}\s*/g, (match, name: string) => {
    const value = safe[name];
    if (value != null && value !== '') {
      return match.replace(/\{\w+\}/, String(value));
    }
    return /^\s|\s$/.test(match) ? ' ' : '';
  });
  // Step 3 — clean orphaned whitespace and punctuation.
  return out
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([。，；：、])/g, '$1')
    .replace(/[，、]\s*[，、]/g, '，')
    .replace(/^[\s，、。；：]+|[\s，、；：]+$/g, '')
    .trim();
}

export interface RuntimeMiniAppActivityFeedItem {
  kind: 'tool' | 'file' | 'summary';
  label: string;
  summary: string;
  detail: string;
  timestamp: string | null;
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
  status: string;
}

export interface RuntimeMiniAppDiffFileItem {
  path: string;
  badge: 'M' | 'A' | 'D' | 'R';
  summary: string;
  detail?: string | null;
  timestamp: string | null;
  tone: 'green' | 'blue' | 'yellow' | 'red' | 'neutral';
  patch?: string | null;
}

export interface RuntimeMiniAppIssuePresentation {
  mode: 'live' | 'completed';
  progress: number;
  stateLabel: string;
  stateTone: 'green' | 'blue' | 'yellow';
  liveBadgeLabel: string;
  timelineTitle: string;
  judgmentSummary: string;
  nextRecommendation: string;
  roundGoal: string;
  riskDelta: string;
  planStatus: string;
  dispatchStatus: string;
  devStatus: string;
  reviewStatus: string;
  reviewDeliveryStatus: string;
  emptyChildQueueLabel: string;
  activityFeed: RuntimeMiniAppActivityFeedItem[];
  visibleMilestones: RuntimeMilestoneView[];
  diffFiles: RuntimeMiniAppDiffFileItem[];
}

function compactPlainText(value: string | null | undefined, maxLength = 520): string {
  const normalized = String(value || '')
    .replace(/\r\n/g, '\n')
    .replace(/[ \t\v\f\r]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!normalized) {
    return '';
  }
  return normalized.length <= maxLength
    ? normalized
    : `${normalized.slice(0, maxLength - 1).trim()}…`;
}

function parseRuntimeJsonSummary(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!/^[{[]/.test(trimmed)) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

export function normalizeRuntimeMiniAppSummary(
  value: string | null | undefined,
  fallback = '',
  maxLength = 520,
): string {
  const raw = String(value || '').trim();
  const parsed = parseRuntimeJsonSummary(raw);
  if (parsed) {
    const toolName = typeof parsed.tool_name === 'string' ? titleCaseToolName(parsed.tool_name) : null;
    const code = typeof parsed.code === 'string' ? parsed.code : '';
    const message = typeof parsed.message === 'string' ? parsed.message : '';
    if (toolName) {
      if (code === 'tool_started' || /^using\s+/i.test(message)) {
        return `${toolName} 正在运行`;
      }
      if (code === 'tool_completed') {
        return `${toolName} 完成`;
      }
      return `${toolName} ${code ? code.replace(/^tool_/, '') : '活动'}`;
    }
    if (message) {
      return compactPlainText(message, maxLength);
    }
  }
  return compactPlainText(raw || fallback, maxLength);
}

function compactText(value: string | null | undefined, maxLength = 520): string {
  return normalizeRuntimeMiniAppSummary(value, '', maxLength);
}

function isRetryableRuntimeMiniAppFailure(issue: RuntimeIssueView): boolean {
  return Boolean(
    issue.actions?.can_retry &&
    (issue.delivery_state === 'delivery_failed' || issue.delivery_code || issue.orchestrator_state === 'failed'),
  );
}

export function isRuntimeMiniAppIssueCompleted(issue: RuntimeIssueView): boolean {
  return issue.delivery_state === 'completed' ||
    issue.orchestrator_state === 'completed' ||
    /^(done|completed)$/i.test(issue.tracker_state || '') ||
    issue.supervisor_session_state === 'completed';
}

function isInternalRuntimeMiniAppMilestone(milestone: RuntimeMilestoneView): boolean {
  if (milestone.kind !== 'delivery_failed') {
    return false;
  }
  return /supervisor_turn_budget_exhausted|turn_budget_exhausted/i.test([
    milestone.key,
    milestone.summary,
  ].join('\n'));
}

export function visibleRuntimeMiniAppMilestones(issue: RuntimeIssueView): RuntimeMilestoneView[] {
  return (issue.milestones ?? [])
    .filter((milestone) => !isInternalRuntimeMiniAppMilestone(milestone))
    .map((milestone) => ({
      ...milestone,
      summary: normalizeRuntimeMiniAppSummary(milestone.summary, milestone.key, 180),
    }))
    .slice(0, 5);
}

function milestone(
  issue: RuntimeIssueView,
  kind: string,
  summary: string,
  timestamp: string | null = issue.updated_at || issue.created_at,
): RuntimeMilestoneView {
  return {
    kind,
    key: `miniapp:${issue.issue_id}:${kind}:${timestamp ?? ''}`,
    summary,
    timestamp,
  };
}

export function buildRuntimeMiniAppMilestones(issue: RuntimeIssueView): RuntimeMilestoneView[] {
  const visible = visibleRuntimeMiniAppMilestones(issue);
  if (visible.length > 0) {
    return visible;
  }

  const items: RuntimeMilestoneView[] = [
    milestone(
      issue,
      'plan_ready',
      compactText(issue.supervisor_plan_summary || issue.title, 160) || '计划已形成，等待执行信号。',
      issue.created_at,
    ),
  ];

  if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
    items.push(milestone(
      issue,
      'needs_decision',
      compactText(issue.next_recommended_action || issue.governance_summary, 180) || '当前需要用户确认下一步。',
    ));
  } else {
    items.push(milestone(
      issue,
      'dispatch_ready',
      issue.session || issue.orchestrator_state
        ? '已进入运行通道，等待最近执行信号刷新。'
        : '已准备进入运行通道。',
    ));
  }

  if (isRuntimeMiniAppIssueCompleted(issue)) {
    items.push(milestone(
      issue,
      'delivery_completed',
      compactText(issue.delivery_summary, 180) || 'Issue 已完成，最终交付已闭环。',
    ));
  } else if (issue.delivery_state === 'proof_satisfied') {
    items.push(milestone(
      issue,
      'proof_satisfied',
      compactText(issue.delivery_summary, 180) || '证据已满足，正在等待最终交付。',
    ));
  } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
    items.push(milestone(
      issue,
      'review_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || 'Review 正在检查交付质量。',
      issue.session?.last_event_at || issue.updated_at,
    ));
  } else if (issue.session || issue.orchestrator_state === 'dev_running') {
    items.push(milestone(
      issue,
      'dev_running',
      compactText(issue.session?.last_message || issue.next_recommended_action, 180) || 'Dev agent 正在推进当前轮次。',
      issue.session?.last_event_at || issue.updated_at,
    ));
  }

  return items.slice(0, 5);
}

function diffBadgeForFile(file: RuntimeFileActivity): RuntimeMiniAppDiffFileItem['badge'] {
  if (file.operation === 'write') {
    return 'A';
  }
  return 'M';
}

function stripShellNoise(value: string): string {
  return value
    .replace(/\s+2>\s*\/dev\/null/g, '')
    .replace(/\s+1>\s*\/dev\/null/g, '')
    .replace(/\s+>\s*\/dev\/null/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function shortWorkspacePath(path: string | null | undefined): string {
  const normalized = String(path || '')
    .replace(/^['"]|['"]$/g, '')
    .trim();
  if (!normalized) {
    return '';
  }
  const worktreeMatch = normalized.match(/\/worktrees\/[^/\s"']+\/(.+)$/);
  if (worktreeMatch?.[1]) {
    return worktreeMatch[1];
  }
  const workspaceMatch = normalized.match(/\/workspaces\/[^/\s"']+\/(.+)$/);
  if (workspaceMatch?.[1]) {
    return workspaceMatch[1];
  }
  const projectMatch = normalized.match(/\/test-cc\/(.+)$/);
  if (projectMatch?.[1]) {
    return projectMatch[1];
  }
  if (!normalized.startsWith('/')) {
    return normalized;
  }
  return basename(normalized);
}

function readablePath(path: string | null | undefined): string {
  return shortWorkspacePath(path) || basename(path) || 'workspace';
}

function fileDisplayName(path: string | null | undefined): string {
  return basename(shortWorkspacePath(path) || path) || 'workspace';
}

function parentFolder(path: string | null | undefined): string {
  const shortened = shortWorkspacePath(path);
  const parts = shortened.split('/').filter(Boolean);
  if (parts.length <= 1) {
    return '';
  }
  return parts.slice(0, -1).join('/');
}

function humanFileOperation(operation: RuntimeFileActivity['operation'] | string | null | undefined): string {
  if (operation === 'read') return '读取';
  if (operation === 'write') return '写入';
  if (operation === 'edit') return '编辑';
  return '文件活动';
}

function summarizeDiffPath(path: string, fallback: string): string {
  const displayPath = readablePath(path);
  const name = fileDisplayName(displayPath);
  const lower = displayPath.toLowerCase();
  if (/\.test\.|\.spec\.|__tests__|test\//.test(lower)) {
    return '补充或更新回归测试。';
  }
  if (/miniapp|page|style|css|tsx?$|jsx?$/.test(lower)) {
    return '调整界面展示逻辑与排版。';
  }
  if (/readme|docs?|\.md$/.test(lower)) {
    return '更新文档说明。';
  }
  if (/package|bun\.lock|lockfile/.test(lower)) {
    return '更新依赖或脚本配置。';
  }
  if (/\.symphony|state|evidence|handover/.test(lower)) {
    return '更新运行证据与交付状态。';
  }
  if (fallback) {
    return compactText(fallback, 90);
  }
  return `更新 ${name}。`;
}

export function buildRuntimeMiniAppDiffFiles(issue: RuntimeIssueView): RuntimeMiniAppDiffFileItem[] {
  const byPath = new Map<string, RuntimeMiniAppDiffFileItem>();
  const overview = compactText(issue.change_pack_summary?.overview, 90);

  for (const path of issue.change_pack_summary?.files ?? []) {
    const normalized = readablePath(path);
    if (!normalized) {
      continue;
    }
    byPath.set(normalized, {
      path: normalized,
      badge: 'M',
      summary: summarizeDiffPath(normalized, overview),
      detail: overview || null,
      timestamp: null,
      tone: 'blue',
    });
  }

  for (const file of issue.session?.recent_files ?? []) {
    if (file.operation === 'read') {
      continue;
    }
    const normalized = readablePath(file.path);
    if (!normalized) {
      continue;
    }
    const item: RuntimeMiniAppDiffFileItem = {
      path: normalized,
      badge: diffBadgeForFile(file),
      summary: `${humanFileOperation(file.operation)}${file.status === 'started' ? '中' : '完成'} · ${summarizeDiffPath(normalized, overview)}`,
      detail: overview || null,
      timestamp: file.timestamp,
      tone: feedToneFromStatus(file.status),
    };
    if (file.patch) {
      item.patch = file.patch;
    }
    byPath.set(normalized, item);
  }

  const items = [...byPath.values()]
    .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
    .slice(0, 8);

  const workspacePath = issue.workspace_path;
  if (workspacePath) {
    for (const item of items) {
      if (item.patch) continue;
      try {
        const diff = cp.execSync(
          `git -C "${workspacePath}" diff -- "${item.path}"`,
          { timeout: 3000, maxBuffer: 256 * 1024, encoding: 'utf-8' },
        ).trim();
        if (diff) {
          item.patch = diff;
        }
      } catch {
        // skip — no diff available for this file
      }
    }
  }

  return items;
}

function titleCaseToolName(toolName: string): string {
  const lower = toolName.toLowerCase();
  if (/bash|shell|terminal|exec/.test(lower)) {
    return 'Bash';
  }
  if (/read|open|cat/.test(lower)) {
    return 'Read';
  }
  if (/edit|patch|apply|write/.test(lower)) {
    return 'Edit';
  }
  if (/test|pytest|bun|vitest|jest/.test(lower)) {
    return 'Test';
  }
  if (/git|github|pr/.test(lower)) {
    return 'Git';
  }
  if (/review/.test(lower)) {
    return 'Review';
  }
  const compact = toolName.replace(/[_-]+/g, ' ').trim();
  return compact ? compact.slice(0, 1).toUpperCase() + compact.slice(1) : 'Tool';
}

function basename(path: string | null | undefined): string {
  const normalized = String(path || '').trim();
  if (!normalized) {
    return '';
  }
  return normalized.split('/').filter(Boolean).at(-1) || normalized;
}

function summarizeShellCommand(value: string, label = 'Bash'): string {
  if (/^\s*[{[]/.test(value)) {
    return normalizeRuntimeMiniAppSummary(value, `${label} 运行中`, 72);
  }
  const command = stripShellNoise(value);
  const lower = command.toLowerCase();
  const pathCandidate = command.match(/(?:cat|sed|awk|tail|head|less|open|code)\s+(?:-[^\s]+\s+)*["']?([^"'\s<>|;&]+)["']?/i)?.[1]
    || command.match(/>\s*["']?([^"'\s<>|;&]+)["']?/)?.[1];
  const path = pathCandidate ? fileDisplayName(pathCandidate) : '';
  if (/gh\s+pr\s+view/i.test(command)) {
    const pr = command.match(/gh\s+pr\s+view\s+(\d+)/i)?.[1];
    return pr ? `查看 PR #${pr}` : '查看 PR 状态';
  }
  if (/git\s+status|git\s+log/i.test(command)) {
    return '检查 Git 状态';
  }
  if (/bun\s+test|npm\s+test|pnpm\s+test|pytest|vitest|jest/i.test(command)) {
    return '运行测试';
  }
  if (/\brm\s+-rf\b|\bdelete\b|删除/.test(lower)) {
    return compactText(command.replace(/\s*&&\s*/g, '，然后 '), 72);
  }
  if (/^cat\s*>|>\s*["']?[^"'\s]+/.test(command)) {
    return path ? `写入 ${path}` : '写入文件';
  }
  if (/^(cat|sed|awk|tail|head|less)\b/.test(command)) {
    return path ? `读取 ${path}` : '读取文件';
  }
  if (/^(ls|find|tree)\b/.test(command)) {
    return '检查文件列表';
  }
  if (!command || /^using\s+/i.test(command)) {
    return `${label} 运行中`;
  }
  return compactText(command.replace(/\/Users\/[^\s"']+/g, (match) => fileDisplayName(match)), 72);
}

function summarizeToolActivity(tool: RuntimeToolActivity, label: string): string {
  if (label === 'Bash') {
    return summarizeShellCommand(tool.message || tool.summary || '', label);
  }
  const path = fileDisplayName(tool.path);
  if (label === 'Read') {
    return path ? `读取 ${path}` : compactText(tool.summary || tool.message || '读取文件', 72);
  }
  if (label === 'Edit') {
    return path ? `编辑 ${path}` : compactText(tool.summary || tool.message || '编辑文件', 72);
  }
  return compactText(tool.summary || tool.message || `${label} running`, 72);
}

function feedToneFromStatus(status: string | null | undefined): RuntimeMiniAppActivityFeedItem['tone'] {
  if (status === 'failed') {
    return 'red';
  }
  if (status === 'started') {
    return 'blue';
  }
  if (status === 'completed') {
    return 'green';
  }
  return 'neutral';
}

function feedItemFromTool(tool: RuntimeToolActivity): RuntimeMiniAppActivityFeedItem {
  const label = titleCaseToolName(tool.tool_name);
  const detailPath = readablePath(tool.path);
  const detail = detailPath || (tool.status === 'started' ? `${label} running` : `${label} completed`);
  const summary = summarizeToolActivity(tool, label);
  return {
    kind: 'tool',
    label,
    summary,
    detail,
    timestamp: tool.timestamp,
    tone: feedToneFromStatus(tool.status),
    status: tool.status,
  };
}

function feedItemFromFile(file: RuntimeFileActivity): RuntimeMiniAppActivityFeedItem {
  const label = file.operation === 'read'
    ? 'Read'
    : file.operation === 'write'
      ? 'Write'
      : file.operation === 'edit'
        ? 'Edit'
        : 'File';
  const fileName = basename(file.path) || 'workspace';
  const displayName = fileDisplayName(file.path) || fileName;
  const folder = parentFolder(file.path);
  return {
    kind: 'file',
    label,
    summary: `${humanFileOperation(file.operation)} ${displayName}`,
    detail: [humanFileOperation(file.operation), folder].filter(Boolean).join(' · '),
    timestamp: file.timestamp,
    tone: feedToneFromStatus(file.status),
    status: file.status,
  };
}

function activityDedupeKey(item: RuntimeMiniAppActivityFeedItem): string {
  return [
    item.kind,
    item.label,
    compactText(item.summary.toLowerCase(), 80),
  ].join('|');
}

export function buildRuntimeMiniAppActivityFeed(issue: RuntimeIssueView): RuntimeMiniAppActivityFeedItem[] {
  if (isRuntimeMiniAppIssueCompleted(issue)) {
    const completedAt = issue.updated_at || issue.created_at;
    const summary = compactText(issue.delivery_summary, 180);
    return [{
      kind: 'summary',
      label: 'Closed',
      summary: summary || 'Issue 已完成，最终交付已闭环。',
      detail: issue.active_pr_number ? `PR #${issue.active_pr_number}` : issue.github_repo || issue.identifier,
      timestamp: completedAt,
      tone: 'green',
      status: 'completed',
    }];
  }

  const tools = issue.session?.recent_tools ?? [];
  const files = issue.session?.recent_files ?? [];
  const sorted = [
    ...tools.map(feedItemFromTool),
    ...files.map(feedItemFromFile),
  ]
    .sort((left, right) => {
      const leftStarted = left.status === 'started' ? 1 : 0;
      const rightStarted = right.status === 'started' ? 1 : 0;
      if (leftStarted !== rightStarted) {
        return rightStarted - leftStarted;
      }
      return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
    });
  const seen = new Set<string>();
  const compacted: RuntimeMiniAppActivityFeedItem[] = [];
  for (const item of sorted) {
    const key = activityDedupeKey(item);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    compacted.push(item);
  }
  return compacted.slice(0, 6);
}

function orchStateToI18nKey(state: string | null | undefined): string | null {
  if (!state) return null;
  switch (state) {
    case 'discovering': return 'state.orchestrator_discovering';
    case 'mapping': return 'state.orchestrator_mapping';
    case 'workspace_ready': return 'state.orchestrator_workspace_ready';
    case 'dev_running': return 'state.orchestrator_dev_running';
    case 'dev_post_processing': return 'state.orchestrator_dev_post_processing';
    case 'review_running': return 'state.orchestrator_review_running';
    case 'review_post_processing': return 'state.orchestrator_review_post_processing';
    case 'needs_rework': return 'state.orchestrator_needs_rework';
    case 'retry_scheduled': return 'state.orchestrator_retry_scheduled';
    case 'halted': return 'state.orchestrator_halted';
    case 'completed': return 'state.orchestrator_completed';
    case 'cancelled': return 'state.orchestrator_cancelled';
    case 'failed': return 'state.orchestrator_failed';
    default: return state;
  }
}

export function buildRuntimeMiniAppIssuePresentation(issue: RuntimeIssueView): RuntimeMiniAppIssuePresentation {
  const completed = isRuntimeMiniAppIssueCompleted(issue);
  const retryableFailure = isRetryableRuntimeMiniAppFailure(issue);
  const deliverySummary = normalizeRuntimeMiniAppSummary(issue.delivery_summary, '', 4000);
  const reviewApproved = issue.milestones?.some((milestone) => milestone.kind === 'review_completed') ?? false;
  if (completed) {
    return {
      mode: 'completed',
      progress: 100,
      stateLabel: 'label.completed',
      stateTone: 'green',
      liveBadgeLabel: 'label.final',
      timelineTitle: 'title.delivery_summary',
      judgmentSummary: deliverySummary || 'copy.delivery_closed',
      nextRecommendation: issue.active_pr_number
        ? 'copy.completed_pr'
        : 'copy.completed_no_pr',
      roundGoal: 'copy.round_goal_done',
      riskDelta: compactText(issue.riskDelta || issue.risk_delta, 180) || 'copy.risk_stable',
      planStatus: 'state.completed',
      dispatchStatus: 'state.completed',
      devStatus: 'state.completed',
      reviewStatus: 'state.completed',
      reviewDeliveryStatus: reviewApproved ? 'state.approved' : 'state.completed',
      emptyChildQueueLabel: 'copy.single_issue_done',
      activityFeed: buildRuntimeMiniAppActivityFeed(issue),
      visibleMilestones: buildRuntimeMiniAppMilestones(issue),
      diffFiles: buildRuntimeMiniAppDiffFiles(issue),
    };
  }

  const progress = issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running'
    ? 72
    : issue.session || issue.orchestrator_state === 'dev_running'
      ? 42
      : issue.governance_thread_state === 'waiting_on_child'
        ? 34
        : 18;
  return {
    mode: 'live',
    progress: retryableFailure ? Math.max(progress, 82) : progress,
    stateLabel: issue.delivery_state === 'proof_satisfied'
      ? 'label.proof_satisfied'
      : retryableFailure
        ? 'label.needs_recovery'
        : (orchStateToI18nKey(issue.orchestrator_state) || orchStateToI18nKey(issue.tracker_state) || 'label.running'),
    stateTone: issue.delivery_state === 'proof_satisfied'
      ? 'green'
      : retryableFailure
        ? 'yellow'
        : 'blue',
    liveBadgeLabel: retryableFailure ? 'label.action' : 'label.live',
    timelineTitle: 'title.live_stream',
    judgmentSummary: normalizeRuntimeMiniAppSummary(
      issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
      '',
      4000,
    ) || 'copy.judgment_advancing',
    nextRecommendation: retryableFailure
      ? 'copy.recovery_stuck'
      : normalizeRuntimeMiniAppSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000) || 'copy.waiting_supervisor',
    roundGoal: normalizeRuntimeMiniAppSummary(issue.roundGoal || issue.round?.goal || issue.next_recommended_action, '', 4000) || 'copy.waiting_signal',
    riskDelta: normalizeRuntimeMiniAppSummary(issue.riskDelta || issue.risk_delta, '', 4000) || 'copy.risk_stable',
    planStatus: 'state.completed',
    dispatchStatus: progress >= 30 ? 'state.completed' : 'state.waiting',
    devStatus: progress >= 100 ? 'state.completed' : 'state.running',
    reviewStatus: progress >= 78 ? 'state.running' : 'state.awaiting_review',
    reviewDeliveryStatus: issue.phase === 'REVIEW' ? 'state.running' : 'state.awaiting_review',
    emptyChildQueueLabel: 'copy.single_issue_no_split',
    activityFeed: buildRuntimeMiniAppActivityFeed(issue),
    visibleMilestones: buildRuntimeMiniAppMilestones(issue),
    diffFiles: buildRuntimeMiniAppDiffFiles(issue),
  };
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function renderRuntimeMiniAppPage(issueId: string): string {
  const encodedIssueId = encodeURIComponent(issueId);
  const escapedIssueId = escapeHtml(issueId);
  // Cache-busting + visible build stamp so users can verify Telegram is showing the latest HTML.
  // Telegram's WebView aggressively caches mini app HTML by URL; the timestamp parameter forces
  // a fresh document on every open and the visible stamp surfaces the version in the UI.
  const buildStamp = new Date().toISOString();
  const issueApi = `/api/v1/runtime/issues/${encodedIssueId}`;
  const timelineApi = `/api/v1/runtime/issues/${encodedIssueId}/timeline`;
  const historyApi = `/api/v1/runtime/issues/${encodedIssueId}/history`;

  return `<!doctype html>
<html lang="zh-CN" data-build="${buildStamp}">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="color-scheme" content="dark" />
    <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate" />
    <meta http-equiv="Pragma" content="no-cache" />
    <meta http-equiv="Expires" content="0" />
    <title>symphonyness issue cockpit · ${escapedIssueId}</title>
    <link rel="preconnect" href="https://fonts.googleapis.com" />
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
    <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,400;0,14..32,500;0,14..32,600;1,14..32,400;1,14..32,500&display=swap" />
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root,
      :root[data-theme="dark"] {
        --bg: #061018;
        --bg-grad-1: rgba(86, 227, 159, 0.16);
        --bg-grad-2: rgba(107, 180, 255, 0.16);
        --bg-grad-3: #08131d;
        --bg-grad-4: #040b12;
        --panel: rgba(12, 22, 34, 0.9);
        --panel-strong: rgba(15, 29, 43, 0.98);
        --panel-grad-1: rgba(17, 31, 45, 0.92);
        --panel-grad-2: rgba(8, 17, 27, 0.92);
        --panel-shadow: 0 18px 46px rgba(0, 0, 0, 0.24);
        --line: rgba(156, 179, 204, 0.18);
        --line-strong: rgba(156, 179, 204, 0.28);
        --ink: #f3f7fb;
        --muted: #94a7ba;
        --soft: #c9d5e1;
        --green: #56e39f;
        --green-soft: rgba(86, 227, 159, 0.14);
        --blue: #6bb4ff;
        --blue-soft: rgba(107, 180, 255, 0.15);
        --purple: #b69bff;
        --purple-soft: rgba(182, 155, 255, 0.16);
        --teal: #5ad6c8;
        --teal-soft: rgba(90, 214, 200, 0.16);
        --orange: #ffb077;
        --orange-soft: rgba(255, 176, 119, 0.16);
        --yellow: #ffd166;
        --yellow-soft: rgba(255, 209, 102, 0.14);
        --red: #ff7b7b;
        --red-soft: rgba(255, 123, 123, 0.15);
        --soft-fill: rgba(255, 255, 255, 0.045);
        --soft-fill-strong: rgba(255, 255, 255, 0.07);
        --tab-active: linear-gradient(140deg, rgba(86, 227, 159, 0.16), rgba(107, 180, 255, 0.14));
        --action-bg: linear-gradient(180deg, rgba(6, 16, 24, 0) 0%, rgba(6, 16, 24, 0.92) 30%, rgba(6, 16, 24, 0.96));
      }
      :root[data-theme="light"] {
        --bg: #f7f9fc;
        --bg-grad-1: rgba(58, 178, 124, 0.10);
        --bg-grad-2: rgba(56, 124, 220, 0.10);
        --bg-grad-3: #ffffff;
        --bg-grad-4: #eef2f7;
        --panel: rgba(255, 255, 255, 0.92);
        --panel-strong: rgba(255, 255, 255, 0.98);
        --panel-grad-1: rgba(255, 255, 255, 0.94);
        --panel-grad-2: rgba(247, 249, 252, 0.92);
        --panel-shadow: 0 14px 36px rgba(15, 32, 56, 0.08);
        --line: rgba(40, 60, 90, 0.10);
        --line-strong: rgba(40, 60, 90, 0.18);
        --ink: #14202e;
        --muted: #5e6e80;
        --soft: #2d3a48;
        --green: #1f9d6e;
        --green-soft: rgba(31, 157, 110, 0.10);
        --blue: #2c7be5;
        --blue-soft: rgba(44, 123, 229, 0.10);
        --purple: #6c4ad6;
        --purple-soft: rgba(108, 74, 214, 0.10);
        --teal: #109a8a;
        --teal-soft: rgba(16, 154, 138, 0.10);
        --orange: #c46a16;
        --orange-soft: rgba(196, 106, 22, 0.10);
        --yellow: #c98b00;
        --yellow-soft: rgba(255, 198, 0, 0.12);
        --red: #d24a4a;
        --red-soft: rgba(210, 74, 74, 0.10);
        --soft-fill: rgba(40, 60, 90, 0.04);
        --soft-fill-strong: rgba(40, 60, 90, 0.07);
        --tab-active: linear-gradient(140deg, rgba(31, 157, 110, 0.13), rgba(44, 123, 229, 0.12));
        --action-bg: linear-gradient(180deg, rgba(247, 249, 252, 0) 0%, rgba(247, 249, 252, 0.94) 30%, rgba(247, 249, 252, 0.98));
      }

      * { box-sizing: border-box; }
      html { min-height: 100%; background: var(--bg); }
      body {
        margin: 0;
        min-height: 100vh;
        color: var(--ink);
        font-family: "Inter", -apple-system, BlinkMacSystemFont, "SF Pro Display", "PingFang SC", "Segoe UI", sans-serif;
        background:
          radial-gradient(circle at 82% 8%, var(--bg-grad-1), transparent 24%),
          radial-gradient(circle at 8% 18%, var(--bg-grad-2), transparent 28%),
          linear-gradient(180deg, var(--bg-grad-3) 0%, var(--bg-grad-4) 100%);
      }

      button { font: inherit; border: 0; }
      .shell {
        width: min(100%, 1080px);
        min-height: 100vh;
        margin: 0 auto;
        padding: calc(14px + env(safe-area-inset-top)) 12px calc(18px + env(safe-area-inset-bottom));
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 10;
        display: grid;
        grid-template-columns: 74px minmax(0, 1fr) 42px;
        align-items: center;
        gap: 10px;
        margin: -2px -2px 12px;
        padding: 10px 2px 12px;
        background: linear-gradient(180deg, rgba(6, 16, 24, 0.96), rgba(6, 16, 24, 0.72));
        backdrop-filter: blur(18px);
      }
      .topbar button {
        min-height: 38px;
        color: var(--blue);
        background: transparent;
        text-align: left;
        cursor: pointer;
      }
      .app-title {
        min-width: 0;
        text-align: center;
      }
      .app-title strong {
        display: block;
        overflow: hidden;
        color: var(--ink);
        font-size: 18px;
        line-height: 1.15;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .app-title span {
        color: var(--muted);
        font-size: 12px;
      }
      .hero {
        display: grid;
        grid-template-columns: minmax(0, 1fr) 112px;
        gap: 12px;
        align-items: center;
        padding: 16px 10px 15px;
      }
      .hero > div:first-child {
        min-width: 0;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 10px;
        margin-bottom: 14px;
        color: var(--ink);
        font-weight: 460;
        font-size: 18px;
        letter-spacing: -0.005em;
      }
      .wave {
        width: 42px;
        height: 30px;
      }
      .issue-title {
        margin: 0 0 10px;
        font-family: "Inter", "SF Pro Display", "Helvetica Neue", "PingFang SC", sans-serif;
        font-size: clamp(22px, 5.2vw, 30px);
        line-height: 1.22;
        font-weight: 280;
        letter-spacing: -0.012em;
        color: var(--ink);
        overflow-wrap: anywhere;
      }
      .issue-title .issue-id {
        display: inline-block;
        margin-right: 6px;
        padding: 2px 8px;
        border: 1px solid var(--line-strong);
        border-radius: 6px;
        color: var(--soft);
        font-size: 0.62em;
        font-weight: 520;
        letter-spacing: 0.04em;
        vertical-align: middle;
        transform: translateY(-3px);
      }
      .repo-line,
      .status-line {
        display: flex;
        min-width: 0;
        flex-wrap: wrap;
        align-items: center;
        gap: 8px;
        margin-top: 8px;
        color: var(--soft);
        font-size: 14px;
      }
      .github-mark {
        width: 18px;
        height: 18px;
        flex: 0 0 auto;
        color: var(--ink);
      }
      .repo-name {
        min-width: 0;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
        font-weight: 460;
      }
      .chip {
        display: inline-flex;
        min-height: 28px;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border: 1px solid var(--line);
        border-radius: 9px;
        background: var(--soft-fill);
        color: var(--soft);
        font-size: 12px;
        font-weight: 440;
        letter-spacing: 0.01em;
      }
      .chip.green { color: var(--green); background: var(--green-soft); border-color: rgba(86, 227, 159, 0.2); }
      .chip.blue { color: var(--blue); background: var(--blue-soft); border-color: rgba(107, 180, 255, 0.22); }
      .chip.yellow { color: var(--yellow); background: var(--yellow-soft); border-color: rgba(255, 209, 102, 0.22); }
      .ring {
        position: relative;
        width: 108px;
        aspect-ratio: 1;
        display: grid;
        place-items: center;
        border-radius: 50%;
        background: conic-gradient(var(--green) var(--progress), var(--blue) calc(var(--progress) + 22deg), var(--soft-fill-strong) 0);
      }
      .ring::before {
        content: "";
        position: absolute;
        inset: 10px;
        border-radius: 50%;
        background: var(--bg);
        box-shadow: inset 0 0 0 1px var(--line);
      }
      .ring-content {
        position: relative;
        text-align: center;
      }
      .ring-content strong {
        display: block;
        font-size: 26px;
        font-weight: 320;
        line-height: 1;
        letter-spacing: -0.02em;
        font-variant-numeric: tabular-nums;
      }
      .ring-content span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        font-weight: 420;
        letter-spacing: 0.02em;
      }
      .judgment {
        display: grid;
        grid-template-columns: minmax(0, 1fr);
        gap: 10px;
        margin: 4px 0 14px;
      }
      .panel {
        border: 1px solid var(--line);
        border-radius: 12px;
        background: linear-gradient(145deg, var(--panel-grad-1), var(--panel-grad-2));
        box-shadow: var(--panel-shadow);
      }
      .panel.pad { padding: 15px; }
      .panel-title {
        margin: 0 0 10px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        color: var(--ink);
        font-size: 15px;
        line-height: 1.3;
        font-weight: 480;
        letter-spacing: -0.005em;
      }
      .panel-copy {
        margin: 0;
        color: var(--soft);
        font-size: 14px;
        line-height: 1.55;
      }
      .stage-row {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 0;
        overflow: hidden;
      }
      .stage {
        min-width: 0;
        padding: 14px 10px 16px;
        border-right: 1px solid var(--line);
      }
      .stage:last-child { border-right: 0; }
      .stage strong {
        display: block;
        color: var(--ink);
        font-size: 13px;
        line-height: 1.2;
        font-weight: 480;
        letter-spacing: -0.005em;
      }
      .stage span {
        display: block;
        margin-top: 5px;
        color: var(--muted);
        font-size: 12px;
      }
      .stage-meter {
        position: relative;
        height: 3px;
        margin-top: 15px;
        border-radius: 999px;
        background: var(--line-strong);
      }
      .stage-meter i {
        display: block;
        width: var(--value);
        height: 100%;
        border-radius: inherit;
        background: var(--tone);
      }
      .layout {
        display: grid;
        gap: 14px;
      }
      .timeline {
        position: relative;
        display: grid;
        gap: 14px;
        margin-top: 8px;
      }
      .timeline::before {
        content: "";
        position: absolute;
        top: 18px;
        bottom: 10px;
        left: 78px;
        width: 2px;
        border-radius: 999px;
        background: linear-gradient(180deg, rgba(86, 227, 159, 0.45), rgba(107, 180, 255, 0.22), transparent);
      }
      .event {
        position: relative;
        z-index: 1;
        display: grid;
        grid-template-columns: 62px 22px minmax(0, 1fr) minmax(42px, max-content);
        gap: 8px;
        align-items: start;
      }
      .event-time {
        color: var(--soft);
        font-size: 12px;
        font-weight: 440;
        font-variant-numeric: tabular-nums;
      }
      .event-node {
        display: block;
        margin-top: 3px;
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: var(--green);
        box-shadow: 0 0 0 6px rgba(86, 227, 159, 0.12);
      }
      .event-node.blue { background: var(--blue); box-shadow: 0 0 0 6px rgba(107, 180, 255, 0.12); }
      .event-node.yellow { background: var(--yellow); box-shadow: 0 0 0 6px rgba(255, 209, 102, 0.12); }
      .event-node.red { background: var(--red); box-shadow: 0 0 0 6px rgba(255, 123, 123, 0.12); }
      .event-node.neutral { background: var(--muted); box-shadow: 0 0 0 6px rgba(148, 167, 186, 0.11); }
      .event h3 {
        margin: 0;
        min-width: 0;
        font-size: 13.5px;
        line-height: 1.32;
        font-weight: 460;
        letter-spacing: -0.005em;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .event p {
        margin: 4px 0 0;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event > div { min-width: 0; }
      .file-row,
      .agent-row,
      .milestone-row,
      .diff-row,
      .delivery-row,
      .child-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 0;
        border-top: 1px solid rgba(156, 179, 204, 0.12);
      }
      .file-row > div,
      .agent-row > div,
      .milestone-row > div,
      .diff-row > div,
      .delivery-row > div,
      .child-row > div {
        min-width: 0;
      }
      .file-row:first-of-type,
      .agent-row:first-of-type,
      .milestone-row:first-of-type,
      .diff-row:first-of-type,
      .delivery-row:first-of-type,
      .child-row:first-of-type {
        border-top: 0;
      }
      .file-row strong,
      .agent-row strong,
      .milestone-row strong,
      .diff-row strong,
      .delivery-row strong,
      .child-row strong {
        display: block;
        overflow: hidden;
        font-size: 13px;
        line-height: 1.35;
        font-weight: 480;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      .file-row span,
      .agent-row span,
      .milestone-row span,
      .diff-row span,
      .delivery-row span,
      .child-row span {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.42;
      }
      .agent-row span,
      .milestone-row span {
        white-space: normal;
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      .diff-row {
        align-items: start;
      }
      .diff-row strong {
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        color: var(--ink);
      }
      .diff-row span {
        line-height: 1.45;
      }
      .expandable-copy {
        display: block;
        min-width: 0;
      }
      .expandable-text {
        display: block;
        overflow-wrap: anywhere;
        word-break: break-word;
        white-space: pre-wrap;
      }
      .expand-button {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        margin-top: 7px;
        padding: 4px 9px;
        border: 1px solid rgba(107, 180, 255, 0.26);
        border-radius: 8px;
        color: var(--blue);
        background: rgba(107, 180, 255, 0.11);
        cursor: pointer;
        font-size: 12px;
        font-weight: 460;
        line-height: 1.1;
      }
      .diff-detail {
        display: block;
        margin-top: 7px;
        padding-left: 10px;
        border-left: 2px solid rgba(107, 180, 255, 0.22);
        color: var(--soft);
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11px;
        line-height: 1.48;
        overflow-wrap: anywhere;
        word-break: break-word;
        white-space: normal;
      }
      .diff-stat {
        min-width: 34px;
        padding: 5px 8px;
        border-radius: 8px;
        color: var(--green);
        background: rgba(86, 227, 159, 0.12);
        text-align: center;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 12px;
        font-weight: 580;
      }
      .diff-stat.blue { color: var(--blue); background: var(--blue-soft); }
      .diff-stat.yellow { color: var(--yellow); background: var(--yellow-soft); }
      .diff-stat.red { color: #ffd1d1; background: var(--red-soft); }
      .mini-badge {
        min-width: 32px;
        max-width: 72px;
        padding: 4px 8px;
        border-radius: 8px;
        color: var(--green);
        background: var(--green-soft);
        text-align: center;
        font-size: 11px;
        font-weight: 480;
        letter-spacing: 0.02em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .mini-badge.blue { color: var(--blue); background: var(--blue-soft); }
      .mini-badge.yellow { color: var(--yellow); background: var(--yellow-soft); }
      .mini-badge.red { color: #ffd1d1; background: var(--red-soft); }
      .mini-badge.neutral { color: var(--soft); background: var(--soft-fill-strong); }
      .event .mini-badge { justify-self: end; }
      .history-panel {
        margin-top: 14px;
      }
      .history-panel[hidden] {
        display: none;
      }
      .panel-title .text-button {
        min-height: 28px;
        padding: 4px 9px;
        border: 1px solid var(--line);
        border-radius: 8px;
        color: var(--blue);
        background: rgba(107, 180, 255, 0.1);
        cursor: pointer;
        font-size: 12px;
        font-weight: 440;
      }
      .history-entry {
        display: grid;
        grid-template-columns: 76px minmax(0, 1fr) minmax(42px, max-content);
        gap: 10px;
        align-items: start;
        padding: 12px 0;
        border-top: 1px solid rgba(156, 179, 204, 0.12);
      }
      .history-entry:first-of-type {
        border-top: 0;
      }
      .history-entry time {
        color: var(--muted);
        font-size: 12px;
        font-weight: 440;
        font-variant-numeric: tabular-nums;
      }
      .history-entry strong {
        display: block;
        color: var(--ink);
        font-size: 13px;
        line-height: 1.35;
        font-weight: 480;
        overflow-wrap: anywhere;
      }
      .history-entry span {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 12px;
        line-height: 1.45;
        overflow-wrap: anywhere;
      }
      .actions {
        position: sticky;
        bottom: 0;
        z-index: 13;
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 8px;
        margin: 14px -2px 0;
        padding: 8px 2px calc(8px + env(safe-area-inset-bottom));
        background: var(--action-bg);
        backdrop-filter: blur(14px);
      }
      .actions button,
      .actions a {
        display: inline-flex;
        min-height: 48px;
        align-items: center;
        justify-content: center;
        padding: 10px 8px;
        border: 1px solid var(--line);
        border-radius: 10px;
        color: var(--soft);
        background: var(--soft-fill-strong);
        text-decoration: none;
        font-size: 13px;
        font-weight: 480;
        line-height: 1.18;
        white-space: nowrap;
      }
      .actions .danger { color: #ffd1d1; background: var(--red-soft); border-color: rgba(255, 123, 123, 0.24); }
      .actions .primary { color: #c7efff; background: var(--blue-soft); border-color: rgba(107, 180, 255, 0.24); }
      [data-theme="light"] .actions .danger { color: #c01050; }
      [data-theme="light"] .actions .primary { color: #002fa7; }
      .actions .disabled { color: var(--muted); pointer-events: none; opacity: 0.62; }
      .loading {
        min-height: 180px;
        display: grid;
        place-items: center;
        color: var(--muted);
      }
      .chrome-bar {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: 8px;
        margin: -2px -2px 6px;
        padding: 4px 2px;
      }
      .lang-toggle {
        display: inline-flex;
        align-items: center;
        padding: 3px;
        border: 1px solid var(--line);
        border-radius: 999px;
        background: var(--soft-fill);
      }
      .lang-toggle button {
        min-width: 30px;
        padding: 4px 9px;
        border: 0;
        border-radius: 999px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 11px;
        font-weight: 460;
        letter-spacing: 0.04em;
      }
      .lang-toggle button.active {
        background: rgba(107, 180, 255, 0.18);
        color: var(--blue);
      }
      .sticky-header {
        margin: 0 -2px 12px;
      }
      .sticky-header > * + * {
        margin-top: 12px;
      }
      .tab-bar {
        position: sticky;
        top: 0;
        z-index: 11;
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 4px;
        margin: 0 -2px 14px;
        padding: 6px;
        border: 1px solid var(--line);
        border-radius: 12px;
        background: var(--panel-strong);
        backdrop-filter: blur(14px);
      }
      .tab-bar button {
        min-height: 38px;
        padding: 6px 4px;
        border: 0;
        border-radius: 8px;
        background: transparent;
        color: var(--muted);
        cursor: pointer;
        font-size: 13px;
        font-weight: 440;
        letter-spacing: 0.005em;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        transition: background 0.16s ease, color 0.16s ease;
      }
      .tab-bar button.active {
        background: var(--tab-active);
        color: var(--ink);
        font-weight: 540;
        box-shadow: 0 1px 0 rgba(255,255,255,0.04) inset;
      }
      .tab-panel { display: none; }
      .tab-panel.active { display: block; }
      .tab-panel > * + * { margin-top: 14px; }
      .pill-button {
        display: inline-flex;
        min-height: 32px;
        margin-top: 10px;
        align-items: center;
        justify-content: center;
        padding: 5px 12px;
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        color: var(--blue);
        background: var(--blue-soft);
        cursor: pointer;
        font-size: 13px;
        font-weight: 460;
        text-decoration: none;
        transition: opacity 0.15s ease;
      }
      .pill-button:disabled,
      .pill-button.disabled { opacity: 0.55; pointer-events: none; }
      .connection-banner {
        position: relative;
        margin: 0 -2px 12px;
        padding: 12px 14px;
        border: 1px solid var(--line-strong);
        border-left: 3px solid var(--orange);
        border-radius: 10px;
        background: var(--orange-soft);
        color: var(--ink);
        font-size: 13px;
        font-weight: 460;
        line-height: 1.45;
        cursor: pointer;
        word-break: break-word;
      }
      .connection-banner strong {
        display: block;
        margin-bottom: 2px;
        color: var(--orange);
        font-weight: 540;
      }
      .connection-banner small {
        display: block;
        margin-top: 4px;
        color: var(--muted);
        font-size: 11.5px;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        word-break: break-all;
      }
      .connection-banner.is-online {
        border-left-color: var(--green);
        background: var(--green-soft);
      }
      .connection-banner.is-online strong { color: var(--green); }
      .tab-panel {
        max-height: calc(100vh - 320px);
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-width: thin;
        scroll-behavior: smooth;
      }
      .tab-panel::-webkit-scrollbar { width: 6px; }
      .tab-panel::-webkit-scrollbar-thumb {
        background: var(--line-strong);
        border-radius: 999px;
      }
      .agent-badge {
        min-width: 32px;
        max-width: 84px;
        padding: 4px 8px;
        border-radius: 999px;
        text-align: center;
        font-size: 11px;
        font-weight: 480;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        border: 1px solid transparent;
      }
      .agent-badge.dev { color: var(--blue); background: var(--blue-soft); border-color: var(--blue-soft); }
      .agent-badge.review { color: var(--purple); background: var(--purple-soft); border-color: var(--purple-soft); }
      .agent-badge.bash { color: var(--teal); background: var(--teal-soft); border-color: var(--teal-soft); }
      .agent-badge.read { color: var(--green); background: var(--green-soft); border-color: var(--green-soft); }
      .agent-badge.edit { color: var(--orange); background: var(--orange-soft); border-color: var(--orange-soft); }
      .agent-badge.test { color: var(--yellow); background: var(--yellow-soft); border-color: var(--yellow-soft); }
      .agent-badge.git { color: var(--purple); background: var(--purple-soft); border-color: var(--purple-soft); }
      .agent-badge.tool { color: var(--soft); background: var(--soft-fill-strong); }
      .group-row {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 10px;
        align-items: center;
        padding: 10px 0;
        border-top: 1px solid var(--line);
        cursor: pointer;
      }
      .group-row:first-child { border-top: 0; }
      .group-row strong {
        display: block;
        font-weight: 460;
        font-size: 13px;
        color: var(--ink);
      }
      .group-row span {
        display: block;
        margin-top: 3px;
        color: var(--muted);
        font-size: 12px;
      }
      .group-children {
        margin-top: 4px;
        padding-left: 12px;
        border-left: 2px solid var(--line);
      }
      .diff-patch {
        margin-top: 8px;
        padding: 10px 12px;
        border-radius: 8px;
        background: var(--soft-fill);
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11.5px;
        line-height: 1.55;
        white-space: pre;
        overflow-x: auto;
      }
      .diff-patch .add { color: var(--green); display: block; }
      .diff-patch .del { color: var(--red); display: block; }
      .diff-patch .hunk { color: var(--muted); display: block; }
      .diff-row .diff-counts {
        display: inline-flex;
        gap: 6px;
        margin-left: 6px;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11px;
      }
      .diff-row .diff-counts .add { color: var(--green); }
      .diff-row .diff-counts .del { color: var(--red); }
      [hidden] { display: none !important; }
      @keyframes skeleton-shimmer {
        0% { background-position: -200px 0; }
        100% { background-position: 200px 0; }
      }
      .skeleton-text,
      .skeleton-chip {
        display: inline-block;
        min-width: 60px;
        height: 14px;
        border-radius: 6px;
        background: linear-gradient(90deg, var(--soft-fill) 0%, var(--soft-fill-strong) 50%, var(--soft-fill) 100%);
        background-size: 400px 100%;
        animation: skeleton-shimmer 1.4s infinite linear;
        color: transparent !important;
        border: 0;
      }
      .skeleton-chip { min-width: 78px; height: 22px; }
      .diagnostics-panel {
        margin: 0 -2px 12px;
        padding: 10px 12px;
        border: 1px solid var(--line-strong);
        border-radius: 10px;
        background: var(--soft-fill);
        color: var(--soft);
        font-size: 12px;
      }
      .diagnostics-panel[open] { background: var(--panel); }
      .diagnostics-panel summary {
        cursor: pointer;
        font-weight: 480;
        color: var(--ink);
        list-style: none;
      }
      .diagnostics-panel summary::-webkit-details-marker { display: none; }
      .diagnostics-panel summary::before {
        content: '▸';
        display: inline-block;
        margin-right: 6px;
        transition: transform 0.15s;
      }
      .diagnostics-panel[open] summary::before { transform: rotate(90deg); }
      .diagnostics-body {
        margin-top: 10px;
        display: grid;
        gap: 8px;
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11.5px;
      }
      .diag-row {
        padding: 8px;
        border: 1px solid var(--line);
        border-radius: 8px;
        background: var(--bg);
        overflow: hidden;
      }
      .diag-row .diag-url {
        word-break: break-all;
        color: var(--soft);
      }
      .diag-row .diag-status {
        display: inline-block;
        margin-top: 4px;
        padding: 2px 8px;
        border-radius: 6px;
        font-weight: 480;
      }
      .diag-row.ok .diag-status { color: var(--green); background: var(--green-soft); }
      .diag-row.fail .diag-status { color: var(--orange); background: var(--orange-soft); }
      .diag-row.pending .diag-status { color: var(--muted); background: var(--soft-fill-strong); }
      .diag-row .diag-body {
        margin-top: 6px;
        padding: 6px 8px;
        max-height: 90px;
        overflow: auto;
        border-radius: 6px;
        background: var(--soft-fill-strong);
        color: var(--ink);
        white-space: pre-wrap;
        word-break: break-all;
      }
      .diagnostics-retry {
        margin-top: 10px;
        padding: 6px 12px;
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        background: var(--soft-fill-strong);
        color: var(--blue);
        cursor: pointer;
        font-weight: 460;
      }
      .boot-log {
        margin: 0 -2px 8px;
        padding: 8px 10px;
        border: 1px solid var(--line-strong);
        border-radius: 8px;
        background: var(--soft-fill);
        color: var(--ink);
        font-family: "SF Mono", "Menlo", "Consolas", monospace;
        font-size: 11px;
      }
      .boot-log.is-collapsed .boot-log-entries { display: none; }
      .boot-log-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        font-weight: 480;
        color: var(--soft);
      }
      .boot-log-head button {
        min-width: 24px;
        padding: 0 8px;
        height: 22px;
        border: 1px solid var(--line);
        border-radius: 6px;
        background: var(--soft-fill-strong);
        color: var(--soft);
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
      }
      .boot-log-entries {
        margin: 8px 0 0;
        padding: 0;
        max-height: 140px;
        overflow-y: auto;
        list-style: none;
        font-size: 11px;
        line-height: 1.45;
      }
      .boot-log-entries li {
        padding: 2px 0;
        border-top: 1px solid var(--line);
        color: var(--soft);
        word-break: break-all;
      }
      .boot-log-entries li:first-child { border-top: 0; }
      .boot-log-entries li.ok { color: var(--green); }
      .boot-log-entries li.warn { color: var(--orange); }
      .boot-log-entries li.error { color: var(--red); }
      .boot-log-entries li time {
        color: var(--muted);
        margin-right: 6px;
      }
      [data-i18n-overflow-safe] {
        overflow-wrap: anywhere;
        word-break: break-word;
      }
      @media (min-width: 720px) {
        .shell { padding-left: 22px; padding-right: 22px; }
        .hero { grid-template-columns: minmax(0, 1fr) 176px; padding: 26px 20px 20px; }
        .ring { width: 160px; }
        .ring-content strong { font-size: 42px; }
        .judgment { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        .layout { grid-template-columns: minmax(0, 1.5fr) minmax(320px, 0.88fr); align-items: stretch; }
        .layout > .panel:first-child { min-height: 430px; }
        .issue-title { font-size: 36px; }
        .actions { grid-template-columns: repeat(3, minmax(0, 1fr)); }
      }
    </style>
  </head>
  <body>
    <main class="shell" data-issue-id="${escapedIssueId}" data-issue-api="${issueApi}" data-timeline-api="${timelineApi}" data-history-api="${historyApi}" data-build="${buildStamp}">
      <div class="chrome-bar" aria-label="Mini App controls">
        <div class="lang-toggle" role="tablist" aria-label="Theme">
          <button id="theme-light" type="button" data-theme-pick="light" aria-pressed="false" aria-label="Light theme" title="Light">☀</button>
          <button id="theme-dark" type="button" class="active" data-theme-pick="dark" aria-pressed="true" aria-label="Dark theme" title="Dark">☾</button>
        </div>
        <div class="lang-toggle" role="tablist" aria-label="Language">
          <button id="lang-zh" type="button" class="active" data-lang="zh" aria-pressed="true">中</button>
          <button id="lang-en" type="button" data-lang="en" aria-pressed="false">EN</button>
        </div>
      </div>
      <div id="connection-banner" class="connection-banner" hidden role="status" aria-live="polite" data-i18n="copy.connection_offline">Live 已断开，下拉刷新或点击重连</div>
      <details id="diagnostics-panel" class="diagnostics-panel" hidden>
        <summary id="diagnostics-summary"><span data-i18n="diag.summary">诊断</span></summary>
        <div id="diagnostics-body" class="diagnostics-body"></div>
        <button id="diagnostics-retry" type="button" class="diagnostics-retry" data-i18n="diag.retry">重新检测</button>
      </details>

      <div class="sticky-header">
        <section id="hero" class="hero panel">
          <div>
            <h1 id="issue-title" class="issue-title" data-i18n-overflow-safe>${escapedIssueId}</h1>
            <div id="repo-line" class="repo-line">
              <svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38v-1.49c-2.24 0.49-2.71-0.95-2.71-0.95-0.36-0.92-0.88-1.16-0.88-1.16-0.72-0.49 0.05-0.48 0.05-0.48 0.8 0.06 1.22 0.82 1.22 0.82 0.71 1.21 1.86 0.86 2.31 0.66 0.07-0.52 0.28-0.86 0.5-1.06-1.79-0.2-3.67-0.89-3.67-3.98 0-0.88 0.31-1.6 0.82-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.67-0.21 2.2 0.82A7.62 7.62 0 0 1 8 4.03c0.68 0 1.36 0.09 2 0.27 1.52-1.03 2.19-0.82 2.19-0.82 0.44 1.11 0.16 1.93 0.08 2.13 0.51 0.56 0.82 1.28 0.82 2.16 0 3.1-1.89 3.77-3.69 3.97 0.29 0.25 0.55 0.74 0.55 1.5v2.22c0 0.21 0.15 0.46 0.56 0.38A8 8 0 0 0 8 0.2Z"/></svg>
              <span class="repo-name skeleton-text">&nbsp;</span>
            </div>
            <div id="status-line" class="status-line">
              <span class="chip skeleton-chip">&nbsp;</span>
            </div>
          </div>
          <div id="progress-ring" class="ring" style="--progress: 0deg">
            <div class="ring-content">
              <strong id="progress-value">0%</strong>
              <span data-i18n="label.overall_progress">整体进度</span>
            </div>
          </div>
        </section>

        <section id="stage-row" class="panel stage-row" aria-label="阶段进度"></section>
      </div>

      <nav class="tab-bar" role="tablist" aria-label="Mini App sections">
        <button id="tab-overview" type="button" class="active" data-tab="overview" role="tab" aria-selected="true" data-i18n="tab.overview">Overview</button>
        <button id="tab-activity" type="button" data-tab="activity" role="tab" aria-selected="false" data-i18n="tab.activity">Activity</button>
        <button id="tab-changes" type="button" data-tab="changes" role="tab" aria-selected="false" data-i18n="tab.changes">Changes</button>
        <button id="tab-delivery" type="button" data-tab="delivery" role="tab" aria-selected="false" data-i18n="tab.delivery">Delivery</button>
      </nav>

      <section class="tab-panel active" data-tab-panel="overview" role="tabpanel" aria-labelledby="tab-overview">
        <article class="panel pad">
          <h2 class="panel-title" data-i18n="panel.judgment">全览 / Supervisor 判断</h2>
          <p id="judgment-copy" class="panel-copy" data-i18n="copy.loading_state">正在读取当前 issue 状态。</p>
        </article>
        <article class="panel pad">
          <h2 class="panel-title" data-i18n="panel.next">下一步推荐</h2>
          <p id="next-copy" class="panel-copy" data-i18n="copy.waiting_runtime">等待运行时信号。</p>
        </article>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.round_goal">当前轮次目标</span> <span id="complexity-chip" class="chip blue" hidden></span></h2>
          <p id="round-goal" class="panel-copy" data-i18n="copy.waiting_round">等待 supervisor round 信号。</p>
        </article>
        <article class="panel pad">
          <h2 class="panel-title" data-i18n="panel.risk_delta">风险变化</h2>
          <p id="risk-delta" class="panel-copy">risk_delta · loading</p>
        </article>
      </section>

      <section class="tab-panel" data-tab-panel="activity" role="tabpanel" aria-labelledby="tab-activity" hidden>
        <article class="panel pad">
          <h2 class="panel-title"><span id="timeline-title" data-i18n="panel.timeline">实时事件流</span> <span id="live-badge" class="chip green">Live</span></h2>
          <div id="timeline-list" class="timeline"><div class="loading" data-i18n="copy.loading_timeline">Loading timeline...</div></div>
        </article>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.agents">Agent 进度</span> <span class="chip green" data-i18n="chip.recent3">最近 3 条</span></h2>
          <div id="agent-list"></div>
        </article>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.milestones">关键节点</span> <span class="chip yellow" data-i18n="chip.milestones">节点</span></h2>
          <div id="milestone-list"></div>
        </article>
      </section>

      <section class="tab-panel" data-tab-panel="changes" role="tabpanel" aria-labelledby="tab-changes" hidden>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.changes">代码改动</span> <span class="chip green" data-i18n="chip.diff">差异</span></h2>
          <div id="diff-list"></div>
        </article>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.files">文件活动</span> <span class="chip blue" data-i18n="chip.recent">最近</span></h2>
          <div id="file-list"></div>
        </article>
      </section>

      <section class="tab-panel" data-tab-panel="delivery" role="tabpanel" aria-labelledby="tab-delivery" hidden>
        <article class="panel pad">
          <h2 class="panel-title" data-i18n="panel.delivery">PR / Delivery</h2>
          <div id="delivery-list"></div>
          <a id="pr-link" class="pill-button" href="#" target="_blank" rel="noreferrer" data-i18n="action.view_pr">查看 PR</a>
        </article>
        <article class="panel pad">
          <h2 class="panel-title"><span data-i18n="panel.children">子任务队列</span> <span id="root-label" class="chip">Root: ${escapedIssueId}</span></h2>
          <div id="child-list"></div>
        </article>
        <article id="history-panel" class="panel pad history-panel">
          <h2 class="panel-title"><span data-i18n="panel.full_log">完整日志</span> <button id="history-toggle-button" class="text-button" type="button" data-i18n="action.expand_log">展开</button></h2>
          <p id="history-digest" class="panel-copy" data-i18n="copy.waiting_history">等待历史记录。</p>
          <div id="history-entry-list" hidden></div>
        </article>
        <article class="panel pad">
          <h2 class="panel-title" data-i18n="panel.recovery">失败恢复</h2>
          <p id="recovery-copy" class="panel-copy" data-i18n="copy.recovery_idle">交付状态正常，暂无需要恢复的失败。</p>
          <button id="recovery-button" type="button" class="pill-button" data-runtime-action="retry" hidden data-i18n="action.retry">修复交付并重试</button>
        </article>
      </section>

      <div class="actions">
        <button id="pause-button" class="danger" type="button" data-runtime-action="pause" data-i18n="action.pause">暂停执行</button>
        <button id="request-button" class="primary" type="button" data-runtime-action="request" data-i18n="action.request">补充要求</button>
        <button id="back-button" type="button" data-runtime-action="back" data-i18n="action.back">回 Telegram</button>
      </div>
      <div id="boot-log" class="boot-log is-collapsed" aria-live="polite">
        <div class="boot-log-head">
          <strong>boot · ${buildStamp}</strong>
          <button id="boot-log-toggle" type="button" aria-expanded="false">+</button>
        </div>
        <ol id="boot-log-entries" class="boot-log-entries"></ol>
      </div>
    </main>

    <script>
      // ── Boot logger: defined OUTSIDE the IIFE so it's available even if the IIFE crashes early.
      // Renders to a visible div + console, so users without DevTools can still see what's happening.
      (function setupBootLog() {
        var entriesEl = document.getElementById('boot-log-entries');
        var rootEl = document.getElementById('boot-log');
        var toggleEl = document.getElementById('boot-log-toggle');
        function fmt(t) {
          var d = new Date();
          return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
        window.__bootLog = function (level, message) {
          var safeLevel = (level === 'ok' || level === 'warn' || level === 'error') ? level : '';
          try { (console[level] || console.log).call(console, '[boot]', message); } catch (_) {}
          if (!entriesEl) return;
          var li = document.createElement('li');
          if (safeLevel) li.className = safeLevel;
          var time = document.createElement('time');
          time.textContent = fmt();
          li.appendChild(time);
          li.appendChild(document.createTextNode(String(message)));
          entriesEl.appendChild(li);
          entriesEl.scrollTop = entriesEl.scrollHeight;
        };
        if (toggleEl && rootEl) {
          toggleEl.addEventListener('click', function () {
            var collapsed = rootEl.classList.toggle('is-collapsed');
            toggleEl.textContent = collapsed ? '+' : '−';
            toggleEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
          });
        }
        window.addEventListener('error', function (event) {
          var msg = (event && event.message) || 'window.onerror';
          var src = (event && (event.filename || '')) + (event.lineno ? ':' + event.lineno : '');
          window.__bootLog('error', 'JS error: ' + msg + (src ? ' (' + src + ')' : ''));
        });
        window.addEventListener('unhandledrejection', function (event) {
          var reason = event && event.reason;
          var msg = reason && reason.message ? reason.message : (reason ? String(reason) : 'unhandledrejection');
          window.__bootLog('error', 'Unhandled rejection: ' + msg);
        });
        window.__bootLog('ok', 'boot log ready · build=${buildStamp}');
      })();
      (function () {
        var bootLog = window.__bootLog || function () {};
        bootLog('', 'IIFE start · href=' + location.href);
        const issueId = ${JSON.stringify(issueId)};
        const urls = {
          issue: ${JSON.stringify(issueApi)},
          timeline: ${JSON.stringify(timelineApi)},
          history: ${JSON.stringify(historyApi)},
          stream: '/api/v1/runtime/stream'
        };
        bootLog('', 'urls: issue=' + urls.issue);
        const tg = window.Telegram && window.Telegram.WebApp ? window.Telegram.WebApp : null;
        function pickThemeFromTelegram() {
          if (!tg) return null;
          const scheme = (tg.colorScheme || '').toLowerCase();
          if (scheme === 'light' || scheme === 'dark') return scheme;
          const bg = (tg.themeParams && tg.themeParams.bg_color) || '';
          if (typeof bg === 'string' && /^#?[0-9a-f]{6}$/i.test(bg.replace('#',''))) {
            const hex = bg.replace('#', '');
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            return luma > 160 ? 'light' : 'dark';
          }
          return null;
        }
        function applyTheme(theme) {
          const next = theme === 'light' ? 'light' : 'dark';
          state.theme = next;
          document.documentElement.setAttribute('data-theme', next);
          if (tg && tg.themeParams && tg.themeParams.bg_color) {
            document.documentElement.style.setProperty('--tg-bg', tg.themeParams.bg_color);
          }
          el.themeButtons && el.themeButtons.forEach((button) => {
            const isActive = button.getAttribute('data-theme-pick') === next;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          });
        }
        if (tg) {
          tg.ready();
          tg.expand();
        }

        const state = {
          issue: null,
          timeline: [],
          history: null,
          stream: null,
          lang: 'zh',
          tab: 'overview',
          theme: 'dark',
          connection: 'connecting',
          tabScrolls: {},
          activityGrouped: true,
          historyOpen: false
        };
        window.__state = state;
        const el = {
          issueTitle: document.getElementById('issue-title'),
          repoLine: document.getElementById('repo-line'),
          statusLine: document.getElementById('status-line'),
          progressRing: document.getElementById('progress-ring'),
          progressValue: document.getElementById('progress-value'),
          judgmentCopy: document.getElementById('judgment-copy'),
          nextCopy: document.getElementById('next-copy'),
          stageRow: document.getElementById('stage-row'),
          timelineTitle: document.getElementById('timeline-title'),
          timelineList: document.getElementById('timeline-list'),
          liveBadge: document.getElementById('live-badge'),
          fileList: document.getElementById('file-list'),
          diffList: document.getElementById('diff-list'),
          deliveryList: document.getElementById('delivery-list'),
          childList: document.getElementById('child-list'),
          rootLabel: document.getElementById('root-label'),
          complexityChip: document.getElementById('complexity-chip'),
          roundGoal: document.getElementById('round-goal'),
          riskDelta: document.getElementById('risk-delta'),
          agentList: document.getElementById('agent-list'),
          milestoneList: document.getElementById('milestone-list'),
          historyPanel: document.getElementById('history-panel'),
          historyDigest: document.getElementById('history-digest'),
          historyEntryList: document.getElementById('history-entry-list'),
          historyToggleButton: document.getElementById('history-toggle-button'),
          prLink: document.getElementById('pr-link'),
          pauseButton: document.getElementById('pause-button'),
          requestButton: document.getElementById('request-button'),
          backButton: document.getElementById('back-button'),
          recoveryButton: document.getElementById('recovery-button'),
          recoveryCopy: document.getElementById('recovery-copy'),
          tabButtons: Array.prototype.slice.call(document.querySelectorAll('[data-tab]')),
          tabPanels: Array.prototype.slice.call(document.querySelectorAll('[data-tab-panel]')),
          langButtons: Array.prototype.slice.call(document.querySelectorAll('[data-lang]')),
          themeButtons: Array.prototype.slice.call(document.querySelectorAll('[data-theme-pick]')),
          connectionBanner: document.getElementById('connection-banner'),
          diagnosticsPanel: document.getElementById('diagnostics-panel'),
          diagnosticsBody: document.getElementById('diagnostics-body'),
          diagnosticsRetry: document.getElementById('diagnostics-retry'),
          diagnosticsSummary: document.getElementById('diagnostics-summary')
        };

        const I18N = ${JSON.stringify(MINI_APP_I18N)};
        function t(key, vars) {
          const dict = I18N[state.lang] || I18N.zh;
          const raw = dict[key] || I18N.zh[key] || key;
          const safe = vars || {};
          // Step 1 — bracketed placeholders like 「{title}」 / "{name}" / ({n}): drop the entire bracket
          // pair when the variable is missing, otherwise just substitute inside the brackets.
          let out = String(raw).replace(
            /([「『"《(\[])\{(\w+)\}([」』"》)\]])/g,
            function (_match, open, name, close) {
              const value = safe[name];
              return value != null && value !== ''
                ? open + String(value) + close
                : '';
            }
          );
          // Step 2 — bare placeholders. Substitute when present, otherwise drop the placeholder
          // (and any orphaned surrounding whitespace) so we never leak {name} into the UI.
          out = out.replace(/\s*\{(\w+)\}\s*/g, function (match, name) {
            const value = safe[name];
            if (value != null && value !== '') {
              return match.replace(/\{\w+\}/, String(value));
            }
            // Preserve a single space if either side had whitespace, so adjacent words don't fuse.
            return /^\s|\s$/.test(match) ? ' ' : '';
          });
          // Step 3 — clean up double spaces and orphaned punctuation introduced by the strip.
          return out
            .replace(/\s{2,}/g, ' ')
            .replace(/\s+([。，；：、])/g, '$1')
            .replace(/[，、]\s*[，、]/g, '，')
            .replace(/^[\s，、。；：]+|[\s，、；：]+$/g, '')
            .trim();
        }
        function applyLanguage(lang) {
          state.lang = (lang === 'en' ? 'en' : 'zh');
          document.documentElement.setAttribute('lang', state.lang === 'en' ? 'en' : 'zh-CN');
          document.querySelectorAll('[data-i18n]').forEach((node) => {
            const key = node.getAttribute('data-i18n');
            if (!key) return;
            node.textContent = t(key);
          });
          el.langButtons.forEach((button) => {
            const isActive = button.getAttribute('data-lang') === state.lang;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-pressed', isActive ? 'true' : 'false');
          });
          if (state.issue) render();
        }
        function detectPreferredLang() {
          try {
            const savedLang = localStorage.getItem('symphonyness:lang');
            if (savedLang === 'en' || savedLang === 'zh') return savedLang;
          } catch (_) {}
          return (navigator.language || '').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en';
        }
        function setActiveTab(tab) {
          if (state.tab && state.tab !== tab) {
            const prev = el.tabPanels.find((p) => p.getAttribute('data-tab-panel') === state.tab);
            if (prev) state.tabScrolls[state.tab] = prev.scrollTop;
          }
          state.tab = tab;
          el.tabButtons.forEach((button) => {
            const isActive = button.getAttribute('data-tab') === tab;
            button.classList.toggle('active', isActive);
            button.setAttribute('aria-selected', isActive ? 'true' : 'false');
          });
          el.tabPanels.forEach((panel) => {
            const isActive = panel.getAttribute('data-tab-panel') === tab;
            panel.classList.toggle('active', isActive);
            if (isActive) {
              panel.removeAttribute('hidden');
              const remembered = state.tabScrolls[tab];
              if (typeof remembered === 'number') {
                panel.scrollTop = remembered;
              }
            } else {
              panel.setAttribute('hidden', '');
            }
          });
          try { localStorage.setItem('symphonyness:tab', tab); } catch (_) {}
        }
        function setConnectionStatus(status) {
          state.connection = status;
          if (!el.connectionBanner) return;
          if (status === 'online' || status === 'connecting') {
            // hide banner if everything is fine, but flash a brief "online" if recovering
            if (status === 'online' && el.connectionBanner.dataset.wasOffline === '1') {
              el.connectionBanner.hidden = false;
              el.connectionBanner.classList.add('is-online');
              el.connectionBanner.textContent = t('copy.connection_online');
              setTimeout(() => {
                el.connectionBanner.hidden = true;
                el.connectionBanner.classList.remove('is-online');
                delete el.connectionBanner.dataset.wasOffline;
              }, 2000);
            } else {
              el.connectionBanner.hidden = true;
              el.connectionBanner.classList.remove('is-online');
            }
          } else {
            el.connectionBanner.dataset.wasOffline = '1';
            el.connectionBanner.hidden = false;
            el.connectionBanner.classList.remove('is-online');
            el.connectionBanner.textContent = t(status === 'reconnecting' ? 'copy.connection_reconnecting' : 'copy.connection_offline');
          }
        }

        function escapeHtml(value) {
          return String(value == null ? '' : value)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
        }
        function compactText(value, maxLength) {
          const normalized = normalizeRuntimeSummary(value, '', maxLength);
          const limit = maxLength || 520;
          if (!normalized) return '';
          return normalized.length <= limit ? normalized : normalized.slice(0, limit - 1).trim() + '…';
        }
        function expandableCopy(value, fallback, previewLength) {
          const limit = previewLength || 180;
          const full = normalizeRuntimeSummary(value, fallback || '', 4000);
          const preview = compactText(full, limit);
          if (!full) return '';
          if (full === preview || full.length <= limit) {
            return '<span class="expandable-copy"><span class="expandable-text">' + escapeHtml(full) + '</span></span>';
          }
          return '<span class="expandable-copy" data-full-text="' + escapeHtml(full) + '" data-preview-text="' + escapeHtml(preview) + '"><span class="expandable-text">' + escapeHtml(preview) + '</span><button class="expand-button" type="button">' + escapeHtml(t('action.expand')) + '</button></span>';
        }
        function renderExpandableText(target, value, fallback, previewLength) {
          target.innerHTML = expandableCopy(value, fallback, previewLength);
        }
        function toggleExpandedText(button) {
          const root = button.closest('.expandable-copy');
          if (!root) return;
          const text = root.querySelector('.expandable-text');
          if (!text) return;
          const expanded = root.getAttribute('data-expanded') === 'true';
          text.textContent = expanded ? root.getAttribute('data-preview-text') || '' : root.getAttribute('data-full-text') || '';
          root.setAttribute('data-expanded', expanded ? 'false' : 'true');
          button.textContent = expanded ? t('action.expand') : t('action.collapse');
        }
        function parseRuntimeJsonSummary(value) {
          const raw = String(value || '').trim();
          if (!/^[{[]/.test(raw)) return null;
          try {
            const parsed = JSON.parse(raw);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
          } catch {
            return null;
          }
        }
        function normalizeRuntimeSummary(value, fallback, maxLength) {
          const raw = String(value || '').trim();
          const parsed = parseRuntimeJsonSummary(raw);
          const limit = maxLength || 520;
          if (parsed) {
            const toolName = typeof parsed.tool_name === 'string' ? titleCaseToolName(parsed.tool_name) : null;
            const code = typeof parsed.code === 'string' ? parsed.code : '';
            const message = typeof parsed.message === 'string' ? parsed.message : '';
            if (toolName) {
              if (code === 'tool_started' || /^using\\s+/i.test(message)) return t('tool.running', { name: toolName });
              if (code === 'tool_completed') return t('tool.completed', { name: toolName });
              return t('tool.activity_named', { name: toolName });
            }
            if (message) {
              return message.replace(/\\s+/g, ' ').trim().slice(0, limit);
            }
          }
          return String(raw || fallback || '')
            .replace(/\\r\\n/g, '\\n')
            .replace(/[ \\t\\v\\f\\r]+/g, ' ')
            .replace(/\\n{3,}/g, '\\n\\n')
            .trim();
        }
        function shortTime(iso) {
          const date = new Date(iso || Date.now());
          if (Number.isNaN(date.getTime())) return '--:--:--';
          return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        }
        function recordFetchProbe(url, info) {
          if (!state.fetchProbes) state.fetchProbes = {};
          state.fetchProbes[url] = Object.assign({ url, lastAt: Date.now() }, info || {});
          renderDiagnostics();
        }
        function diagKindLabel(kind) {
          if (kind === 'network') return t('diag.network');
          if (kind === 'http') return t('diag.http');
          if (kind === 'parse') return t('diag.parse');
          if (kind === 'soft') return t('diag.soft');
          return t('diag.fail');
        }
        function renderDiagnostics(opts) {
          if (!el.diagnosticsPanel || !el.diagnosticsBody) return;
          const o = opts || {};
          const probes = state.fetchProbes || {};
          const orderedUrls = [urls.issue, urls.timeline, urls.history];
          const anyFailure = orderedUrls.some((u) => probes[u] && probes[u].ok === false);
          // Only show the diagnostics panel when there is a failure, so it stays out of
          // the way for normal users. Developers can still see it by opening dev tools.
          if (anyFailure || o.force === true) {
            el.diagnosticsPanel.removeAttribute('hidden');
            el.diagnosticsPanel.setAttribute('open', '');
          } else {
            el.diagnosticsPanel.setAttribute('hidden', '');
          }
          if (el.diagnosticsSummary) {
            const failCount = orderedUrls.filter((u) => probes[u] && probes[u].ok === false).length;
            const summarySpan = el.diagnosticsSummary.querySelector('[data-i18n="diag.summary"]');
            const baseText = t('diag.summary');
            if (summarySpan) summarySpan.textContent = baseText + (failCount ? ' · ' + failCount + '/' + orderedUrls.length + ' ' + t('diag.fail') : '');
          }
          el.diagnosticsBody.innerHTML = orderedUrls.map((u) => {
            const probe = probes[u];
            const labelMap = { issue: 'issue', timeline: 'timeline', history: 'history' };
            const apiKey = u === urls.issue ? 'issue' : u === urls.timeline ? 'timeline' : 'history';
            if (!probe) {
              return '<div class="diag-row pending"><div><strong>' + escapeHtml(labelMap[apiKey]) + '</strong></div><div class="diag-url">' + escapeHtml(u) + '</div><span class="diag-status">' + escapeHtml(t('diag.pending')) + '</span></div>';
            }
            const cls = probe.ok ? 'ok' : 'fail';
            const statusLine = probe.ok
              ? (probe.status ? 'HTTP ' + probe.status : '') + (probe.shape ? ' · shape=' + probe.shape : '') + ' · ' + t('diag.ok')
              : diagKindLabel(probe.kind) + (probe.status ? ' · HTTP ' + probe.status : '') + (probe.message ? ' · ' + probe.message : '');
            const ctRow = probe.contentType ? '<div>content-type: ' + escapeHtml(probe.contentType) + '</div>' : '';
            const bodyRow = probe.bodyExcerpt ? '<div class="diag-body">' + escapeHtml(probe.bodyExcerpt) + '</div>' : '';
            return '<div class="diag-row ' + cls + '"><div><strong>' + escapeHtml(labelMap[apiKey]) + '</strong></div><div class="diag-url">' + escapeHtml(u) + '</div><span class="diag-status">' + escapeHtml(statusLine) + '</span>' + ctRow + bodyRow + '</div>';
          }).join('');
        }
        async function fetchJson(url, options) {
          bootLog('', 'fetch start: ' + url);
          let response;
          try {
            response = await fetch(url, options || undefined);
          } catch (networkError) {
            const detail = networkError && networkError.message || 'fetch failed';
            try { console.error('[symphonyness] network error', { url, error: detail }); } catch (_) {}
            bootLog('error', 'fetch network FAIL: ' + url + ' · ' + detail);
            recordFetchProbe(url, { ok: false, kind: 'network', message: detail });
            throw new Error('Network error: ' + detail + ' (' + url + ')');
          }
          bootLog('', 'fetch HTTP ' + response.status + ': ' + url);
          const contentType = response.headers && response.headers.get ? (response.headers.get('content-type') || '') : '';
          // Read body text first so we can show it in diagnostics regardless of content-type
          const rawText = await response.text().catch(() => '');
          const bodyExcerpt = rawText.slice(0, 400);
          if (!response.ok) {
            let message = 'HTTP ' + response.status;
            let parsedError = null;
            try {
              const body = JSON.parse(rawText);
              if (body && (body.error || body.message)) {
                parsedError = body.error || body.message;
                message = parsedError;
              }
            } catch (_) {
              if (response.statusText) message = response.statusText + ' (HTTP ' + response.status + ')';
            }
            try { console.error('[symphonyness] api error', { url, status: response.status, contentType, message, bodyExcerpt }); } catch (_) {}
            recordFetchProbe(url, { ok: false, kind: 'http', status: response.status, contentType, message, bodyExcerpt });
            throw new Error(message + ' [' + url + ']');
          }
          let payload;
          try {
            payload = JSON.parse(rawText);
          } catch (parseError) {
            const detail = 'Response was not JSON (content-type=' + contentType + ')';
            try { console.error('[symphonyness] non-json response', { url, contentType, bodyExcerpt }); } catch (_) {}
            recordFetchProbe(url, { ok: false, kind: 'parse', status: response.status, contentType, message: detail, bodyExcerpt });
            throw new Error(detail + ' [' + url + ']');
          }
          // Be tolerant of multiple response shells:
          //   { success: true, data: T }   ← server returns this
          //   { data: T }                  ← bare data wrapper
          //   T (array | object)           ← raw body
          if (payload && typeof payload === 'object' && 'success' in payload) {
            if (!payload.success) {
              try { console.error('[symphonyness] api soft-fail', { url, payload }); } catch (_) {}
              recordFetchProbe(url, { ok: false, kind: 'soft', status: response.status, contentType, message: payload.error || 'Request failed', bodyExcerpt });
              throw new Error((payload.error || 'Request failed') + ' [' + url + ']');
            }
            recordFetchProbe(url, { ok: true, status: response.status, contentType, bodyExcerpt });
            return payload.data;
          }
          if (payload && typeof payload === 'object' && 'data' in payload) {
            recordFetchProbe(url, { ok: true, status: response.status, contentType, bodyExcerpt, shape: 'data' });
            return payload.data;
          }
          recordFetchProbe(url, { ok: true, status: response.status, contentType, bodyExcerpt, shape: 'raw' });
          return payload;
        }
        function isCompletedIssue(issue) {
          if (!issue) return false;
          return issue.delivery_state === 'completed'
            || issue.orchestrator_state === 'completed'
            || /^(done|completed)$/i.test(issue.tracker_state || '')
            || issue.supervisor_session_state === 'completed';
        }
        function isRetryableDeliveryFailure(issue) {
          return Boolean(issue && issue.actions && issue.actions.can_retry && (
            issue.delivery_state === 'delivery_failed' ||
            issue.delivery_code ||
            issue.orchestrator_state === 'failed'
          ));
        }
        function isInternalMilestone(item) {
          if (!item || item.kind !== 'delivery_failed') return false;
          return /supervisor_turn_budget_exhausted|turn_budget_exhausted/i.test([
            item.key,
            item.summary,
            item.delivery_code,
            item.deliveryCode
          ].filter(Boolean).join('\\n'));
        }
        function visibleMilestones(issue) {
          return Array.isArray(issue && issue.milestones)
            ? issue.milestones.filter((item) => !isInternalMilestone(item)).map((item) => Object.assign({}, item, {
                summary: normalizeRuntimeSummary(item.summary, item.key, 180)
              })).slice(0, 5)
            : [];
        }
        function milestone(issue, kind, summary, timestamp) {
          const stamp = timestamp || issue.updated_at || issue.created_at || null;
          return {
            kind,
            key: 'miniapp:' + issue.issue_id + ':' + kind + ':' + (stamp || ''),
            summary,
            timestamp: stamp
          };
        }
        function buildMilestones(issue) {
          const visible = visibleMilestones(issue);
          if (visible.length) return visible;
          const items = [
            milestone(issue, 'plan_ready', compactText(issue.supervisor_plan_summary || issue.title, 160) || t('milestone.plan_formed'), issue.created_at)
          ];
          if (issue.governance_thread_state === 'blocked' || issue.governance_thread_state === 'confirming') {
            items.push(milestone(issue, 'needs_decision', compactText(issue.next_recommended_action || issue.governance_summary, 180) || t('milestone.need_confirm')));
          } else {
            items.push(milestone(issue, 'dispatch_ready', issue.session || issue.orchestrator_state ? t('milestone.in_channel') : t('milestone.ready_channel')));
          }
          if (isCompletedIssue(issue)) {
            items.push(milestone(issue, 'delivery_completed', compactText(issue.delivery_summary, 180) || t('milestone.issue_done')));
          } else if (issue.delivery_state === 'proof_satisfied') {
            items.push(milestone(issue, 'proof_satisfied', compactText(issue.delivery_summary, 180) || t('milestone.evidence_ok')));
          } else if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') {
            items.push(milestone(issue, 'review_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || t('milestone.review_qa'), issue.session && issue.session.last_event_at || issue.updated_at));
          } else if (issue.session || issue.orchestrator_state === 'dev_running') {
            items.push(milestone(issue, 'dev_running', compactText((issue.session && issue.session.last_message) || issue.next_recommended_action, 180) || t('milestone.dev_advancing'), issue.session && issue.session.last_event_at || issue.updated_at));
          }
          return items.slice(0, 5);
        }
        function stripShellNoise(value) {
          return String(value || '')
            .replace(/\\s+2>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+1>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+>\\s*\\/dev\\/null/g, '')
            .replace(/\\s+/g, ' ')
            .trim();
        }
        function basename(path) {
          const normalized = String(path || '').trim();
          if (!normalized) return '';
          const parts = normalized.split('/').filter(Boolean);
          return parts[parts.length - 1] || normalized;
        }
        function shortWorkspacePath(path) {
          const normalized = String(path || '').replace(/^['"]|['"]$/g, '').trim();
          if (!normalized) return '';
          const worktreeMatch = normalized.match(/\\/worktrees\\/[^/\\s"']+\\/(.+)$/);
          if (worktreeMatch && worktreeMatch[1]) return worktreeMatch[1];
          const workspaceMatch = normalized.match(/\\/workspaces\\/[^/\\s"']+\\/(.+)$/);
          if (workspaceMatch && workspaceMatch[1]) return workspaceMatch[1];
          const projectMatch = normalized.match(/\\/test-cc\\/(.+)$/);
          if (projectMatch && projectMatch[1]) return projectMatch[1];
          if (!normalized.startsWith('/')) return normalized;
          return basename(normalized);
        }
        function readablePath(path) {
          return shortWorkspacePath(path) || basename(path) || 'workspace';
        }
        function fileDisplayName(path) {
          return basename(shortWorkspacePath(path) || path) || 'workspace';
        }
        function parentFolder(path) {
          const parts = shortWorkspacePath(path).split('/').filter(Boolean);
          return parts.length > 1 ? parts.slice(0, -1).join('/') : '';
        }
        function humanFileOperation(operation) {
          if (operation === 'read') return t('file.read');
          if (operation === 'write') return t('file.write');
          if (operation === 'edit') return t('file.edit');
          return t('file.activity');
        }
        function summarizeDiffPath(path, fallback) {
          const displayPath = readablePath(path);
          const name = fileDisplayName(displayPath);
          const lower = displayPath.toLowerCase();
          if (/\\.test\\.|\\.spec\\.|__tests__|test\\//.test(lower)) return t('diff.summary_test');
          if (/miniapp|page|style|css|tsx?$|jsx?$/.test(lower)) return t('diff.summary_ui');
          if (/readme|docs?|\\.md$/.test(lower)) return t('diff.summary_docs');
          if (/package|bun\\.lock|lockfile/.test(lower)) return t('diff.summary_deps');
          if (/\\.symphony|state|evidence|handover/.test(lower)) return t('diff.summary_evidence');
          if (fallback) return compactText(fallback, 90);
          return t('file.update_name', { name });
        }
        function changeTextSourcesFromHistory(history) {
          const entries = history && Array.isArray(history.entries) ? history.entries : [];
          const sources = [];
          entries.forEach((entry) => {
            [
              entry.summary,
              entry.body,
              entry.detail && entry.detail.payload && entry.detail.payload.body,
              entry.detail && entry.detail.requested_changes_md,
              entry.detail && entry.detail.summary
            ].forEach((value) => {
              if (typeof value === 'string' && value.trim()) sources.push(value);
            });
          });
          return sources;
        }
        function parseChangeLine(line) {
          const trimmed = String(line || '').replace(/^[-*]\\s+/, '').trim();
          if (!trimmed) return null;
          function isLikelyDiffPath(value) {
            const candidate = readablePath(value).replace(/^['"]|['"]$/g, '').trim();
            if (!candidate || /\\s/.test(candidate)) return false;
            return /\\.[a-z0-9][a-z0-9._-]*$/i.test(candidate)
              || /^(README|CHANGELOG|LICENSE)(?:\\.|$)/i.test(candidate)
              || /^(src|test|tests|docs|scripts|packages|app|lib|public|config)\\//.test(candidate);
          }
          let match = trimmed.match(/^\\|\\s*\`?([^\`|]+?)\`?\\s*\\|\\s*([^|]+?)\\s*\\|/);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            const action = String(match[2] || '').toLowerCase();
            const deleted = /delete|remove|删除|移除/.test(action);
            const added = /add|create|新增|创建/.test(action);
            return {
              path,
              badge: deleted ? 'D' : added ? 'A' : 'M',
              summary: summarizeDiffPath(path, deleted ? t('file.deleted') : added ? t('file.added') : t('file.updated')),
              detail: compactText(trimmed.replace(/\\|/g, ' '), 260),
              timestamp: null,
              tone: deleted ? 'red' : added ? 'green' : 'blue'
            };
          }
          match = trimmed.match(/(?:删除|移除|remove(?:d)?|delete(?:d)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'D',
              summary: t('file.delete_name', { name: fileDisplayName(path) }),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'red'
            };
          }
          match = trimmed.match(/(?:新增|创建|添加|add(?:ed)?|create(?:d)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'A',
              summary: t('file.add_name', { name: fileDisplayName(path) }),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'green'
            };
          }
          match = trimmed.match(/(?:更新|修改|编辑|清空|modify|update(?:d)?|edit(?:ed)?)\\s+\`?([^\`\\n]+?)\`?(?:\\s|$)/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'M',
              summary: summarizeDiffPath(path, t('file.updated')),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'blue'
            };
          }
          match = trimmed.match(/\`([^\`]+\\.[a-z0-9][a-z0-9._-]*)\`/i);
          if (match && match[1]) {
            const path = readablePath(match[1]);
            if (!isLikelyDiffPath(path)) return null;
            return {
              path,
              badge: 'M',
              summary: summarizeDiffPath(path, t('file.updated')),
              detail: compactText(trimmed, 260),
              timestamp: null,
              tone: 'blue'
            };
          }
          return null;
        }
        function splitHistoryChangeLines(source) {
          return String(source || '')
            .replace(/\\s+-\\s+(?=(?:删除|移除|新增|创建|添加|更新|修改|编辑|清空|remove|delete|add|create|modify|update|edit)\\b)/ig, '\\n- ')
            .replace(/\\s+(?=\\|\\s*(?:\`?[\\w./-]+\`?)\\s*\\|\\s*(?:deleted|removed|删除|移除|modified|updated|added|created|新增|创建))/ig, '\\n')
            .split(/\\n+/);
        }
        function extractDiffFilesFromHistory(history) {
          const byPath = new Map();
          changeTextSourcesFromHistory(history).forEach((source) => {
            splitHistoryChangeLines(source).forEach((line) => {
              const item = parseChangeLine(line);
              if (!item || !item.path) return;
              byPath.set(item.path, Object.assign({}, byPath.get(item.path), item));
            });
          });
          return Array.from(byPath.values()).slice(0, 12);
        }
        function buildDiffFiles(issue) {
          const byPath = new Map();
          const overview = compactText(issue.change_pack_summary && issue.change_pack_summary.overview, 90);
          const files = issue.change_pack_summary && Array.isArray(issue.change_pack_summary.files) ? issue.change_pack_summary.files : [];
          files.forEach((path) => {
            const normalized = readablePath(path);
            if (!normalized) return;
            byPath.set(normalized, {
              path: normalized,
              badge: 'M',
              summary: summarizeDiffPath(normalized, overview),
              detail: overview || null,
              timestamp: issue.updated_at || null,
              tone: 'blue'
            });
          });
          const recent = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files : [];
          recent.forEach((file) => {
            if (file.operation === 'read') return;
            const normalized = readablePath(file.path);
            if (!normalized) return;
            byPath.set(normalized, {
              path: normalized,
              badge: file.operation === 'write' ? 'A' : 'M',
              summary: t(file.status === 'started' ? 'file.activity_started' : 'file.activity_completed', {
                action: humanFileOperation(file.operation),
                summary: summarizeDiffPath(normalized, overview),
              }),
              detail: overview || null,
              timestamp: file.timestamp || null,
              tone: feedToneFromStatus(file.status)
            });
          });
          return Array.from(byPath.values())
            .sort((left, right) => String(right.timestamp || '').localeCompare(String(left.timestamp || '')))
            .slice(0, 8);
        }
        function titleCaseToolName(toolName) {
          const lower = String(toolName || '').toLowerCase();
          if (/bash|shell|terminal|exec/.test(lower)) return 'Bash';
          if (/read|open|cat/.test(lower)) return 'Read';
          if (/edit|patch|apply|write/.test(lower)) return 'Edit';
          if (/test|pytest|bun|vitest|jest/.test(lower)) return 'Test';
          if (/git|github|pr/.test(lower)) return 'Git';
          if (/review/.test(lower)) return 'Review';
          const compact = String(toolName || '').replace(/[_-]+/g, ' ').trim();
          return compact ? compact.slice(0, 1).toUpperCase() + compact.slice(1) : 'Tool';
        }
        function summarizeShellCommand(value, label) {
          if (/^\\s*[{[]/.test(String(value || ''))) {
            return normalizeRuntimeSummary(value, t('tool.running', { name: label || 'Bash' }), 72);
          }
          const command = stripShellNoise(value);
          const lower = command.toLowerCase();
          const pathMatch = command.match(/(?:cat|sed|awk|tail|head|less|open|code)\\s+(?:-[^\\s]+\\s+)*["']?([^"'\\s<>|;&]+)["']?/i) || command.match(/>\\s*["']?([^"'\\s<>|;&]+)["']?/);
          const path = pathMatch && pathMatch[1] ? fileDisplayName(pathMatch[1]) : '';
          if (/gh\\s+pr\\s+view/i.test(command)) {
            const pr = command.match(/gh\\s+pr\\s+view\\s+(\\d+)/i);
            return pr && pr[1] ? t('bash.view_pr', { pr: pr[1] }) : t('bash.view_pr_status');
          }
          if (/git\\s+status|git\\s+log/i.test(command)) return t('bash.git_status');
          if (/bun\\s+test|npm\\s+test|pnpm\\s+test|pytest|vitest|jest/i.test(command)) return t('bash.run_tests');
          if (/\\brm\\s+-rf\\b|\\bdelete\\b|删除/.test(lower)) return compactText(command.replace(/\\s*&&\\s*/g, t('bash.and_then')), 72);
          if (/^cat\\s*>|>\\s*["']?[^"'\\s]+/.test(command)) return path ? t('bash.write_path', { path }) : t('bash.write_file');
          if (/^(cat|sed|awk|tail|head|less)\\b/.test(command)) return path ? t('bash.read_path', { path }) : t('bash.read_file');
          if (/^(ls|find|tree)\\b/.test(command)) return t('bash.list_files');
          if (!command || /^using\\s+/i.test(command)) return t('tool.running', { name: label || 'Bash' });
          return compactText(command.replace(/\\/Users\\/[^\\s"']+/g, (match) => fileDisplayName(match)), 72);
        }
        function summarizeToolActivity(tool, label) {
          if (label === 'Bash') return summarizeShellCommand(tool.message || tool.summary || '', label);
          const path = fileDisplayName(tool.path);
          if (label === 'Read') return path ? t('file.read_name', { name: path }) : compactText(tool.summary || tool.message || t('bash.read_file'), 72);
          if (label === 'Edit') return path ? t('file.edit_name', { name: path }) : compactText(tool.summary || tool.message || t('file.edit'), 72);
          return compactText(tool.summary || tool.message || t('tool.running', { name: label }), 72);
        }
        function feedToneFromStatus(status) {
          if (status === 'failed') return 'red';
          if (status === 'started') return 'blue';
          if (status === 'completed') return 'green';
          return 'neutral';
        }
        function feedItemFromTool(tool) {
          const label = titleCaseToolName(tool.tool_name);
          const detailPath = readablePath(tool.path);
          return {
            kind: 'tool',
            label,
            summary: summarizeToolActivity(tool, label),
            detail: detailPath || (tool.status === 'started' ? label + ' running' : label + ' completed'),
            timestamp: tool.timestamp || null,
            tone: feedToneFromStatus(tool.status),
            status: tool.status || 'completed'
          };
        }
        function feedItemFromFile(file) {
          const label = file.operation === 'read'
            ? 'Read'
            : file.operation === 'write'
              ? 'Write'
              : file.operation === 'edit'
                ? 'Edit'
                : 'File';
          const name = fileDisplayName(file.path);
          const folder = parentFolder(file.path);
          return {
            kind: 'file',
            label,
            summary: humanFileOperation(file.operation) + ' ' + name,
            detail: [humanFileOperation(file.operation), folder].filter(Boolean).join(' · '),
            timestamp: file.timestamp || null,
            tone: feedToneFromStatus(file.status),
            status: file.status || 'completed'
          };
        }
        function activityDedupeKey(item) {
          return [item.kind, item.label, compactText(String(item.summary || '').toLowerCase(), 80)].join('|');
        }
        function buildActivityFeed(issue) {
          if (isCompletedIssue(issue)) {
            return [{
              kind: 'summary',
              label: t('label.closed'),
              summary: compactText(issue.delivery_summary, 180) || t('copy.delivery_closed'),
              detail: issue.active_pr_number ? 'PR #' + issue.active_pr_number : issue.github_repo || issue.identifier || issueId,
              timestamp: issue.updated_at || issue.created_at || null,
              tone: 'green',
              status: 'completed'
            }];
          }
          const tools = issue.session && Array.isArray(issue.session.recent_tools) ? issue.session.recent_tools : [];
          const files = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files : [];
          const sorted = tools.map(feedItemFromTool).concat(files.map(feedItemFromFile))
            .sort((left, right) => {
              const leftStarted = left.status === 'started' ? 1 : 0;
              const rightStarted = right.status === 'started' ? 1 : 0;
              if (leftStarted !== rightStarted) return rightStarted - leftStarted;
              return String(right.timestamp || '').localeCompare(String(left.timestamp || ''));
            });
          const seen = new Set();
          const compacted = [];
          sorted.forEach((item) => {
            const key = activityDedupeKey(item);
            if (seen.has(key)) return;
            seen.add(key);
            compacted.push(item);
          });
          return compacted.slice(0, 6);
        }
        function getIssueProgress(issue) {
          if (!issue) return 0;
          if (isCompletedIssue(issue)) return 100;
          if (issue.phase === 'REVIEW' || issue.orchestrator_state === 'review_running') return 72;
          if (issue.session || issue.orchestrator_state === 'dev_running') return 42;
          if (issue.governance_thread_state === 'waiting_on_child') return 34;
          return 18;
        }
        function tOrchState(state) {
          if (!state) return null;
          switch (state) {
            case 'discovering': return 'state.orchestrator_discovering';
            case 'mapping': return 'state.orchestrator_mapping';
            case 'workspace_ready': return 'state.orchestrator_workspace_ready';
            case 'dev_running': return 'state.orchestrator_dev_running';
            case 'dev_post_processing': return 'state.orchestrator_dev_post_processing';
            case 'review_running': return 'state.orchestrator_review_running';
            case 'review_post_processing': return 'state.orchestrator_review_post_processing';
            case 'needs_rework': return 'state.orchestrator_needs_rework';
            case 'retry_scheduled': return 'state.orchestrator_retry_scheduled';
            case 'halted': return 'state.orchestrator_halted';
            case 'completed': return 'state.orchestrator_completed';
            case 'cancelled': return 'state.orchestrator_cancelled';
            case 'failed': return 'state.orchestrator_failed';
            default: return state;
          }
        }
        function getPresentation(issue) {
          const completed = isCompletedIssue(issue);
          const retryableFailure = isRetryableDeliveryFailure(issue);
          const deliverySummary = normalizeRuntimeSummary(issue.delivery_summary, '', 4000);
          const reviewApproved = Array.isArray(issue.milestones)
            ? issue.milestones.some((item) => item.kind === 'review_completed')
            : false;
          if (completed) {
            return {
              mode: 'completed',
              progress: 100,
              stateLabel: 'label.completed',
              stateTone: 'green',
              liveBadgeLabel: 'label.final',
              timelineTitle: 'title.delivery_summary',
              judgmentSummary: deliverySummary || t('copy.delivery_closed'),
              nextRecommendation: issue.active_pr_number
                ? t('copy.completed_pr', { n: issue.active_pr_number })
                : t('copy.completed_no_pr'),
              roundGoal: t('copy.round_goal_done', { title: issue.title || issue.identifier || 'issue' }),
              riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || t('copy.risk_stable'),
              planStatus: 'state.completed',
              dispatchStatus: 'state.completed',
              devStatus: 'state.completed',
              reviewStatus: 'state.completed',
              reviewDeliveryStatus: reviewApproved ? 'state.approved' : 'state.completed',
              emptyChildQueueLabel: 'copy.single_issue_done',
              activityFeed: buildActivityFeed(issue),
              visibleMilestones: buildMilestones(issue),
              diffFiles: buildDiffFiles(issue)
            };
          }
          const progress = getIssueProgress(issue);
          return {
            mode: 'live',
            progress: retryableFailure ? Math.max(progress, 82) : progress,
            stateLabel: issue.delivery_state === 'proof_satisfied'
              ? 'label.proof_satisfied'
              : retryableFailure
                ? 'label.needs_recovery'
                : tOrchState(issue.orchestrator_state) || tOrchState(issue.tracker_state) || 'label.running',
            stateTone: issue.delivery_state === 'proof_satisfied'
              ? 'green'
              : retryableFailure
                ? 'yellow'
                : 'blue',
            liveBadgeLabel: retryableFailure ? 'label.action' : 'label.live',
            timelineTitle: 'title.live_stream',
            judgmentSummary: normalizeRuntimeSummary(
              issue.supervisor_plan_summary || issue.governance_summary || issue.delivery_summary,
              '',
              4000
            ) || t('copy.judgment_advancing'),
            nextRecommendation: retryableFailure
              ? t('copy.recovery_stuck')
              : normalizeRuntimeSummary(issue.next_recommended_action || issue.governance_expected_handoff, '', 4000) || t('copy.waiting_supervisor'),
            roundGoal: normalizeRuntimeSummary(issue.roundGoal || (issue.round && issue.round.goal) || issue.next_recommended_action, '', 4000) || t('copy.waiting_signal'),
            riskDelta: normalizeRuntimeSummary(issue.riskDelta || issue.risk_delta, '', 4000) || t('copy.risk_stable'),
            planStatus: 'state.completed',
            dispatchStatus: progress >= 30 ? 'state.completed' : 'state.waiting',
            devStatus: progress >= 100 ? 'state.completed' : 'state.running',
            reviewStatus: progress >= 78 ? 'state.running' : 'state.awaiting_review',
            reviewDeliveryStatus: issue.phase === 'REVIEW' ? 'state.running' : 'state.awaiting_review',
            emptyChildQueueLabel: 'copy.single_issue_no_split',
            activityFeed: buildActivityFeed(issue),
            visibleMilestones: buildMilestones(issue),
            diffFiles: buildDiffFiles(issue)
          };
        }
        function githubMark() {
          return '<svg class="github-mark" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M8 0.2a8 8 0 0 0-2.53 15.59c0.4 0.07 0.55-0.17 0.55-0.38v-1.49c-2.24 0.49-2.71-0.95-2.71-0.95-0.36-0.92-0.88-1.16-0.88-1.16-0.72-0.49 0.05-0.48 0.05-0.48 0.8 0.06 1.22 0.82 1.22 0.82 0.71 1.21 1.86 0.86 2.31 0.66 0.07-0.52 0.28-0.86 0.5-1.06-1.79-0.2-3.67-0.89-3.67-3.98 0-0.88 0.31-1.6 0.82-2.16-0.08-0.2-0.36-1.02 0.08-2.13 0 0 0.67-0.21 2.2 0.82A7.62 7.62 0 0 1 8 4.03c0.68 0 1.36 0.09 2 0.27 1.52-1.03 2.19-0.82 2.19-0.82 0.44 1.11 0.16 1.93 0.08 2.13 0.51 0.56 0.82 1.28 0.82 2.16 0 3.1-1.89 3.77-3.69 3.97 0.29 0.25 0.55 0.74 0.55 1.5v2.22c0 0.21 0.15 0.46 0.56 0.38A8 8 0 0 0 8 0.2Z"/></svg>';
        }
        function chip(label, tone) {
          return '<span class="chip ' + escapeHtml(tone || '') + '">' + escapeHtml(label) + '</span>';
        }
        function renderHero(issue) {
          const presentation = getPresentation(issue);
          const identifier = issue.identifier || issueId;
          const rawTitle = issue.title || identifier;
          const titleWithoutId = String(rawTitle).startsWith(identifier)
            ? String(rawTitle).slice(identifier.length).replace(/^[\s·:：\-]+/, '')
            : String(rawTitle);
          document.body.classList.toggle('is-completed', presentation.mode === 'completed');
          el.issueTitle.innerHTML = '<span class="issue-id">' + escapeHtml(identifier) + '</span><span class="issue-title-text">' + escapeHtml(titleWithoutId || rawTitle) + '</span>';
          el.repoLine.innerHTML = githubMark() + '<span>' + escapeHtml(t('label.repo')) + '</span><span class="repo-name">' + escapeHtml(issue.github_repo || t('label.repo_pending')) + '</span>';
          const child = issue.governance_current_child || (Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue.find((item) => item.queue_state === 'current') : null);
          const chips = [chip(t(presentation.stateLabel), presentation.stateTone)];
          if (issue.complexity) chips.push(chip(issue.complexity, 'blue'));
          if (issue.round && issue.round.index != null && issue.round.total != null) {
            chips.push(chip(t('label.round_prefix') + ' ' + issue.round.index + '/' + issue.round.total, 'green'));
          }
          chips.push(chip(isCompletedIssue(issue) ? t('label.delivery_done') : child ? t('label.child_running') : t('label.root_issue'), 'yellow'));
          chips.push(chip(isCompletedIssue(issue) ? t('label.supervisor_done') : issue.session ? t('label.claude_running') : t('label.supervisor'), 'blue'));
          el.statusLine.innerHTML = chips.join('');
          const progress = presentation.progress;
          el.progressValue.textContent = progress + '%';
          el.progressRing.style.setProperty('--progress', Math.round(progress * 3.6) + 'deg');
          renderExpandableText(el.judgmentCopy, typeof presentation.judgmentSummary === 'string' && presentation.judgmentSummary.startsWith('copy.') ? t(presentation.judgmentSummary) : presentation.judgmentSummary, '', 180);
          renderExpandableText(el.nextCopy, typeof presentation.nextRecommendation === 'string' && presentation.nextRecommendation.startsWith('copy.') ? t(presentation.nextRecommendation) : presentation.nextRecommendation, '', 180);
          el.rootLabel.textContent = t('label.root_format', { id: issue.governance_root_issue_identifier || identifier });
        }
        function renderRound(issue) {
          const presentation = getPresentation(issue);
          const round = issue.round;
          // Build the chip label only from values we actually know — never show "L?" or "Round ?"
          const parts = [];
          if (issue.complexity) parts.push(issue.complexity);
          if (round && round.index != null && round.total != null) parts.push(t('label.round_prefix') + ' ' + round.index + '/' + round.total);
          if (parts.length) {
            el.complexityChip.textContent = parts.join(' · ');
            el.complexityChip.removeAttribute('hidden');
          } else {
            el.complexityChip.textContent = '';
            el.complexityChip.setAttribute('hidden', '');
          }
          renderExpandableText(el.roundGoal, typeof presentation.roundGoal === 'string' && presentation.roundGoal.startsWith('copy.') ? t(presentation.roundGoal) : presentation.roundGoal, t('copy.round_goal_waiting'), 180);
          renderExpandableText(el.riskDelta, typeof presentation.riskDelta === 'string' && presentation.riskDelta.startsWith('copy.') ? t(presentation.riskDelta) : presentation.riskDelta, t('copy.risk_stable'), 160);
        }
        function renderStages(issue) {
          const presentation = getPresentation(issue);
          const progress = presentation.progress;
          const completed = isCompletedIssue(issue);
          const stages = [
            ['stage.plan', 100, '#56e39f', presentation.planStatus],
            ['stage.dispatch', progress >= 30 ? 100 : 0, '#56e39f', presentation.dispatchStatus],
            ['stage.dev', Math.min(100, Math.max(0, progress)), completed ? '#56e39f' : '#6bb4ff', presentation.devStatus],
            ['stage.review', completed ? 100 : progress >= 78 ? Math.min(100, progress) : 0, completed ? '#56e39f' : '#c9d5e1', presentation.reviewStatus]
          ];
          el.stageRow.innerHTML = stages.map(([labelKey, value, tone, status]) => (
            '<div class="stage"><strong>' + escapeHtml(t(labelKey)) + '</strong><span>' + escapeHtml(t(status)) + '</span><div class="stage-meter"><i style="--value:' + value + '%;--tone:' + tone + '"></i></div></div>'
          )).join('');
        }
        const TOOL_BADGE_TONES = { Bash: 'bash', Read: 'read', Edit: 'edit', Test: 'test', Git: 'git', Review: 'review', Write: 'edit' };
        const TOOL_GROUP_KEYS = { Bash: 'group.bash_commands', Read: 'group.read_files', Edit: 'group.edit_files', Write: 'group.write_files', Test: 'group.test_runs' };
        function badgeClassForLabel(label) {
          return TOOL_BADGE_TONES[label] || 'tool';
        }
        function renderEventArticle(item) {
          const tone = item.tone || 'neutral';
          return '<article class="event"><time class="event-time">' + escapeHtml(shortTime(item.timestamp)) + '</time><span class="event-node ' + escapeHtml(tone) + '"></span><div><h3>' + escapeHtml(item.summary || item.label) + '</h3><p>' + escapeHtml(item.detail || item.status || '') + '</p></div><span class="agent-badge ' + escapeHtml(badgeClassForLabel(item.label)) + '" aria-label="' + escapeHtml(item.label) + '">' + escapeHtml(item.label) + '</span></article>';
        }
        function groupActivityFeed(feed) {
          const groups = [];
          let current = null;
          feed.forEach((item) => {
            const label = item.label;
            if (!current || current.label !== label) {
              current = { label, items: [item], firstTimestamp: item.timestamp };
              groups.push(current);
            } else {
              current.items.push(item);
            }
          });
          return groups;
        }
        function renderTimeline() {
          const presentation = getPresentation(state.issue);
          el.timelineTitle.textContent = t(presentation.timelineTitle);
          el.liveBadge.textContent = t(presentation.liveBadgeLabel);
          el.liveBadge.className = 'chip ' + (presentation.mode === 'completed' ? 'green' : 'green');
          const feed = presentation.activityFeed || [];
          if (feed.length) {
            const groups = state.activityGrouped ? groupActivityFeed(feed) : feed.map((item) => ({ label: item.label, items: [item], firstTimestamp: item.timestamp }));
            el.timelineList.innerHTML = groups.map((group, idx) => {
              if (group.items.length === 1) {
                return renderEventArticle(group.items[0]);
              }
              const summaryKey = TOOL_GROUP_KEYS[group.label] || 'group.tool_calls';
              const groupSummary = t(summaryKey, { n: group.items.length });
              const open = !!state.activityOpenGroups && state.activityOpenGroups[idx];
              const childMarkup = open ? '<div class="group-children" data-group-children>' + group.items.map(renderEventArticle).join('') + '</div>' : '';
              return '<div class="group-row" data-group-index="' + idx + '" role="button" tabindex="0" aria-expanded="' + (open ? 'true' : 'false') + '"><div><strong>' + escapeHtml(groupSummary) + '</strong><span>' + escapeHtml(shortTime(group.firstTimestamp)) + '</span></div><span class="agent-badge ' + escapeHtml(badgeClassForLabel(group.label)) + '">' + escapeHtml(group.label) + '</span></div>' + childMarkup;
            }).join('');
            return;
          }
          const items = state.timeline.slice(0, 7);
          if (!items.length) {
            el.timelineList.innerHTML = '<div class="loading">' + escapeHtml(t('copy.waiting_events')) + '</div>';
            return;
          }
          el.timelineList.innerHTML = items.map((item) => {
            const label = item.category === 'tool' ? titleCaseToolName(item.tool_name || 'Tool') : t('label.event');
            const summary = item.category === 'tool' ? summarizeToolActivity({ tool_name: item.tool_name || 'Tool', status: item.code === 'tool_started' ? 'started' : 'completed', message: item.message || '', summary: null, path: item.detail && item.detail.path || null, timestamp: item.timestamp || '' }, titleCaseToolName(item.tool_name || 'Tool')) : compactText(item.message || item.code || t('copy.runtime_event'), 90);
            return '<article class="event"><time class="event-time">' + escapeHtml(shortTime(item.timestamp)) + '</time><span class="event-node"></span><div><h3>' + escapeHtml(summary) + '</h3><p>' + escapeHtml([item.tool_name, item.category, item.level].filter(Boolean).join(' · ')) + '</p></div><span class="agent-badge ' + escapeHtml(badgeClassForLabel(label)) + '">' + escapeHtml(label) + '</span></article>';
          }).join('');
        }
        function renderFiles(issue) {
          const files = issue.session && Array.isArray(issue.session.recent_files) ? issue.session.recent_files.slice(0, 5) : [];
          if (!files.length) {
            el.fileList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('copy.no_files')) + '</p>';
            return;
          }
          el.fileList.innerHTML = files.map((file) => (
            '<div class="file-row"><div><strong>' + escapeHtml(fileDisplayName(file.path)) + '</strong><span>' + escapeHtml(humanFileOperation(file.operation)) + ' · ' + escapeHtml(shortTime(file.timestamp)) + '</span></div><b class="mini-badge ' + escapeHtml(feedToneFromStatus(file.status)) + '">' + escapeHtml((file.operation || 'M').slice(0, 1).toUpperCase()) + '</b></div>'
          )).join('');
        }
        function extractPatchFromText(text) {
          if (!text) return null;
          const raw = String(text);
          // fenced unified-diff block (triple backticks)
          const FENCE_OPEN = String.fromCharCode(96, 96, 96);
          const fenceRe = new RegExp(FENCE_OPEN + '(?:diff|patch)?\\\\s*\\\\n([\\\\s\\\\S]+?)' + FENCE_OPEN, 'i');
          const fence = raw.match(fenceRe);
          if (fence && fence[1] && /(^|\\n)[+\\-@]/.test(fence[1])) return fence[1].trim();
          if (/(^|\\n)@@\\s/.test(raw) && /(^|\\n)[+-]/.test(raw)) return raw.trim();
          return null;
        }
        function findPatchForFile(file) {
          if (file.patch) return String(file.patch);
          if (file.detail) {
            const fromDetail = extractPatchFromText(file.detail);
            if (fromDetail) return fromDetail;
          }
          if (state.history && Array.isArray(state.history.entries)) {
            for (const entry of state.history.entries) {
              const sources = [
                entry.detail && entry.detail.payload && entry.detail.payload.body,
                entry.body,
                entry.summary,
              ];
              for (const source of sources) {
                if (typeof source !== 'string' || source.indexOf(file.path) < 0) continue;
                const slice = source.slice(Math.max(0, source.indexOf(file.path) - 200));
                const patch = extractPatchFromText(slice);
                if (patch) return patch;
              }
            }
          }
          return null;
        }
        function countPatchChanges(patch) {
          let add = 0, del = 0;
          String(patch || '').split(/\\r?\\n/).forEach((line) => {
            if (line.startsWith('+++') || line.startsWith('---')) return;
            if (line.startsWith('+')) add++;
            else if (line.startsWith('-')) del++;
          });
          return { add, del };
        }
        function renderPatchHtml(patch) {
          const lines = String(patch || '').split(/\\r?\\n/);
          const out = [];
          for (const line of lines) {
            if (line.startsWith('@@')) out.push('<span class="hunk">' + escapeHtml(line) + '</span>');
            else if (line.startsWith('+++') || line.startsWith('---')) out.push('<span class="hunk">' + escapeHtml(line) + '</span>');
            else if (line.startsWith('+')) out.push('<span class="add">' + escapeHtml(line) + '</span>');
            else if (line.startsWith('-')) out.push('<span class="del">' + escapeHtml(line) + '</span>');
            else out.push('<span>' + escapeHtml(line) + '</span>');
          }
          return out.join('');
        }
        function renderDiff(issue) {
          const files = extractDiffFilesFromHistory(state.history).concat(getPresentation(issue).diffFiles || []);
          const seen = new Set();
          const uniqueFiles = files.filter((file) => {
            const key = file.path || file.summary || '';
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
          }).slice(0, 12);
          if (!uniqueFiles.length) {
            el.diffList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('copy.no_diff')) + '</p>';
            return;
          }
          if (!state.diffOpen) state.diffOpen = {};
          el.diffList.innerHTML = uniqueFiles.map((file, idx) => {
            const patch = findPatchForFile(file);
            const counts = patch ? countPatchChanges(patch) : null;
            const countsHtml = counts ? '<span class="diff-counts"><span class="add">+' + counts.add + '</span><span class="del">-' + counts.del + '</span></span>' : '';
            const open = !!state.diffOpen[idx];
            const patchHtml = patch && open ? '<pre class="diff-patch">' + renderPatchHtml(patch) + '</pre>' : '';
            const summary = expandableCopy(file.summary || t('file.updated'), t('file.updated'), 130);
            const detail = file.detail ? '<small class="diff-detail">' + expandableCopy(file.detail, '', 120) + '</small>' : '';
            const toggleLabel = open ? t('action.collapse') : t('action.expand');
            const toggleBtn = patch ? '<button type="button" class="expand-button" data-diff-toggle="' + idx + '">' + escapeHtml(toggleLabel) + '</button>' : '';
            return '<div class="diff-row"><div><strong>' + escapeHtml(file.path) + countsHtml + '</strong><span>' + summary + '</span>' + detail + toggleBtn + patchHtml + '</div><b class="diff-stat ' + escapeHtml(file.tone || '') + '">' + escapeHtml(file.badge) + '</b></div>';
          }).join('');
        }
        function findExpandedHistoryText(summary) {
          const raw = String(summary || '');
          const prefix = raw.replace(/(?:\\.\\.\\.|…)$/, '').replace(/\\s+/g, ' ').slice(0, 80);
          if (!prefix || !state.history || !Array.isArray(state.history.entries)) return raw;
          for (const entry of state.history.entries) {
            const candidates = [
              entry.detail && entry.detail.payload && entry.detail.payload.body,
              entry.body,
              entry.summary
            ].filter((value) => typeof value === 'string' && value.length > raw.length);
            const found = candidates.find((value) => String(value).replace(/\\s+/g, ' ').indexOf(prefix) >= 0);
            if (found) return found;
          }
          return raw;
        }
        function renderAgents(issue) {
          const progress = issue.agentRecentProgress || issue.agent_recent_progress || { dev: [], review: [] };
          const items = []
            .concat((progress.dev || []).slice(0, 3).map((item) => Object.assign({ agent: 'Dev' }, item)))
            .concat((progress.review || []).slice(0, 3).map((item) => Object.assign({ agent: 'Review' }, item)));
          if (!items.length) {
            el.agentList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('copy.no_agent')) + '</p>';
            return;
          }
          el.agentList.innerHTML = items.slice(0, 6).map((item) => {
            const reviewAgent = String(item.agent || '').toLowerCase().indexOf('review') === 0;
            const agentTone = reviewAgent ? 'review' : 'dev';
            const agentName = reviewAgent ? t('stage.review') : t('stage.dev');
            const label = agentName + ' · ' + (item.status || t('state.running'));
            return '<div class="agent-row"><div><strong>' + escapeHtml(label) + '</strong><span>' + expandableCopy(findExpandedHistoryText(item.summary), 'progress', 180) + '</span></div><span class="agent-badge ' + agentTone + '" aria-label="' + escapeHtml(agentName) + '">' + escapeHtml(agentName) + '</span></div>';
          }).join('');
        }
        function renderMilestones(issue) {
          const milestones = getPresentation(issue).visibleMilestones;
          if (!milestones.length) {
            el.milestoneList.innerHTML = '<p class="panel-copy">' + escapeHtml(t('copy.no_milestone')) + '</p>';
            return;
          }
          el.milestoneList.innerHTML = milestones.map((item) => (
            '<div class="milestone-row"><div><strong>' + escapeHtml(item.kind || t('label.milestone')) + '</strong><span>' + expandableCopy(item.summary || item.key, t('label.recorded'), 180) + '</span></div><span>' + escapeHtml(shortTime(item.timestamp)) + '</span></div>'
          )).join('');
        }
        function renderDelivery(issue) {
          const presentation = getPresentation(issue);
          const rows = [
            ['PR', issue.active_pr_number ? '#' + issue.active_pr_number : t('state.pending')],
            [t('stage.review'), t(presentation.reviewDeliveryStatus)],
            ['Linear', isCompletedIssue(issue) ? t('state.done') : (issue.tracker_state || t('state.in_progress'))]
          ];
          el.deliveryList.innerHTML = rows.map(([label, value]) => (
            '<div class="delivery-row"><div><strong>' + escapeHtml(label) + '</strong><span>' + escapeHtml(value) + '</span></div><span>›</span></div>'
          )).join('');
          if (issue.github_repo && issue.active_pr_number) {
            el.prLink.href = 'https://github.com/' + issue.github_repo + '/pull/' + issue.active_pr_number;
            el.prLink.classList.remove('disabled');
            el.prLink.style.opacity = '1';
            el.prLink.style.pointerEvents = 'auto';
            el.prLink.textContent = t('action.view_pr');
          } else {
            el.prLink.href = '#';
            el.prLink.classList.add('disabled');
            el.prLink.style.opacity = '0.6';
            el.prLink.style.pointerEvents = 'none';
            el.prLink.textContent = t('action.pr_pending');
          }
          if (el.recoveryButton && el.recoveryCopy) {
            if (isRetryableDeliveryFailure(issue)) {
              el.recoveryButton.hidden = false;
              el.recoveryButton.textContent = t('action.retry');
              el.recoveryCopy.textContent = t('copy.recovery_action');
            } else {
              el.recoveryButton.hidden = true;
              el.recoveryCopy.textContent = t('copy.recovery_idle');
            }
          }
        }
        function renderChildren(issue) {
          const presentation = getPresentation(issue);
          const queue = Array.isArray(issue.governance_child_queue) ? issue.governance_child_queue.slice(0, 4) : [];
          if (!queue.length) {
            el.childList.innerHTML = '<p class="panel-copy">' + escapeHtml(t(presentation.emptyChildQueueLabel)) + '</p>';
            return;
          }
          el.childList.innerHTML = queue.map((child, index) => (
            '<div class="child-row"><div><strong>' + escapeHtml(t('child.prefix', { n: index + 1 })) + ' · ' + escapeHtml(child.issue_identifier || t('child.pending')) + '</strong><span>' + escapeHtml(child.title || child.governance_summary || t('child.queued')) + '</span></div>' + chip(child.queue_state || t('child.queued'), child.queue_state === 'current' ? 'blue' : '') + '</div>'
          )).join('');
        }
        function renderHistoryPanel() {
          const view = state.history || {};
          const digest = view.digest || {};
          const entries = Array.isArray(view.entries) ? view.entries.slice(0, 20) : [];
          renderExpandableText(el.historyDigest, digest.detail || digest.history_blurb, t('error.no_history_log'), 220);
          if (!entries.length) {
            el.historyEntryList.innerHTML = '<p class="panel-copy" style="margin-top:12px">' + escapeHtml(t('copy.no_history')) + '</p>';
          } else {
            el.historyEntryList.innerHTML = entries.map((entry) => (
              '<article class="history-entry"><time>' + escapeHtml(shortTime(entry.timestamp)) + '</time><div><strong>' + escapeHtml(entry.title || entry.source || t('label.checkpoint')) + '</strong><span>' + expandableCopy(entry.summary, t('label.checkpoint'), 220) + '</span></div><b class="mini-badge blue">' + escapeHtml(entry.source || t('label.log')) + '</b></article>'
            )).join('');
          }
        }
        function toggleHistoryEntries() {
          if (!el.historyEntryList || !el.historyToggleButton) return;
          const wasHidden = el.historyEntryList.hasAttribute('hidden');
          if (wasHidden) {
            el.historyEntryList.removeAttribute('hidden');
            el.historyToggleButton.textContent = t('action.collapse_log');
            renderHistoryPanel();
          } else {
            el.historyEntryList.setAttribute('hidden', '');
            el.historyToggleButton.textContent = t('action.expand_log');
          }
        }
        function setRuntimeAction(button, action, i18nKey, className) {
          button.setAttribute('data-runtime-action', action);
          button.textContent = t(i18nKey);
          button.className = className || '';
          button.disabled = false;
        }
        function renderActions(issue) {
          const presentation = getPresentation(issue);
          if (presentation.mode === 'completed') {
            setRuntimeAction(el.pauseButton, 'history', 'action.full_log', 'primary');
            setRuntimeAction(el.requestButton, 'request', 'action.new_request', 'primary');
            setRuntimeAction(el.backButton, 'back', 'action.back', '');
            return;
          }
          if (isRetryableDeliveryFailure(issue)) {
            setRuntimeAction(el.pauseButton, 'retry', 'action.retry', 'primary');
            setRuntimeAction(el.requestButton, 'request', 'action.request', 'primary');
            setRuntimeAction(el.backButton, 'back', 'action.back', '');
            return;
          }
          setRuntimeAction(el.pauseButton, 'pause', 'action.pause', 'danger');
          setRuntimeAction(el.requestButton, 'request', 'action.request', 'primary');
          setRuntimeAction(el.backButton, 'back', 'action.back', '');
        }
        function render() {
          if (!state.issue) return;
          renderHero(state.issue);
          renderRound(state.issue);
          renderStages(state.issue);
          renderTimeline();
          renderFiles(state.issue);
          renderDiff(state.issue);
          renderAgents(state.issue);
          renderMilestones(state.issue);
          renderDelivery(state.issue);
          renderChildren(state.issue);
          renderActions(state.issue);
        }
        async function load(options) {
          bootLog('', 'load() called · silent=' + !!(options && options.silent));
          const opts = options || {};
          const controller = new AbortController();
          const timeout = setTimeout(function () { controller.abort(); }, 15000);
          function reasonText(result) {
            if (!result || !result.reason) return 'load failed';
            const msg = result.reason && result.reason.message ? result.reason.message : String(result.reason);
            if (result.reason.name === 'AbortError' || /abort/i.test(msg)) {
              return 'timeout after 15s';
            }
            return msg || 'load failed';
          }
          try {
            const [issueResult, timelineResult, historyResult] = await Promise.allSettled([
              fetchJson(urls.issue, { signal: controller.signal }),
              fetchJson(urls.timeline, { signal: controller.signal }),
              fetchJson(urls.history, { signal: controller.signal })
            ]);
            clearTimeout(timeout);
            const errors = [];
            if (issueResult.status === 'fulfilled') {
              state.issue = issueResult.value;
            } else {
              errors.push('issue: ' + reasonText(issueResult));
            }
            if (timelineResult.status === 'fulfilled') {
              state.timeline = Array.isArray(timelineResult.value) ? timelineResult.value : [];
            } else {
              errors.push('timeline: ' + reasonText(timelineResult));
            }
            if (historyResult.status === 'fulfilled') {
              state.history = historyResult.value;
            } else {
              errors.push('history: ' + reasonText(historyResult));
            }
            if (state.issue) {
              bootLog('ok', 'load() got issue · errors=' + errors.length);
              render();
              if (errors.length === 0) {
                setConnectionStatus('online');
              } else {
                // partial success — keep UI usable but flag the issue
                setLoadError(errors.join(' · '), { recoverable: true });
              }
            } else {
              // hard fail — couldn't even read the main issue
              bootLog('error', 'load() HARD FAIL: ' + (errors[0] || 'no issue'));
              setLoadError(errors[0] || 'Load failed', { recoverable: true, hard: true });
              if (!opts.silent) throw new Error(errors[0] || 'Load failed');
            }
          } catch (e) {
            clearTimeout(timeout);
            if (!state.issue) {
              const msg = (e && e.message) ? e.message : 'Load failed';
              setLoadError(msg, { recoverable: true, hard: true });
            }
            if (!opts.silent) throw e;
          }
        }
        function setLoadError(message, opts) {
          const o = opts || {};
          state.connection = 'offline';
          // Always log the failure to the browser console so DevTools shows the real cause.
          try { console.warn('[symphonyness mini app] load error', { message, urls, opts: o }); } catch (_) {}
          if (el.connectionBanner) {
            el.connectionBanner.dataset.wasOffline = '1';
            el.connectionBanner.hidden = false;
            el.connectionBanner.classList.remove('is-online');
            const heading = t('error.load_failed');
            const detailText = message ? message : t('error.unknown');
            el.connectionBanner.innerHTML = '<strong>' + escapeHtml(heading) + '</strong>'
              + escapeHtml(detailText)
              + '<small>' + escapeHtml('GET ' + urls.issue) + '</small>';
          }
          if (o.hard) {
            // Replace skeleton placeholders with a clear, readable message — otherwise users see only spinners.
            const headline = t('error.cannot_load');
            const tip = t('error.cannot_load_tip');
            if (el.issueTitle) {
              el.issueTitle.innerHTML = '<span class="issue-id">' + escapeHtml(issueId) + '</span><span class="issue-title-text">' + escapeHtml(headline) + '</span>';
            }
            if (el.repoLine) {
              el.repoLine.innerHTML = githubMark() + '<span>' + escapeHtml(t('label.repo')) + '</span><span class="repo-name">' + escapeHtml(t('label.unavailable')) + '</span>';
            }
            if (el.statusLine) {
              el.statusLine.innerHTML = chip(t('label.offline'), 'yellow');
            }
            if (el.judgmentCopy) el.judgmentCopy.textContent = headline + ' ' + (message ? '(' + message + ')' : '');
            if (el.nextCopy) el.nextCopy.textContent = tip;
            if (el.timelineList) el.timelineList.innerHTML = '<div class="loading">' + escapeHtml(headline) + '</div>';
          }
          renderDiagnostics({ force: true });
        }
        let streamRetryTimer = null;
        function closeStream() {
          if (state.stream) {
            try { state.stream.close(); } catch (_) {}
            state.stream = null;
          }
          if (streamRetryTimer) {
            clearTimeout(streamRetryTimer);
            streamRetryTimer = null;
          }
        }
        function scheduleStreamRetry(delayMs) {
          if (streamRetryTimer) return;
          setConnectionStatus('reconnecting');
          streamRetryTimer = setTimeout(() => {
            streamRetryTimer = null;
            openStream();
          }, Math.max(800, delayMs || 3000));
        }
        function openStream() {
          closeStream();
          setConnectionStatus('connecting');
          try {
            state.stream = new EventSource(urls.stream);
            state.stream.addEventListener('open', () => setConnectionStatus('online'));
            state.stream.addEventListener('issue', (event) => {
              setConnectionStatus('online');
              const issue = JSON.parse(event.data);
              if (issue && (issue.issue_id === state.issue.issue_id || issue.identifier === state.issue.identifier)) {
                state.issue = issue;
                render();
              }
            });
            state.stream.addEventListener('timeline', (event) => {
              setConnectionStatus('online');
              const item = JSON.parse(event.data);
              if (item && state.issue && item.issue_id === state.issue.issue_id) {
                state.timeline = [item].concat(state.timeline).slice(0, 20);
                renderTimeline();
              }
            });
            state.stream.addEventListener('error', () => {
              setConnectionStatus('offline');
              if (state.stream && state.stream.readyState === EventSource.CLOSED) {
                scheduleStreamRetry(3000);
              }
            });
          } catch (_) {
            setConnectionStatus('offline');
            scheduleStreamRetry(3000);
          }
        }
        function reconnectStream() {
          closeStream();
          load().then(openStream).catch(() => setConnectionStatus('offline'));
        }
        async function postRuntimeIssueAction(action) {
          if (!state.issue) return;
          const targetId = state.issue.issue_id || state.issue.identifier || issueId;
          const result = await fetchJson('/api/v1/runtime/issues/' + encodeURIComponent(targetId) + '/' + action, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' }
          });
          renderExpandableText(el.nextCopy, result.message, t('hero.retry_submitted'), 180);
          await load();
        }
        document.addEventListener('click', (event) => {
          const target = event.target;
          if (!target || !target.closest) return;
          const button = target.closest('button');
          if (!button) {
            const groupRow = target.closest('.group-row');
            if (groupRow) toggleActivityGroup(groupRow);
            return;
          }
          if (button.hasAttribute('data-diff-toggle')) {
            const idx = parseInt(button.getAttribute('data-diff-toggle') || '-1', 10);
            if (idx >= 0) {
              if (!state.diffOpen) state.diffOpen = {};
              state.diffOpen[idx] = !state.diffOpen[idx];
              renderDiff(state.issue);
            }
            return;
          }
          if (button.classList.contains('expand-button')) {
            toggleExpandedText(button);
          }
        });
        document.addEventListener('keydown', (event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          const target = event.target;
          if (!target || !target.classList || !target.classList.contains('group-row')) return;
          event.preventDefault();
          toggleActivityGroup(target);
        });
        function toggleActivityGroup(row) {
          const idx = parseInt(row.getAttribute('data-group-index') || '-1', 10);
          if (idx < 0) return;
          if (!state.activityOpenGroups) state.activityOpenGroups = {};
          state.activityOpenGroups[idx] = !state.activityOpenGroups[idx];
          renderTimeline();
        }
        document.querySelectorAll('[data-runtime-action]').forEach((button) => {
          button.addEventListener('click', () => {
            const action = button.getAttribute('data-runtime-action');
            if (action === 'back' && tg) {
              tg.close();
            }
            if (action === 'history') {
              setActiveTab('delivery');
              renderHistoryPanel();
              if (el.historyEntryList && el.historyToggleButton) {
                el.historyEntryList.removeAttribute('hidden');
                el.historyToggleButton.textContent = t('action.collapse_log');
              }
              if (el.historyPanel && el.historyPanel.scrollIntoView) {
                el.historyPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }
            }
            if (action === 'retry') {
              button.disabled = true;
              button.textContent = t('hero.retrying');
              if (tg && tg.HapticFeedback) {
                tg.HapticFeedback.impactOccurred('medium');
              }
              postRuntimeIssueAction('retry').catch((error) => {
                button.disabled = false;
                button.textContent = t('action.retry');
                const fallbackMsg = t('hero.retry_failed');
                if (tg) {
                  tg.showAlert(error.message || fallbackMsg);
                } else {
                  el.nextCopy.textContent = error.message || fallbackMsg;
                }
              });
            }
            if (action === 'pause' && tg) {
              tg.HapticFeedback && tg.HapticFeedback.impactOccurred('medium');
              tg.showAlert(t('hero.pause_info'));
            }
            if (action === 'request' && tg) {
              tg.showAlert(t('hero.request_info'));
            }
          });
        });
        el.tabButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const tab = button.getAttribute('data-tab');
            if (tab) setActiveTab(tab);
          });
        });
        el.tabPanels.forEach((panel) => {
          panel.addEventListener('scroll', () => {
            const tab = panel.getAttribute('data-tab-panel');
            if (tab) state.tabScrolls[tab] = panel.scrollTop;
          }, { passive: true });
        });
        el.langButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const lang = button.getAttribute('data-lang');
            if (lang) {
              applyLanguage(lang);
              try { localStorage.setItem('symphonyness:lang', state.lang); } catch (_) {}
            }
          });
        });
        el.themeButtons.forEach((button) => {
          button.addEventListener('click', () => {
            const theme = button.getAttribute('data-theme-pick');
            if (theme) {
              applyTheme(theme);
              try { localStorage.setItem('symphonyness:theme', state.theme); } catch (_) {}
            }
          });
        });
        if (el.connectionBanner) {
          el.connectionBanner.addEventListener('click', () => {
            if (state.connection === 'online') return;
            // Reload full data + stream so UI recovers from a hard load failure too
            setConnectionStatus('reconnecting');
            load({ silent: true }).then(() => openStream()).catch(() => {});
          });
        }
        if (el.diagnosticsRetry) {
          el.diagnosticsRetry.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setConnectionStatus('reconnecting');
            load({ silent: true }).then(() => openStream()).catch(() => {});
          });
        }
        applyLanguage(detectPreferredLang());
        // Seed initial diagnostic rows so users see the URLs we're about to call
        renderDiagnostics();
        if (el.historyToggleButton) {
          el.historyToggleButton.addEventListener('click', toggleHistoryEntries);
        }
        try {
          const savedTheme = localStorage.getItem('symphonyness:theme');
          if (savedTheme === 'light' || savedTheme === 'dark') applyTheme(savedTheme);
          else applyTheme(pickThemeFromTelegram() || 'dark');
        } catch (_) {
          applyTheme(pickThemeFromTelegram() || 'dark');
        }
        try {
          const savedTab = localStorage.getItem('symphonyness:tab');
          if (savedTab && el.tabButtons.some((b) => b.getAttribute('data-tab') === savedTab)) {
            setActiveTab(savedTab);
          }
        } catch (_) {}
        if (tg && typeof tg.onEvent === 'function') {
          tg.onEvent('themeChanged', () => {
            // only auto-switch when the user has not made a manual choice
            try {
              if (!localStorage.getItem('symphonyness:theme')) {
                applyTheme(pickThemeFromTelegram() || state.theme);
              }
            } catch (_) {
              applyTheme(pickThemeFromTelegram() || state.theme);
            }
          });
          tg.onEvent('viewportChanged', () => {
            if (state.connection !== 'online') reconnectStream();
          });
        }
        document.addEventListener('visibilitychange', () => {
          if (!document.hidden && state.connection !== 'online') {
            reconnectStream();
          }
        });
        const stallHint = setTimeout(() => {
          if (!state.issue) {
            const msg = t('error.still_loading');
            if (el.connectionBanner) {
              el.connectionBanner.dataset.wasOffline = '1';
              el.connectionBanner.hidden = false;
              el.connectionBanner.classList.remove('is-online');
              el.connectionBanner.textContent = msg;
            }
          }
        }, 8000);
        bootLog('', 'kicking off initial load()…');
        load().then(() => {
          clearTimeout(stallHint);
          bootLog('ok', 'initial load() resolved · opening stream');
          openStream();
        }).catch((error) => {
          clearTimeout(stallHint);
          const detail = error && error.message ? error.message : 'Load failed';
          bootLog('error', 'initial load() rejected · ' + detail);
          setLoadError(detail, { hard: !state.issue, recoverable: true });
        });
      })();
    </script>
  </body>
</html>`;
}
