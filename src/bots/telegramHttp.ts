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
  const bodyValue = init?.body == null ? '' : String(init.body);

  const args = [
    '-sS',
    '-X',
    method,
    url,
    '-w',
    '\n__HTTP_STATUS__:%{http_code}',
  ];

  for (const [key, value] of headers.entries()) {
    args.push('-H', `${key}: ${value}`);
  }

  if (bodyValue) {
    args.push('--data-binary', '@-');
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
    child.stdin.end(bodyValue);
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
      if (!isTelegramApiUrl(input) || !isTelegramTlsVerificationError(error)) {
        throw error;
      }
      return effectiveFallback(input, init);
    }
  }) as typeof fetch;
}

export function createDefaultTelegramApiFetch(): typeof fetch {
  const runtimeFetch = ((input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init)) as typeof fetch;
  return createTelegramApiFetch(
    runtimeFetch,
    createTelegramApiFetch(
      telegramNodeHttpsFetch,
      curlFetch as typeof fetch,
    ),
  );
}

export const telegramNodeHttpsFetch = nodeHttpsFetch as typeof fetch;
