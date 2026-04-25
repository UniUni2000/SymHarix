import { runtimePageClient } from './pageClient';
import { renderRuntimeMarkup } from './pageMarkup';
import { runtimePageStyles } from './pageStyles';

export function renderRuntimePage(): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Runtime</title>
    <style>${runtimePageStyles}</style>
  </head>
  <body>
    ${renderRuntimeMarkup()}
    <script>${runtimePageClient}</script>
  </body>
</html>`;
}
