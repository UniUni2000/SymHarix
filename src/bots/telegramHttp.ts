import { spawn } from 'node:child_process';
import * as https from 'node:https';

function isTelegramApiUrl(input: RequestInfo | URL): boolean {
  const raw = typeof input === 'string'
    ? input
    : input instanceof URL
      ? input.toString()
      : input instanceof Request
        ? input.url
        : String(input);
  return raw.startsWith('https://api.telegram.org/');
}

function isTelegramTlsVerificationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /certificate verification error|ssl_error_syscall|ssl connect/i.test(message);
}

function isTelegramNetworkError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /unable to connect|failed to connect|connection timed out|timed out|connection reset|network error|fetch failed/i.test(message);
}

function hasProxyEnv(): boolean {
  return Boolean(
    process.env.HTTP_PROXY?.trim()
      || process.env.HTTPS_PROXY?.trim()
      || process.env.http_proxy?.trim()
      || process.env.https_proxy?.trim(),
  );
}

function normalizeUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  if (input instanceof Request) {
    return input.url;
  }
  return String(input);
}

function multipartEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r|\n/g, '_');
}

async function serializeMultipartFormData(form: FormData): Promise<{
  body: Buffer;
  contentType: string;
}> {
  const boundary = `----symphony-telegram-${crypto.randomUUID().replace(/-/g, '')}`;
  const chunks: Buffer[] = [];
  const write = (value: string | Buffer): void => {
    chunks.push(typeof value === 'string' ? Buffer.from(value) : value);
  };

  for (const [key, value] of form.entries()) {
    write(`--${boundary}\r\n`);
    if (typeof value === 'string') {
      write(`Content-Disposition: form-data; name="${multipartEscape(key)}"\r\n\r\n`);
      write(value);
      write('\r\n');
      continue;
    }

    const filename = 'name' in value && typeof value.name === 'string' && value.name.trim()
      ? value.name
      : `${key}.bin`;
    const contentType = value.type || 'application/octet-stream';
    write(
      `Content-Disposition: form-data; name="${multipartEscape(key)}"; filename="${multipartEscape(filename)}"\r\n` +
      `Content-Type: ${contentType}\r\n\r\n`,
    );
    write(Buffer.from(await value.arrayBuffer()));
    write('\r\n');
  }
  write(`--${boundary}--\r\n`);

  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function nodeHttpsFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = normalizeUrl(input);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  const bodyValue = init?.body == null ? null : String(init.body);

  return new Promise<Response>((resolve, reject) => {
    const req = https.request(url, {
      method,
      headers: Object.fromEntries(headers.entries()),
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      res.on('end', () => {
        resolve(new Response(Buffer.concat(chunks), {
          status: res.statusCode ?? 0,
          headers: res.headers as Record<string, string>,
        }));
      });
    });
    req.on('error', reject);
    if (bodyValue) {
      req.write(bodyValue);
    }
    req.end();
  });
}

async function curlFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = normalizeUrl(input);
  const method = init?.method ?? 'GET';
  const headers = new Headers(init?.headers);
  let stdinValue: string | Buffer = '';
  const timeoutSeconds = Number.parseInt(process.env.SYMPHONY_TELEGRAM_CURL_TIMEOUT_SECONDS || '', 10);

  const args = [
    '-sS',
    '--max-time',
    String(Number.isFinite(timeoutSeconds) && timeoutSeconds > 0 ? timeoutSeconds : 15),
    '-X',
    method,
    url,
    '-w',
    '\n__HTTP_STATUS__:%{http_code}',
  ];

  if (init?.body instanceof FormData) {
    const multipart = await serializeMultipartFormData(init.body);
    headers.set('Content-Type', multipart.contentType);
    headers.set('Content-Length', String(multipart.body.length));
    stdinValue = multipart.body;
    args.push('--data-binary', '@-');
  } else if (init?.body != null) {
    stdinValue = String(init.body);
    args.push('--data-binary', '@-');
  }

  for (const [key, value] of headers.entries()) {
    args.push('-H', `${key}: ${value}`);
  }

  return new Promise<Response>((resolve, reject) => {
    const child = spawn('curl', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const marker = '\n__HTTP_STATUS__:';
      const markerIndex = stdout.lastIndexOf(marker);
      if (markerIndex === -1) {
        reject(new Error(stderr.trim() || `curl transport failed with code ${code ?? 'unknown'}`));
        return;
      }
      const rawBody = stdout.slice(0, markerIndex);
      const rawStatus = stdout.slice(markerIndex + marker.length).trim();
      const status = Number(rawStatus);
      if (!Number.isFinite(status) || status <= 0) {
        reject(new Error(stderr.trim() || `curl transport returned an invalid HTTP status: ${rawStatus}`));
        return;
      }
      resolve(new Response(rawBody, { status }));
    });

    child.stdin.on('error', () => undefined);
    child.stdin.end(stdinValue);
  });
}

export function createTelegramApiFetch(
  primaryFetch: typeof fetch,
  fallbackFetch?: typeof fetch,
): typeof fetch {
  const effectiveFallback = fallbackFetch ?? (curlFetch as typeof fetch);
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    try {
      return await primaryFetch(input, init);
    } catch (error) {
      if (
        !isTelegramApiUrl(input)
        || (!isTelegramTlsVerificationError(error) && !isTelegramNetworkError(error))
      ) {
        throw error;
      }
      return effectiveFallback(input, init);
    }
  }) as typeof fetch;
}

export function createDefaultTelegramApiFetch(): typeof fetch {
  const runtimeFetch = ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch;
  const fallbackChain = createTelegramApiFetch(
    runtimeFetch,
    createTelegramApiFetch(
      telegramNodeHttpsFetch,
      curlFetch as typeof fetch,
    ),
  );
  if (!hasProxyEnv()) {
    return fallbackChain;
  }
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    if (isTelegramApiUrl(input)) {
      return curlFetch(input, init);
    }
    return fallbackChain(input, init);
  }) as typeof fetch;
}

export const telegramNodeHttpsFetch = nodeHttpsFetch as typeof fetch;
