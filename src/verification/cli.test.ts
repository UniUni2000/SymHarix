import { describe, expect, test } from 'bun:test';
import {
  parseVerifyLiveLifecycleArgs,
  parseVerifyLiveSupervisorArgs,
  shouldRunAttachedVerifierBeforeServiceBootstrap,
} from './cli';

describe('parseVerifyLiveLifecycleArgs', () => {
  test('parses the required project slug plus optional flags', () => {
    const parsed = parseVerifyLiveLifecycleArgs([
      '--project-slug',
      'test2',
      '--timeout-ms',
      '45000',
      '--json',
      '--title-suffix',
      'nightly',
    ]);

    expect(parsed).toEqual({
      ok: true,
      command: {
        projectSlug: 'test2',
        timeoutMs: 45000,
        json: true,
        titleSuffix: 'nightly',
      },
    });
  });

  test('fails closed when project slug is missing', () => {
    const parsed = parseVerifyLiveLifecycleArgs(['--json']);

    expect(parsed.ok).toBe(false);
    expect(parsed.error).toContain('--project-slug');
  });
});

describe('parseVerifyLiveSupervisorArgs', () => {
  test('marks the live verification command as a supervisor scenario', () => {
    const parsed = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--json',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.command.projectSlug).toBe('test2');
    expect(parsed.command.timeoutMs).toBeNull();
    expect(parsed.command.json).toBe(true);
    expect(parsed.command.supervisorScenario).toBe(true);
    expect(parsed.command.titleSuffix).toStartWith('supervisor-e2e-');
  });

  test('parses attach-mode server URL and Telegram chat id for supervisor live verification', () => {
    const parsed = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--server-url',
      'http://localhost:3000',
      '--telegram-chat-id',
      '7570067877',
      '--json',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.command.projectSlug).toBe('test2');
    expect(parsed.command.timeoutMs).toBeNull();
    expect(parsed.command.json).toBe(true);
    expect(parsed.command.supervisorScenario).toBe(true);
    expect(parsed.command.titleSuffix).toStartWith('supervisor-e2e-');
    expect(parsed.command.serverUrl).toBe('http://localhost:3000');
    expect(parsed.command.telegramChatId).toBe('7570067877');
  });

  test('parses supervisor live scenario and matrix flags', () => {
    const parsed = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--server-url',
      'http://localhost:3000',
      '--telegram-chat-id',
      '7570067877',
      '--scenario',
      'governed-split',
      '--matrix',
      '--json',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(parsed.command.supervisorScenario).toBe(true);
    expect(parsed.command.supervisorLiveScenario).toBe('governed_split');
    expect(parsed.command.supervisorLiveMatrix).toBe(true);
  });

  test('marks json attach-mode supervisor verification as safe to run before service bootstrap logs', () => {
    const parsed = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--server-url',
      'http://localhost:3000',
      '--telegram-chat-id',
      '7570067877',
      '--matrix',
      '--json',
    ]);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      throw new Error(parsed.error);
    }
    expect(shouldRunAttachedVerifierBeforeServiceBootstrap(parsed.command)).toBe(true);
  });

  test('does not skip service bootstrap for non-attach or text live verification', () => {
    const attachText = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--server-url',
      'http://localhost:3000',
    ]);
    const standaloneJson = parseVerifyLiveSupervisorArgs([
      '--project-slug',
      'test2',
      '--json',
    ]);

    expect(attachText.ok).toBe(true);
    expect(standaloneJson.ok).toBe(true);
    if (!attachText.ok || !standaloneJson.ok) {
      throw new Error('parser failed');
    }
    expect(shouldRunAttachedVerifierBeforeServiceBootstrap(attachText.command)).toBe(false);
    expect(shouldRunAttachedVerifierBeforeServiceBootstrap(standaloneJson.command)).toBe(false);
  });
});
