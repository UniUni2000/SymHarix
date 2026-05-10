import { inferRuntimeLocaleFromText, type RuntimeLocale } from '../i18n/locale';

function isEnglishLocale(locale: RuntimeLocale | null | undefined): boolean {
  return locale === 'en';
}

function textForLocale(locale: RuntimeLocale | null | undefined, zh: string, en: string): string {
  return isEnglishLocale(locale) ? en : zh;
}

export function isAcknowledgementOnlyText(text: string): boolean {
  return /^(?:好的?|好吧|嗯+|行|可以|收到|没事(?:儿)?|没事(?:儿)?[，,\s]*先这样(?:吧)?|先这样(?:吧)?|不用了?|不用管|算了|先放着|ok|okay|sure|never\s*mind|all\s*good|随便你看看|你看着办)[!！,.，。?？\s]*$/i.test(text.trim());
}

function isCapabilityQuestion(text: string): boolean {
  return /(?:你能|可以|会).{0,12}(?:做什么|干什么|帮我什么|能力|功能)|(?:what|which).{0,12}(?:can|could).{0,12}you.{0,12}(?:do|help)|what\s+are\s+your\s+(?:capabilities|features)|help\b|capabilities\b/i.test(text.trim());
}

function buildCapabilityReply(locale: RuntimeLocale | null | undefined): string {
  if (isEnglishLocale(locale)) {
    return [
      "I'm your Symphony Runtime Operator Copilot. I can help you manage issues and workflows within the Symphony runtime. Here's what I can do:",
      '',
      '- Create issues with a title, description, and target project.',
      '- Check issue status and show issue card details.',
      '- Watch or unwatch issue updates.',
      '- Stop, retry, close, override, rewrite, or split issues.',
      '- Execute or dismiss governance suggestions.',
      '- Set or view the default project.',
      '- Answer runtime-related questions after checking context.',
    ].join('\n');
  }
  return [
    '我是你的 Symphony Runtime Operator Copilot，可以帮你管理 Symphony runtime 里的 issue 和工作流。具体来说，我能：',
    '',
    '- 创建新的 issue，指定标题、描述和项目。',
    '- 查看 issue 状态和卡片详情。',
    '- 监控或取消监控 issue 更新。',
    '- 停止、重试、关闭、覆盖、重写或拆分 issue。',
    '- 执行或忽略治理建议。',
    '- 设置或查看默认项目。',
    '- 先查上下文，再回答运行时相关问题。',
  ].join('\n');
}

export function buildNoActionAssistantReply(text: string): string {
  const trimmed = text.trim();
  const locale = inferRuntimeLocaleFromText(trimmed);
  if (isCapabilityQuestion(trimmed)) {
    return buildCapabilityReply(locale);
  }

  if (/^(你好|您好|hello|hi|hey|在吗|在么)/i.test(trimmed)) {
    return textForLocale(
      locale,
      '你好，我在。你可以直接问我 issue 状态、仓库内容，或者让我起草下一步计划。',
      'Hello. I can help you check issue status, inspect repository context, or draft the next plan.',
    );
  }

  if (/^(?:确认|是的|是|对|对的|没错|yes|y|confirm|执行|继续)$/i.test(trimmed)) {
    return [
      textForLocale(locale, '我这里没有需要你确认的动作，所以不会误执行。', 'There is no action waiting for your confirmation, so I will not execute anything by mistake.'),
      textForLocale(locale, '你可以直接说下一步要做什么，或者问我当前 issue、仓库、卡片状态。', 'Tell me what you want to do next, or ask about the current issue, repository, or card status.'),
    ].join('\n');
  }

  if (/^(?:取消|cancel|no|n|停止)$/i.test(trimmed)) {
    return [
      textForLocale(locale, '好的，我没有找到正在等待取消的动作，也不会改动任何东西。', 'I did not find an action waiting to be cancelled, and I will not change anything.'),
      textForLocale(locale, '如果你是想取消某张单，请直接说：取消 INT-xxx。', 'If you want to cancel a specific issue, say: cancel INT-xxx.'),
    ].join('\n');
  }

  if (isAcknowledgementOnlyText(trimmed)) {
    return [
      textForLocale(locale, '好的，先保持当前状态。', 'Okay, I will keep the current state.'),
      textForLocale(locale, '我不会启动新动作；需要时你直接问状态、看卡片，或者继续提新的 issue 就行。', 'I will not start a new action. You can ask for status, show a card, or create a new issue whenever needed.'),
    ].join('\n');
  }

  return [
    textForLocale(locale, '我明白了，但这句话本身不需要我执行动作。', 'I understand, but this message does not require me to execute an action.'),
    textForLocale(locale, '你可以继续自然地问，我会先查上下文，再判断该回答、建议、确认，还是进后台执行。', 'You can continue asking naturally. I will check context first, then decide whether to answer, suggest, ask for confirmation, or run work in the background.'),
  ].join('\n');
}

export function formatToolArgumentRejection(
  toolName: string,
  validationError: string,
  locale: RuntimeLocale | null | undefined = null,
): string {
  if (/issue_id is required/i.test(validationError)) {
    const example = isEnglishLocale(locale)
      ? toolName === 'retry_issue'
        ? 'retry INT-158'
        : toolName === 'stop_issue'
          ? 'stop INT-158'
          : 'handle INT-158'
      : toolName === 'retry_issue'
        ? '重试 INT-158'
        : toolName === 'stop_issue'
          ? '停止 INT-158'
          : '处理 INT-158';
    return [
      textForLocale(locale, '这个动作还缺少 issue id，所以我没有执行任何写入。', 'This action is missing an issue id, so I did not perform any write.'),
      textForLocale(locale, `请直接说清楚目标，例如：${example}。`, `Please specify the target directly, for example: ${example}.`),
    ].join('\n');
  }
  if (/project_slug is required/i.test(validationError)) {
    return [
      textForLocale(locale, '这个动作还缺少项目名，所以我没有切换默认项目。', 'This action is missing a project name, so I did not switch the default project.'),
      textForLocale(locale, '请直接说：set project to test2。', 'Please say: set project to test2.'),
    ].join('\n');
  }
  if (/title is required/i.test(validationError)) {
    return [
      textForLocale(locale, '这个 issue 还缺少标题，所以我没有创建任何东西。', 'This issue is missing a title, so I did not create anything.'),
      textForLocale(locale, '请用一句话说明要做什么，我会先整理成可确认的 issue。', 'Describe what you want in one sentence, and I will turn it into a confirmable issue first.'),
    ].join('\n');
  }
  return [
    textForLocale(locale, '这个动作还缺少必要信息，所以我没有执行任何写入。', 'This action is missing required information, so I did not perform any write.'),
    textForLocale(locale, '请补充目标或换一句自然语言描述，我会重新判断。', 'Please add the target or rephrase naturally, and I will evaluate it again.'),
  ].join('\n');
}

export function formatUnsupportedToolRecovery(locale: RuntimeLocale | null | undefined = null): string {
  return [
    textForLocale(locale, '这个请求没有执行，因为我没有找到一个稳定可用的动作入口。', 'I did not execute this request because I could not find a stable action entry point.'),
    textForLocale(locale, '我没有改动任何东西。你可以换成：查状态、读仓库、建议 issue，或者明确说重试/停止/取消某个 INT-xxx。', 'I did not change anything. You can ask for status, repository context, issue suggestions, or explicitly retry/stop/cancel an INT-xxx issue.'),
  ].join('\n');
}

export function formatToolFailureRecovery(toolName: string, locale: RuntimeLocale | null | undefined = null): string {
  if (toolName === 'read_repo_with_claude') {
    return [
      textForLocale(locale, '仓库只读分析暂时失败，但我没有改动任何东西。', 'Repository read-only analysis failed for now, but I did not change anything.'),
      textForLocale(locale, '你可以先查 active issues、问某个 INT-xxx 的状态，或者稍后再让我读仓库。', 'You can check active issues, ask about a specific INT-xxx issue, or ask me to read the repository again later.'),
    ].join('\n');
  }
  if (toolName === 'create_issue' || toolName === 'close_issue' || toolName === 'supersede_issue') {
    return [
      textForLocale(locale, '这个写入动作暂时没有完成，我已经停在安全状态。', 'This write action did not complete, and I stopped in a safe state.'),
      textForLocale(locale, '我没有继续执行后续步骤。请让我先查这个 issue 的当前状态，再决定是否重试。', 'I did not continue with follow-up steps. Let me check the current issue state before deciding whether to retry.'),
    ].join('\n');
  }
  return [
    textForLocale(locale, '这一步暂时失败了，我已经停在安全状态。', 'This step failed for now, and I stopped in a safe state.'),
    textForLocale(locale, '我没有改动任何东西。你可以换一句话重试，或者先让我查当前状态。', 'I did not change anything. You can rephrase and try again, or ask me to check the current state first.'),
  ].join('\n');
}

export function formatPendingActionReminder(summary: string, locale: RuntimeLocale | null | undefined = null): string {
  const firstLine = summary.split('\n').find((line) => line.trim()) ?? textForLocale(locale, '待确认动作', 'pending action');
  return [
    textForLocale(locale, `我这里还有一个等待确认的动作：${firstLine}`, `I still have an action waiting for confirmation: ${firstLine}`),
    textForLocale(locale, '请回复“确认”执行，或回复“取消”放弃。你也可以直接问状态或仓库内容，我会先回答你的问题。', 'Reply with "Confirm" to run it, or "Cancel" to abandon it. You can also ask about status or repository context first.'),
  ].join('\n');
}

export function formatDuplicateToolRecovery(lastMessage: string | null, locale: RuntimeLocale | null | undefined = null): string {
  return [
    textForLocale(locale, '我已经用同样条件查过一次，不会重复空转。', 'I already checked with the same conditions, so I will not spin on the same request.'),
    lastMessage
      ? textForLocale(locale, `目前能确认的是：${lastMessage}`, `What I can confirm so far: ${lastMessage}`)
      : textForLocale(locale, '目前没有新的事实变化。', 'There are no new facts yet.'),
    textForLocale(locale, '你可以让我给结论，或者换一个更具体的问题继续查。', 'You can ask me for a conclusion, or ask a more specific question.'),
  ].join('\n');
}

export function formatStepLimitRecovery(locale: RuntimeLocale | null | undefined = null): string {
  return [
    textForLocale(locale, '我先停在安全位置，避免继续空转。', 'I stopped in a safe place to avoid spinning further.'),
    textForLocale(locale, '没有执行新的写入。你可以让我给结论、缩小问题，或者指定一个 INT-xxx 继续查。', 'No new write was executed. You can ask for a conclusion, narrow the question, or specify an INT-xxx issue to continue.'),
  ].join('\n');
}
