import { describe, expect, test } from 'bun:test';
import { FeishuNotifier } from './feishu';

describe('FeishuNotifier', () => {
  test('uses Feishu web URL AppLinks for runtime web app buttons by default', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tenant-token',
          expire: 7200,
        }));
      }
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { message_id: 'om_card' },
      }));
    }) as typeof fetch;
    const notifier = new FeishuNotifier({
      appId: 'cli_a',
      appSecret: 'secret',
      operationsChatId: null,
      operatorIds: new Set(),
      apiBaseUrl: 'https://open.feishu.test/open-apis',
      publicBaseUrl: 'https://runtime.example.test',
      runtimeAppLinkMode: 'window',
      runtimeAppLinkWidth: 680,
      runtimeAppLinkHeight: 900,
      runtimeAppLinkTemplate: null,
    }, fetcher);

    await notifier.sendMessage(
      {
        transport: 'feishu',
        conversation_id: 'oc_chat',
      },
      {
        text: 'Runtime card',
        action_rows: [[
          {
            label: 'Open Runtime View',
            style: 'primary',
            web_app: { url: '/runtime/issues/TES-149/app' },
          },
        ]],
      },
    );

    const sendCall = calls.find((call) => call.url.includes('/im/v1/messages?receive_id_type=chat_id'));
    const sendBody = JSON.parse(String(sendCall?.init?.body ?? '{}'));
    const card = JSON.parse(String(sendBody.content ?? '{}'));
    const button = card.elements.at(-1)?.actions?.[0];
    expect(String(button.url).startsWith('https://applink.feishu.cn/client/web_url/open?')).toBe(true);
    expect(button.url).toContain('url=https%3A%2F%2Fruntime.example.test%2Fruntime%2Fissues%2FTES-149%2Fapp');
    expect(button.url).toContain('mode=window');
    expect(button.url).toContain('width=680');
    expect(button.url).toContain('height=900');
  });

  test('turns runtime web app buttons into Feishu web app AppLinks when configured', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tenant-token',
          expire: 7200,
        }));
      }
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { message_id: 'om_card' },
      }));
    }) as typeof fetch;
    const notifier = new FeishuNotifier({
      appId: 'cli_a',
      appSecret: 'secret',
      operationsChatId: null,
      operatorIds: new Set(),
      apiBaseUrl: 'https://open.feishu.test/open-apis',
      publicBaseUrl: 'http://127.0.0.1:8080',
      runtimeOpenMode: 'applink_web_app',
      runtimeAppLinkMode: 'window',
      runtimeAppLinkWidth: 680,
      runtimeAppLinkHeight: 900,
      runtimeAppLinkTemplate: null,
    }, fetcher);

    await notifier.sendMessage(
      {
        transport: 'feishu',
        conversation_id: 'oc_chat',
      },
      {
        text: 'Runtime card',
        action_rows: [[
          {
            label: 'Open Runtime View',
            style: 'primary',
            web_app: { url: '/runtime/issues/TES-149/app' },
          },
        ]],
      },
    );

    const sendCall = calls.find((call) => call.url.includes('/im/v1/messages?receive_id_type=chat_id'));
    const sendBody = JSON.parse(String(sendCall?.init?.body ?? '{}'));
    const card = JSON.parse(String(sendBody.content ?? '{}'));
    const button = card.elements.at(-1)?.actions?.[0];
    expect(String(button.url).startsWith('https://applink.feishu.cn/client/web_app/open?')).toBe(true);
    expect(button.url).toContain('appId=cli_a');
    expect(button.url).toContain('path=%2Fruntime%2Fissues%2FTES-149%2Fapp');
    expect(button.url).toContain('mode=window');
    expect(button.url).toContain('width=680');
    expect(button.url).toContain('height=900');
  });

  test('renders disabled success actions as green non-interactive status text', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
        return new Response(JSON.stringify({
          code: 0,
          msg: 'ok',
          tenant_access_token: 'tenant-token',
          expire: 7200,
        }));
      }
      return new Response(JSON.stringify({
        code: 0,
        msg: 'ok',
        data: { message_id: 'om_card' },
      }));
    }) as typeof fetch;
    const notifier = new FeishuNotifier({
      appId: 'cli_a',
      appSecret: 'secret',
      operationsChatId: null,
      operatorIds: new Set(),
      apiBaseUrl: 'https://open.feishu.test/open-apis',
      publicBaseUrl: 'https://runtime.example.test',
      runtimeOpenMode: 'applink_web_url',
      runtimeAppLinkMode: 'window',
      runtimeAppLinkWidth: 680,
      runtimeAppLinkHeight: 900,
      runtimeAppLinkTemplate: null,
    }, fetcher);

    await notifier.sendMessage(
      {
        transport: 'feishu',
        conversation_id: 'oc_chat',
      },
      {
        text: 'Runtime card',
        action_rows: [
          [
            {
              label: 'Completed',
              style: 'success',
              disabled: true,
              callback_data: 'rt|TES-149|refresh',
            },
          ],
          [
            {
              label: 'Open Runtime View',
              style: 'primary',
              web_app: { url: '/runtime/issues/TES-149/app' },
            },
          ],
        ],
      },
    );

    const sendCall = calls.find((call) => call.url.includes('/im/v1/messages?receive_id_type=chat_id'));
    const sendBody = JSON.parse(String(sendCall?.init?.body ?? '{}'));
    const card = JSON.parse(String(sendBody.content ?? '{}'));
    const statusElement = card.elements.find((element: any) => element.text?.content?.includes('Completed'));
    expect(statusElement?.text?.content).toBe('<font color="green">**Completed**</font>');
    expect(JSON.stringify(card)).not.toContain('rt|TES-149|refresh');
    expect(card.elements.some((element: any) => (
      element.tag === 'action' &&
      element.actions?.some((action: any) => action.text?.content === 'Completed')
    ))).toBe(false);
  });
});
