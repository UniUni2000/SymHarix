import { describe, expect, test } from 'bun:test';
import {
  classifySupervisorControlPlaneIntent,
  isSupervisorControlPlaneQuestion,
} from './controlPlaneIntent';

describe('supervisor control-plane intent', () => {
  test('classifies broad supervisor/runtime surface questions as runtime-owned', () => {
    const variants = [
      ['github 上还有哪些 pr 没关', 'external_sync'],
      ['Linear 里面还有开发中的单吗', 'external_sync'],
      ['INT-157 对应 PR 还在吗', 'external_sync'],
      ['这个 issue 在 GitHub 和 Linear 上状态一致吗', 'external_sync'],
      ['取消的 issue 还有残留吗', 'external_sync'],
      ['比较干净了吧', 'external_sync'],
      ['哪些失败了', 'issue_list'],
      ['失败的 issue 有哪些', 'issue_list'],
      ['完成的有哪些', 'issue_list'],
      ['review 中的任务有哪些', 'issue_list'],
      ['默认项目是什么', 'project_status'],
      ['what is the default project', 'project_status'],
      ['现在 pending 的确认有哪些', 'pending_action_status'],
      ['watch 了哪些 issue', 'watch_status'],
      ['supervisor 现在在跑什么', 'runtime_status'],
      ['现在有哪些 agent session', 'runtime_status'],
    ] as const;

    for (const [text, kind] of variants) {
      const intent = classifySupervisorControlPlaneIntent(text);
      expect(intent?.kind).toBe(kind);
      expect(intent?.preferRuntime).toBe(true);
      expect(isSupervisorControlPlaneQuestion(text)).toBe(true);
    }
  });

  test('keeps issue list details on the same broad control-plane classifier', () => {
    expect(classifySupervisorControlPlaneIntent('活跃的 issue 呢')).toEqual({
      kind: 'issue_list',
      activeOnly: true,
      stateFilter: 'active',
      preferRuntime: true,
    });
    expect(classifySupervisorControlPlaneIntent('有哪些 issue')).toEqual({
      kind: 'issue_list',
      activeOnly: false,
      stateFilter: null,
      preferRuntime: true,
    });
  });

  test('does not steal repo/code questions or explicit deep issue diagnosis from read-only repo analysis', () => {
    const variants = [
      '这个仓库有哪些文件',
      'README.md 有啥内容',
      'src/bots/assistant.ts 这文件干啥的',
      '帮我结合最新官方文档看看 API',
      'Can you create a visual demo card for the Telegram supervisor?',
      'Build a Telegram visual Plan Card',
      'what should a Telegram visual Plan Card include',
      'INT-31 卡在哪里了，正在开发什么，预计啥时候能完成？',
      '我今天只是想聊聊',
    ];

    for (const text of variants) {
      expect(classifySupervisorControlPlaneIntent(text)).toBeNull();
      expect(isSupervisorControlPlaneQuestion(text)).toBe(false);
    }
  });
});
