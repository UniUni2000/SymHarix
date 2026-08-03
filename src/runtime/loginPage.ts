function safeReturnPath(value: string): string {
  return value.startsWith('/runtime') && !value.startsWith('//') ? value : '/runtime';
}

export function renderRuntimeLoginPage(returnPath: string): string {
  const target = safeReturnPath(returnPath);
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex,nofollow" />
    <title>SymHarix Runtime · Private</title>
    <style>
      :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; color: #edf7f5; background: radial-gradient(circle at top, #153a3c, #071112 58%); }
      main { width: min(92vw, 430px); padding: 30px; border: 1px solid rgba(147, 219, 211, .24); border-radius: 22px; background: rgba(8, 24, 25, .9); box-shadow: 0 24px 70px rgba(0, 0, 0, .42); }
      .eyebrow { margin: 0 0 10px; color: #7dd7ca; font-size: 12px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
      h1 { margin: 0; font-size: 29px; }
      p { color: #a9c5c1; line-height: 1.6; }
      label { display: block; margin: 22px 0 8px; font-size: 13px; font-weight: 700; }
      input { width: 100%; padding: 13px 14px; color: #fff; border: 1px solid #315657; border-radius: 12px; background: #09191a; outline: none; }
      input:focus { border-color: #62cbbb; box-shadow: 0 0 0 3px rgba(98, 203, 187, .13); }
      button { width: 100%; margin-top: 14px; padding: 13px 16px; border: 0; border-radius: 12px; color: #06201d; background: #78dfcf; font-weight: 800; cursor: pointer; }
      button:disabled { cursor: wait; opacity: .65; }
      #error { min-height: 22px; margin: 12px 0 0; color: #ff9f9f; font-size: 13px; }
      .hint { margin-bottom: 0; font-size: 12px; }
    </style>
  </head>
  <body>
    <main>
      <p class="eyebrow">Private control plane</p>
      <h1>Runtime 读取需要身份验证</h1>
      <p>输入 viewer 或 operator token。验证成功后，服务端只保存短期 HttpOnly 会话 Cookie。</p>
      <form id="login-form">
        <label for="runtime-token">Runtime access token</label>
        <input id="runtime-token" name="token" type="password" autocomplete="current-password" required autofocus />
        <button id="submit-button" type="submit">进入 Runtime</button>
      </form>
      <p id="error" role="alert"></p>
      <p class="hint">没有 token 时，在运行 SymHarix 的终端执行 <code>bun run runtime:access -- copy viewer</code>；安装包用户执行 <code>symharix access copy viewer</code>。复制后回到这里粘贴。需要写操作时将 <code>viewer</code> 改为 <code>operator</code>。</p>
    </main>
    <script>
      (function () {
        const form = document.getElementById('login-form');
        const input = document.getElementById('runtime-token');
        const button = document.getElementById('submit-button');
        const error = document.getElementById('error');
        form.addEventListener('submit', async function (event) {
          event.preventDefault();
          button.disabled = true;
          error.textContent = '';
          try {
            const response = await fetch('/api/v1/runtime/auth/token', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ token: String(input.value || '') })
            });
            if (!response.ok) throw new Error('Token 无效或 Runtime 尚未配置读取凭据。');
            window.location.replace(${JSON.stringify(target)});
          } catch (reason) {
            error.textContent = reason instanceof Error ? reason.message : '登录失败。';
            button.disabled = false;
            input.select();
          }
        });
      })();
    </script>
  </body>
</html>`;
}
