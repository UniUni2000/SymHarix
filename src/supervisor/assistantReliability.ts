export function isAcknowledgementOnlyText(text: string): boolean {
  return /^(?:好的?|好吧|嗯+|行|可以|收到|没事(?:儿)?|没事(?:儿)?[，,\s]*先这样(?:吧)?|先这样(?:吧)?|不用了?|不用管|算了|先放着|ok|okay|sure|never\s*mind|all\s*good|随便你看看|你看着办)[!！,.，。?？\s]*$/i.test(text.trim());
}

export function buildNoActionAssistantReply(text: string): string {
  const trimmed = text.trim();
  if (/^(你好|您好|hello|hi|hey|在吗|在么)/i.test(trimmed)) {
    return '你好，我在。你可以直接问我 issue 状态、仓库内容，或者让我起草下一步计划。';
  }

  if (/^(?:确认|是的|是|对|对的|没错|yes|y|confirm|执行|继续)$/i.test(trimmed)) {
    return [
      '我这里没有需要你确认的动作，所以不会误执行。',
      '你可以直接说下一步要做什么，或者问我当前 issue、仓库、卡片状态。',
    ].join('\n');
  }

  if (/^(?:取消|cancel|no|n|停止)$/i.test(trimmed)) {
    return [
      '好的，我没有找到正在等待取消的动作，也不会改动任何东西。',
      '如果你是想取消某张单，请直接说：取消 INT-xxx。',
    ].join('\n');
  }

  if (isAcknowledgementOnlyText(trimmed)) {
    return [
      '好的，先保持当前状态。',
      '我不会启动新动作；需要时你直接问状态、看卡片，或者继续提新的 issue 就行。',
    ].join('\n');
  }

  return [
    '我接住了，但这句话本身不需要我执行动作。',
    '你可以继续自然地问，我会先查上下文，再判断该回答、建议、确认，还是进后台执行。',
  ].join('\n');
}

export function formatToolArgumentRejection(toolName: string, validationError: string): string {
  if (/issue_id is required/i.test(validationError)) {
    const example = toolName === 'retry_issue'
      ? '重试 INT-158'
      : toolName === 'stop_issue'
        ? '停止 INT-158'
        : '处理 INT-158';
    return [
      '这个动作还缺少 issue id，所以我没有执行任何写入。',
      `请直接说清楚目标，例如：${example}。`,
    ].join('\n');
  }
  if (/project_slug is required/i.test(validationError)) {
    return [
      '这个动作还缺少项目名，所以我没有切换默认项目。',
      '请直接说：set project to test2。',
    ].join('\n');
  }
  if (/title is required/i.test(validationError)) {
    return [
      '这个 issue 还缺少标题，所以我没有创建任何东西。',
      '请用一句话说明要做什么，我会先整理成可确认的 issue。',
    ].join('\n');
  }
  return [
    '这个动作还缺少必要信息，所以我没有执行任何写入。',
    '请补充目标或换一句自然语言描述，我会重新判断。',
  ].join('\n');
}

export function formatUnsupportedToolRecovery(): string {
  return [
    '这个请求没有执行，因为我没有找到一个稳定可用的动作入口。',
    '我没有改动任何东西。你可以换成：查状态、读仓库、建议 issue，或者明确说重试/停止/取消某个 INT-xxx。',
  ].join('\n');
}

export function formatToolFailureRecovery(toolName: string): string {
  if (toolName === 'read_repo_with_claude') {
    return [
      '仓库只读分析暂时失败，但我没有改动任何东西。',
      '你可以先查 active issues、问某个 INT-xxx 的状态，或者稍后再让我读仓库。',
    ].join('\n');
  }
  if (toolName === 'create_issue' || toolName === 'close_issue' || toolName === 'supersede_issue') {
    return [
      '这个写入动作暂时没有完成，我已经停在安全状态。',
      '我没有继续执行后续步骤。请让我先查这个 issue 的当前状态，再决定是否重试。',
    ].join('\n');
  }
  return [
    '这一步暂时失败了，我已经停在安全状态。',
    '我没有改动任何东西。你可以换一句话重试，或者先让我查当前状态。',
  ].join('\n');
}

export function formatPendingActionReminder(summary: string): string {
  const firstLine = summary.split('\n').find((line) => line.trim()) ?? '待确认动作';
  return [
    `我这里还有一个等待确认的动作：${firstLine}`,
    '请回复“确认”执行，或回复“取消”放弃。你也可以直接问状态或仓库内容，我会先回答你的问题。',
  ].join('\n');
}

export function formatDuplicateToolRecovery(lastMessage: string | null): string {
  return [
    '我已经用同样条件查过一次，不会重复空转。',
    lastMessage ? `目前能确认的是：${lastMessage}` : '目前没有新的事实变化。',
    '你可以让我给结论，或者换一个更具体的问题继续查。',
  ].join('\n');
}

export function formatStepLimitRecovery(): string {
  return [
    '我先停在安全位置，避免继续空转。',
    '没有执行新的写入。你可以让我给结论、缩小问题，或者指定一个 INT-xxx 继续查。',
  ].join('\n');
}
