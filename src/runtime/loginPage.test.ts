import { describe, expect, test } from 'bun:test';
import { renderRuntimeLoginPage } from './loginPage';

describe('Runtime login page', () => {
  test('offers a server-verified Telegram Mini App identity exchange', () => {
    const page = renderRuntimeLoginPage('/runtime/issues/SYM-52/app?tab=history');

    expect(page).toContain('https://telegram.org/js/telegram-web-app.js');
    expect(page).toContain('/api/v1/runtime/auth/telegram');
    expect(page).toContain('telegram.initData');
    expect(page).not.toContain('initDataUnsafe');
    expect(page).toContain('/runtime/issues/SYM-52/app?tab=history');
  });

  test('escapes the return path before embedding it in inline JavaScript', () => {
    const page = renderRuntimeLoginPage('/runtime?</script><script>alert(1)</script>');

    expect(page).not.toContain('</script><script>alert(1)</script>');
    expect(page).toContain('\\u003c/script>');
  });
});
