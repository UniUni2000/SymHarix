export type RuntimeLocale = 'zh' | 'en';

export function inferRuntimeLocaleFromText(value: string | null | undefined): RuntimeLocale {
  const text = String(value || '');
  if (/[\u3400-\u9fff\uf900-\ufaff]/.test(text)) {
    return 'zh';
  }
  return 'en';
}

export function normalizeRuntimeLocale(value: string | null | undefined): RuntimeLocale | null {
  if (value === 'zh' || value === 'en') {
    return value;
  }
  return null;
}

export function runtimeLocaleInstruction(locale: RuntimeLocale | null | undefined): string {
  if (locale === 'en') {
    return [
      '## Output Language',
      '- The original user request is English. Write all user-facing summaries, recommendations, milestones, handoff notes, delivery summaries, governance text, and Mini App-visible text in English.',
      '- Keep machine-readable labels, file paths, commands, identifiers, and code symbols unchanged.',
    ].join('\n');
  }

  return [
    '## Output Language',
    '- The original user request contains Chinese. Write all user-facing summaries, recommendations, milestones, handoff notes, delivery summaries, governance text, and Mini App-visible text in Chinese.',
    '- Keep machine-readable labels, file paths, commands, identifiers, and code symbols unchanged.',
  ].join('\n');
}

export function localizeKnownRuntimeText(
  value: string | null | undefined,
  locale: RuntimeLocale | null | undefined,
): string {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text || locale !== 'en') {
    return text;
  }

  const smokeDone = text.match(/^(\S+)\s+烟雾测试已成功完成。\s+([\w./-]+)\s+中添加了一个字符，并通过了编译验证。\s+PR #(\d+) 已审查批准，无进一步行动。$/);
  if (smokeDone) {
    return `${smokeDone[1]} smoke test completed successfully. One character was added to ${smokeDone[2]}, compile verification passed, and PR #${smokeDone[3]} was approved. No further action is needed.`;
  }

  const localizeSnippet = (snippet: string | undefined): string => String(snippet || '')
    .replace(/（/g, '(')
    .replace(/）/g, ')')
    .replace(/；/g, '; ')
    .replace(/，/g, ', ')
    .replace(/。\s*$/g, '')
    .replace(/追加一个\s*character/g, 'appends one character')
    .replace(/添加了一个\s*character/g, 'adds one character')
    .replace(/追加一个字符/g, 'appends one character')
    .replace(/添加了一个字符/g, 'adds one character')
    .replace(/`([^`]+)`\s*验证/g, '`$1` verifies')
    .replace(/([A-Za-z0-9_.-]+)\s*验证/g, '$1 verifies')
    .replace(/验证/g, 'verify')
    .replace(/批准即创建/g, 'create after approval')
    .replace(/\s+/g, ' ')
    .trim();

  const continuePlan = text.match(/^继续推进计划「(.+)」。\s*完成标准：(.+?)。\s*(?:当前只推进子单\s+([^，。]+)，(.+?)。\s*)?(?:历史提醒：(.+)。)?$/);
  if (continuePlan) {
    const parts = [
      `Continue advancing plan "${continuePlan[1]}".`,
      `Acceptance: ${localizeSnippet(continuePlan[2])}.`,
      continuePlan[3]
        ? `Only advance child issue ${continuePlan[3]}; ${localizeSnippet(continuePlan[4])}.`
        : null,
      continuePlan[5] ? `History reminders: ${localizeSnippet(continuePlan[5])}.` : null,
    ].filter(Boolean);
    return parts.join(' ');
  }

  return text
    .replace(/^当前计划「(.+)」已经完成，不再向 dev agent 追加指令。$/, 'Plan "$1" is complete. No more dev-agent instructions are needed.')
    .replace(/^计划「(.+)」正在推进。$/, 'Plan "$1" is in progress.')
    .replace(/^继续推进计划「(.+)」。$/, 'Continue advancing plan "$1".')
    .replace(/^完成标准：(.+)。?$/, (_match, body) => `Acceptance: ${localizeSnippet(body)}.`)
    .replace(/^这次不把所有并列目标一起并发推进。$/, 'Do not run all parallel goals concurrently in this pass.')
    .replace(/^用户能直接在 Telegram 对话里收到显眼的推荐 issue 卡，并可以一键批准继续。$/, 'The user can receive a prominent recommended issue card directly in Telegram and approve it with one tap.')
    .replace(/^普通聊天默认走 supervisor 的自然语言收需求流程，而不是退回机械补表单。$/, 'Ordinary chat uses the supervisor natural-language intake flow instead of falling back to a mechanical form.')
    .replace(/^slash 命令继续保留明确的机器路径，不和自然对话建单体验混在一起。$/, 'Slash commands keep a clear machine-oriented path and stay separate from natural conversational issue intake.')
    .replace(/^先把 Telegram 自然对话、推荐 issue 卡批准、slash 命令边界一起收进一张更像样的 issue，再进入后续执行。$/, 'First fold Telegram conversation, recommended issue-card approval, and slash-command boundaries into a proper issue, then proceed with execution.')
    .replace(/^先把 supervisor 的自然语言收需求、推荐卡展示和 slash 命令边界整理成一版可批准计划，再按批准结果推进实现与监管流程。$/, 'First turn supervisor natural-language intake, recommended-card display, and slash-command boundaries into an approvable plan, then proceed with implementation and oversight after approval.')
    .replace(/^按推荐继续$/, 'Continue as recommended')
    .replace(/^改一下计划$/, 'Edit Plan')
    .replace(/^如果你不想按推荐路径走，我可以先把计划重写得更合适。$/, 'If you do not want the recommended path, I can revise the plan first.')
    .replace(/^按这张精简计划直接开跑。$/, 'Start directly from this compact plan.')
    .replace(/^不顺手扩展到无关模块。$/, 'Do not expand into unrelated modules.')
    .replace(/^保持单目标推进，避免顺手扩大范围。$/, 'Keep the work focused on one goal and avoid expanding scope.')
    .replace(/^不拆分、不创建 child queue；本轮只创建一张 root-only 验证单。$/, 'Do not split or create a child queue; create only one root-only verification issue in this round.')
    .replace(/^先创建 root issue，再按拆分方案落成顺序 child queue。$/, 'Create the root issue first, then materialize an ordered child queue from the split plan.')
    .replace(/^先按计划建一张受控清理任务，执行前明确范围，避免误删有效文件。$/, 'Create a controlled cleanup task from the plan, confirm scope before execution, and avoid deleting valid files.')
    .replace(/^先用更聚焦的标题和描述建单，再继续执行。$/, 'Create the issue with a more focused title and description before continuing execution.')
    .replace(/^先把源目标收成 root thread，再只放行当前 child，其余 child 顺序排队。$/, 'Turn the source goal into a root thread, release only the current child task, and keep the rest queued in order.')
    .replace(/^只创建一张 root-only 受控验证单，不扫描全仓，不创建 child queue；执行后用指定标记文件证明审批语义。$/, 'Create one root-only controlled verification issue only; do not scan the whole repo or create a child queue. Use the specified marker file after execution to prove approval semantics.')
    .replace(/^先限定清理范围，执行后用 git diff \/ 文件列表证明只清掉残余内容。$/, 'Constrain the cleanup scope first, then use git diff and file lists to prove only residual content was removed.')
    .replace(/^这类清理可能删除文件，需要先确认范围和验收方式。$/, 'This cleanup may delete files, so scope and acceptance need confirmation first.')
    .replace(/^当前验收条件还不够稳，需要先补清楚。$/, 'The acceptance criteria are not stable enough yet and need clarification first.')
    .replace(/^当前仓库仍在使用 shadow harness，验证约束可能还不稳定。$/, 'This repository is still using a shadow harness, so validation constraints may not be stable yet.')
    .replace(/^当前仓库还没有 formal harness，执行约束需要继续从运行结果里学习。$/, 'This repository does not yet have a formal harness, so execution constraints still need to be learned from runtime results.')
    .replace(/^证据已满足，正在等待最终交付动作完成。$/, 'Proof is satisfied and final delivery is pending.')
    .replace(/^证据已满足，正在等待最终交付。$/, 'Proof is satisfied and final delivery is pending.')
    .replace(/^Issue 已完成，最终交付已闭环。$/, 'Issue is complete and final delivery is closed.')
    .replace(/^计划线程已完成，最终交付已闭环。$/, 'Plan thread is complete and final delivery is closed.')
    .replace(/^已恢复自动执行，这张治理卡片已结束。$/, 'Automatic execution has resumed and this governance card is closed.')
    .replace(/^已按你的选择提交治理动作，后续状态会继续同步到这里。$/, 'Submitted the governance action you selected. Follow-up status will continue syncing here.')
    .replace(/^这张治理卡片已经处理完成，后续状态会继续同步到这里。$/, 'This governance card has been processed. Follow-up status will continue syncing here.')
    .replace(/^Review 正在检查交付质量。$/, 'Review is checking delivery quality.')
    .replace(/^Dev agent 正在推进当前轮次。$/, 'The dev agent is advancing the current round.')
    .replace(/^等待 supervisor 写入下一步动作。$/, 'Waiting for the supervisor to write the next action.')
    .replace(/^等待下一步运行时信号。$/, 'Waiting for the next runtime signal.')
    .replace(/^当前只推进最有把握的下一步，保持 child 队列有序。$/, 'The system is advancing the highest-confidence next step and keeping child work ordered.')
    .replace(/## Review Summary \*\*变更审查\*\*/g, '## Review Summary **Change assessed**')
    .replace(/\*\*验证结果\*\*：/g, '**Verification result**: ')
    .replace(/\*\*变更审查\*\*：/g, '**Change assessed**: ')
    .replace(/未尾追加一个/g, 'appended one')
    .replace(/追加一个\s*character/g, 'appends one character')
    .replace(/添加了一个\s*character/g, 'adds one character')
    .replace(/追加一个字符/g, 'appends one character')
    .replace(/添加了一个字符/g, 'adds one character')
    .replace(/`([^`]+)`\s*验证/g, '`$1` verifies')
    .replace(/批准即创建/g, 'create after approval')
    .replace(/；/g, '; ')
    .replace(/字符/g, 'character')
    .replace(/无进一步行动/g, 'no further action');
}
