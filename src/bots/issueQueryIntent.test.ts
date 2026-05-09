import { describe, expect, test } from 'bun:test';
import {
  classifyIssueQueryIntent,
  isActiveIssueListQuestion,
  isIssueListQuestion,
} from './issueQueryIntent';

describe('issue query intent', () => {
  test('classifies active issue list variants as runtime active-only queries', () => {
    const variants = [
      '活跃的 issue 呢',
      '活跃的呢',
      '当前活跃 issue',
      '现在有哪些活跃工单',
      '有正在跑的单子吗',
      '正在处理哪些任务',
      '哪些 issue 还在开发',
      '哪些 issue 正在 review',
      '还有哪些没结束的 issue',
      '未完成的 ticket 有哪些',
      'open issues',
      'in progress issues',
      'active issues',
      'running tickets',
      'what is running',
      "what's running",
    ];

    for (const text of variants) {
      expect(classifyIssueQueryIntent(text)).toMatchObject({
        kind: 'issue_list',
        activeOnly: true,
      });
      expect(isIssueListQuestion(text)).toBe(true);
      expect(isActiveIssueListQuestion(text)).toBe(true);
    }
  });

  test('classifies general issue list variants without active-only filtering', () => {
    const variants = [
      '有哪些 issue',
      '当前有哪些 issue？',
      'issue 列表',
      '列一下 issues',
      '当前有多少 issue',
      'list issues',
      'what issues are tracked',
    ];

    for (const text of variants) {
      expect(classifyIssueQueryIntent(text)).toMatchObject({
        kind: 'issue_list',
        activeOnly: false,
      });
      expect(isIssueListQuestion(text)).toBe(true);
      expect(isActiveIssueListQuestion(text)).toBe(false);
    }
  });

  test('does not classify repo questions, single-issue status, or issue creation as list queries', () => {
    const variants = [
      '这个仓库有哪些文件',
      'README.md 有啥内容',
      'INT-157 卡在哪里，预计什么时候完成',
      'INT-31 卡在哪里了，正在开发什么，预计啥时候能完成？',
      'issue 157 状态',
      '帮我创建 issue 修 README',
      '推荐下一个 issue',
      '如果让你来提个issue，你觉得当前最应该提的是什么',
      'if you were to suggest an issue, what should be next?',
      'what issue should we do next?',
      '我今天只是想聊聊',
    ];

    for (const text of variants) {
      expect(classifyIssueQueryIntent(text)).toBeNull();
      expect(isIssueListQuestion(text)).toBe(false);
      expect(isActiveIssueListQuestion(text)).toBe(false);
    }
  });
});
