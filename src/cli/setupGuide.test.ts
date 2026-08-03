import { describe, expect, test } from 'bun:test';
import { getSetupGuideTopic, renderSetupGuide } from './setupGuide';

describe('terminal setup guide', () => {
  test('explains commands, exact platform steps, permissions, and validation boundaries', () => {
    const guide = renderSetupGuide();

    expect(guide).toContain('bun run configure:secure');
    expect(guide).toContain('symharix configure');
    expect(guide).toContain('symharix start telegram');
    expect(guide).toContain('bun run configure:doctor');
    expect(guide).toContain('Contents=Read and write');
    expect(guide).toContain('im.message.receive_v1');
    expect(guide).toContain('Detected user id');
    expect(guide).toContain('继续使用');
    expect(guide).toContain('覆盖当前 key/token');
    expect(guide).toContain('不会改写原配置项');
    expect(guide).toContain('进入模型配置前立即用只读请求验证');
    expect(guide).toContain('gho_ OAuth token');
    expect(guide).toContain('每组最后都保留“自定义输入”');
    expect(guide).toContain('返回本阶段开头');
    expect(guide).toContain('不写入本轮输入');
    expect(guide).toContain('只有 runtime:smoke 会做一次真实模型请求');
  });

  test('keeps official credential locations next to the provider instructions', () => {
    expect(getSetupGuideTopic('linear')).toContain('linear.app/docs');
    expect(getSetupGuideTopic('github')).toContain('github.com/settings/personal-access-tokens/new');
    expect(getSetupGuideTopic('telegram')).toContain('t.me/BotFather');
    expect(getSetupGuideTopic('feishu')).toContain('open.feishu.cn/app');
    expect(getSetupGuideTopic('existing-auth')).toContain('runtime:auth -- login');
    expect(getSetupGuideTopic('deepseek')).toContain('deepseek-v4-flash');
    expect(getSetupGuideTopic('deepseek')).toContain('复用同一个 key');
  });
});
