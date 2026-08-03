import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import type { RuntimeAccessView, RuntimeManifest, RuntimeViewerRole } from '../runtime/types';
import { readSymHarixEnv } from '../config/env';

export const RUNTIME_SESSION_COOKIE = 'symharix_runtime_session';
export const RUNTIME_CSRF_HEADER = 'x-symharix-runtime-csrf';

type RuntimeAuthSource = 'token' | 'session';
type RuntimeRequestInput = Request | Headers | Record<string, string | undefined> | undefined;

export interface RuntimePrincipal {
  subject: string;
  role: RuntimeViewerRole;
  source: RuntimeAuthSource;
  expires_at: string | null;
}

export interface RuntimeAccessDecision {
  allowed: boolean;
  access: RuntimeAccessView;
  principal: RuntimePrincipal | null;
}

export interface RuntimeSessionResult {
  allowed: boolean;
  access: RuntimeAccessView;
  principal: RuntimePrincipal | null;
  set_cookie: string | null;
}

export interface RuntimeAccessController {
  hasWriteToken(): boolean;
  hasReadCredential(): boolean;
  describe(input?: RuntimeRequestInput): RuntimeAccessView;
  authorizeRead(input?: RuntimeRequestInput): RuntimeAccessDecision;
  authorizeMutation(input?: RuntimeRequestInput): RuntimeAccessDecision;
  createTokenSession(token: string, options?: { secure?: boolean }): RuntimeSessionResult;
  clearSessionCookie(options?: { secure?: boolean }): string;
}

interface SessionPayload {
  version: 1;
  subject: string;
  role: RuntimeViewerRole;
  issued_at: number;
  expires_at: number;
}

function headersFrom(input: RuntimeRequestInput): Headers | Record<string, string | undefined> | undefined {
  return input instanceof Request ? input.headers : input;
}

function getHeaderValue(input: RuntimeRequestInput, key: string): string | null {
  const headers = headersFrom(input);
  if (!headers) {
    return null;
  }
  if (headers instanceof Headers) {
    return headers.get(key);
  }
  const target = key.toLowerCase();
  for (const [candidateKey, value] of Object.entries(headers)) {
    if (candidateKey.toLowerCase() === target) {
      return value ?? null;
    }
  }
  return null;
}

function readPresentedToken(input: RuntimeRequestInput): string | null {
  const explicit = getHeaderValue(input, 'x-symharix-runtime-token')
    ?? getHeaderValue(input, 'x-symphony-runtime-token');
  if (explicit) {
    return explicit.trim() || null;
  }
  const authorization = getHeaderValue(input, 'authorization');
  const match = authorization?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function secretMatches(presented: string | null, expected: string | null): boolean {
  if (!presented || !expected) {
    return false;
  }
  const presentedDigest = createHash('sha256').update(presented).digest();
  const expectedDigest = createHash('sha256').update(expected).digest();
  return timingSafeEqual(presentedDigest, expectedDigest);
}

function cookieValue(input: RuntimeRequestInput, name: string): string | null {
  const cookie = getHeaderValue(input, 'cookie');
  if (!cookie) {
    return null;
  }
  for (const part of cookie.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) {
      continue;
    }
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}

function encodePayload(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decodePayload(value: string): SessionPayload | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<SessionPayload>;
    if (
      parsed.version !== 1
      || typeof parsed.subject !== 'string'
      || (parsed.role !== 'viewer' && parsed.role !== 'operator')
      || typeof parsed.issued_at !== 'number'
      || typeof parsed.expires_at !== 'number'
    ) {
      return null;
    }
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

function sessionSignature(encodedPayload: string, secret: string): string {
  return createHmac('sha256', secret).update(encodedPayload).digest('base64url');
}

function safeSignatureMatch(presented: string, expected: string): boolean {
  const left = Buffer.from(presented);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function tokenSubject(token: string): string {
  return `runtime-token:${createHash('sha256').update(token).digest('hex').slice(0, 16)}`;
}

function serializeSessionCookie(value: string, options: { maxAge: number; secure: boolean }): string {
  return [
    `${RUNTIME_SESSION_COOKIE}=${value}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    options.secure ? 'Secure' : null,
    `Max-Age=${Math.max(0, Math.trunc(options.maxAge))}`,
  ].filter(Boolean).join('; ');
}

function requestIsSameOrigin(input: RuntimeRequestInput): boolean {
  if (!(input instanceof Request)) {
    return false;
  }
  const origin = getHeaderValue(input, 'origin');
  if (!origin) {
    return false;
  }
  try {
    const requestUrl = new URL(input.url);
    const originUrl = new URL(origin);
    const forwardedProto = getHeaderValue(input, 'x-forwarded-proto')?.split(',')[0]?.trim();
    const host = getHeaderValue(input, 'x-forwarded-host')?.split(',')[0]?.trim()
      || getHeaderValue(input, 'host')
      || requestUrl.host;
    const protocol = forwardedProto ? `${forwardedProto}:` : requestUrl.protocol;
    return originUrl.origin === `${protocol}//${host}`;
  } catch {
    return false;
  }
}

export function createRuntimeAccessController(options?: {
  writeToken?: string | null;
  viewerToken?: string | null;
  sessionSecret?: string | null;
  sessionTtlMinutes?: number;
  now?: () => Date;
}): RuntimeAccessController {
  const writeToken = options?.writeToken?.trim() || null;
  const viewerToken = options?.viewerToken?.trim() || null;
  const sessionSecret = options?.sessionSecret?.trim() || randomBytes(32).toString('base64url');
  const sessionTtlMinutes = Number.isFinite(options?.sessionTtlMinutes) && Number(options?.sessionTtlMinutes) > 0
    ? Math.trunc(Number(options?.sessionTtlMinutes))
    : 15;
  const now = options?.now ?? (() => new Date());

  const principalForToken = (token: string | null): RuntimePrincipal | null => {
    if (secretMatches(token, writeToken)) {
      return {
        subject: tokenSubject(token!),
        role: 'operator',
        source: 'token',
        expires_at: null,
      };
    }
    if (secretMatches(token, viewerToken)) {
      return {
        subject: tokenSubject(token!),
        role: 'viewer',
        source: 'token',
        expires_at: null,
      };
    }
    return null;
  };

  const principalForSession = (input: RuntimeRequestInput): RuntimePrincipal | null => {
    const session = cookieValue(input, RUNTIME_SESSION_COOKIE);
    if (!session) {
      return null;
    }
    const separator = session.indexOf('.');
    if (separator <= 0) {
      return null;
    }
    const encodedPayload = session.slice(0, separator);
    const signature = session.slice(separator + 1);
    if (!safeSignatureMatch(signature, sessionSignature(encodedPayload, sessionSecret))) {
      return null;
    }
    const payload = decodePayload(encodedPayload);
    if (!payload || payload.expires_at <= Math.floor(now().getTime() / 1000)) {
      return null;
    }
    return {
      subject: payload.subject,
      role: payload.role,
      source: 'session',
      expires_at: new Date(payload.expires_at * 1000).toISOString(),
    };
  };

  const resolvePrincipal = (input: RuntimeRequestInput): RuntimePrincipal | null => (
    principalForToken(readPresentedToken(input)) ?? principalForSession(input)
  );

  const accessView = (principal: RuntimePrincipal | null): RuntimeAccessView => ({
    mode: principal ? 'token' : 'read_only',
    viewer_role: principal?.role ?? 'viewer',
    can_create_issue: principal?.role === 'operator',
    can_control_issues: principal?.role === 'operator',
    token_required: true,
    authenticated: Boolean(principal),
    auth_source: principal?.source ?? null,
    session_expires_at: principal?.expires_at ?? null,
  });

  const authorizeRead = (input?: RuntimeRequestInput): RuntimeAccessDecision => {
    const principal = resolvePrincipal(input);
    return {
      allowed: Boolean(principal),
      access: accessView(principal),
      principal,
    };
  };

  return {
    hasWriteToken: () => Boolean(writeToken),
    hasReadCredential: () => Boolean(writeToken || viewerToken),
    describe: (input) => accessView(resolvePrincipal(input)),
    authorizeRead,
    authorizeMutation(input) {
      const headerPrincipal = principalForToken(readPresentedToken(input));
      if (headerPrincipal?.role === 'operator') {
        return {
          allowed: true,
          access: accessView(headerPrincipal),
          principal: headerPrincipal,
        };
      }
      const sessionPrincipal = principalForSession(input);
      const sessionAllowed = sessionPrincipal?.role === 'operator'
        && getHeaderValue(input, RUNTIME_CSRF_HEADER) === '1'
        && requestIsSameOrigin(input);
      return {
        allowed: Boolean(sessionAllowed),
        access: accessView(sessionPrincipal),
        principal: sessionPrincipal,
      };
    },
    createTokenSession(token, sessionOptions = {}) {
      const principal = principalForToken(token.trim() || null);
      if (!principal) {
        return {
          allowed: false,
          access: accessView(null),
          principal: null,
          set_cookie: null,
        };
      }
      const issuedAt = Math.floor(now().getTime() / 1000);
      const expiresAt = issuedAt + sessionTtlMinutes * 60;
      const payload: SessionPayload = {
        version: 1,
        subject: principal.subject,
        role: principal.role,
        issued_at: issuedAt,
        expires_at: expiresAt,
      };
      const encodedPayload = encodePayload(payload);
      const sessionValue = `${encodedPayload}.${sessionSignature(encodedPayload, sessionSecret)}`;
      const sessionPrincipal: RuntimePrincipal = {
        ...principal,
        source: 'session',
        expires_at: new Date(expiresAt * 1000).toISOString(),
      };
      return {
        allowed: true,
        access: accessView(sessionPrincipal),
        principal: sessionPrincipal,
        set_cookie: serializeSessionCookie(sessionValue, {
          maxAge: sessionTtlMinutes * 60,
          secure: sessionOptions.secure === true,
        }),
      };
    },
    clearSessionCookie(sessionOptions = {}) {
      return serializeSessionCookie('', {
        maxAge: 0,
        secure: sessionOptions.secure === true,
      });
    },
  };
}

export function createRuntimeAccessControllerFromEnv(): RuntimeAccessController {
  const ttl = Number(readSymHarixEnv('SYMPHONY_RUNTIME_SESSION_TTL_MINUTES'));
  return createRuntimeAccessController({
    writeToken: readSymHarixEnv('SYMPHONY_RUNTIME_WRITE_TOKEN') || null,
    viewerToken: readSymHarixEnv('SYMPHONY_RUNTIME_VIEWER_TOKEN') || null,
    sessionSecret: readSymHarixEnv('SYMPHONY_RUNTIME_SESSION_SECRET') || null,
    sessionTtlMinutes: Number.isFinite(ttl) && ttl > 0 ? ttl : undefined,
  });
}

export function buildRuntimeManifest(access: RuntimeAccessView, options: {
  publicBaseUrl?: string | null;
  miniAppBaseUrl?: string | null;
} = {}): RuntimeManifest {
  const publicBaseUrl = options.publicBaseUrl?.replace(/\/+$/, '') || null;
  const miniAppBaseUrl = options.miniAppBaseUrl?.replace(/\/+$/, '') || publicBaseUrl;
  return {
    access,
    public_base_url: publicBaseUrl,
    mini_app_base_url: miniAppBaseUrl,
    features: {
      history_replay: true,
      message_summaries: true,
      subscription_preferences: true,
    },
  };
}
