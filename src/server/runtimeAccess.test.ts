import { describe, expect, test } from 'bun:test';
import {
  RUNTIME_CSRF_HEADER,
  RUNTIME_SESSION_COOKIE,
  createRuntimeAccessController,
} from './runtimeAccess';

function cookiePair(setCookie: string): string {
  return setCookie.split(';', 1)[0]!;
}

describe('Runtime access controller', () => {
  test('fails closed without a configured viewer or operator credential', () => {
    const access = createRuntimeAccessController({ sessionSecret: 'session-secret' });

    expect(access.hasReadCredential()).toBe(false);
    expect(access.authorizeRead().allowed).toBe(false);
    expect(access.authorizeMutation().allowed).toBe(false);
    expect(access.describe().authenticated).toBe(false);
  });

  test('keeps viewer and operator header permissions separate', () => {
    const access = createRuntimeAccessController({
      viewerToken: 'viewer-secret',
      writeToken: 'operator-secret',
      sessionSecret: 'session-secret',
    });
    const viewer = new Headers({ Authorization: 'Bearer viewer-secret' });
    const operator = new Headers({ 'x-symharix-runtime-token': 'operator-secret' });

    expect(access.authorizeRead(viewer).principal?.role).toBe('viewer');
    expect(access.authorizeMutation(viewer).allowed).toBe(false);
    expect(access.authorizeRead(operator).principal?.role).toBe('operator');
    expect(access.authorizeMutation(operator).allowed).toBe(true);
  });

  test('issues a secure signed session without exposing the source token', () => {
    const access = createRuntimeAccessController({
      viewerToken: 'viewer-secret',
      sessionSecret: 'session-secret',
      sessionTtlMinutes: 10,
      now: () => new Date('2026-08-01T00:00:00.000Z'),
    });
    const result = access.createTokenSession('viewer-secret', { secure: true });

    expect(result.allowed).toBe(true);
    expect(result.principal?.role).toBe('viewer');
    expect(result.set_cookie).toContain(`${RUNTIME_SESSION_COOKIE}=`);
    expect(result.set_cookie).toContain('HttpOnly');
    expect(result.set_cookie).toContain('SameSite=Lax');
    expect(result.set_cookie).toContain('Secure');
    expect(result.set_cookie).toContain('Max-Age=600');
    expect(result.set_cookie).not.toContain('viewer-secret');
  });

  test('rejects tampered and expired sessions', () => {
    let currentTime = new Date('2026-08-01T00:00:00.000Z');
    const access = createRuntimeAccessController({
      viewerToken: 'viewer-secret',
      sessionSecret: 'session-secret',
      sessionTtlMinutes: 1,
      now: () => currentTime,
    });
    const result = access.createTokenSession('viewer-secret');
    const cookie = cookiePair(result.set_cookie!);

    expect(access.authorizeRead(new Headers({ Cookie: cookie })).allowed).toBe(true);
    expect(access.authorizeRead(new Headers({
      Cookie: `${cookie.slice(0, -1)}${cookie.endsWith('x') ? 'y' : 'x'}`,
    })).allowed).toBe(false);

    currentTime = new Date('2026-08-01T00:01:00.000Z');
    expect(access.authorizeRead(new Headers({ Cookie: cookie })).allowed).toBe(false);
  });

  test('requires same-origin CSRF proof for operator cookie mutations', () => {
    const access = createRuntimeAccessController({
      writeToken: 'operator-secret',
      sessionSecret: 'session-secret',
    });
    const result = access.createTokenSession('operator-secret', { secure: true });
    const cookie = cookiePair(result.set_cookie!);

    const noCsrf = new Request('https://runtime.example.test/api/v1/runtime/issues/1/retry', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://runtime.example.test',
      },
    });
    expect(access.authorizeMutation(noCsrf).allowed).toBe(false);

    const wrongOrigin = new Request('https://runtime.example.test/api/v1/runtime/issues/1/retry', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://attacker.example.test',
        [RUNTIME_CSRF_HEADER]: '1',
      },
    });
    expect(access.authorizeMutation(wrongOrigin).allowed).toBe(false);

    const allowed = new Request('https://runtime.example.test/api/v1/runtime/issues/1/retry', {
      method: 'POST',
      headers: {
        Cookie: cookie,
        Origin: 'https://runtime.example.test',
        [RUNTIME_CSRF_HEADER]: '1',
      },
    });
    expect(access.authorizeMutation(allowed).allowed).toBe(true);
  });

  test('clears the scoped session cookie', () => {
    const access = createRuntimeAccessController({ sessionSecret: 'session-secret' });
    const cleared = access.clearSessionCookie({ secure: true });

    expect(cleared).toContain(`${RUNTIME_SESSION_COOKIE}=`);
    expect(cleared).toContain('Max-Age=0');
    expect(cleared).toContain('HttpOnly');
    expect(cleared).toContain('Secure');
  });
});
