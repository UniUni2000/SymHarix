import type { RuntimeAccessView, RuntimeManifest } from '../runtime/types';

export interface RuntimeAccessController {
  describe(headers?: Headers | Record<string, string | undefined>): RuntimeAccessView;
  authorizeMutation(headers?: Headers | Record<string, string | undefined>): {
    allowed: boolean;
    access: RuntimeAccessView;
  };
}

function getHeaderValue(
  headers: Headers | Record<string, string | undefined> | undefined,
  key: string,
): string | null {
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

function readWriteToken(
  headers: Headers | Record<string, string | undefined> | undefined,
): string | null {
  const explicit = getHeaderValue(headers, 'x-symphony-runtime-token');
  if (explicit) {
    return explicit;
  }

  const authorization = getHeaderValue(headers, 'authorization');
  if (!authorization) {
    return null;
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

export function createRuntimeAccessController(options?: {
  writeToken?: string | null;
}): RuntimeAccessController {
  const writeToken = options?.writeToken?.trim() || null;

  const describe = (
    headers?: Headers | Record<string, string | undefined>,
  ): RuntimeAccessView => {
    if (!writeToken) {
      return {
        mode: 'open',
        viewer_role: 'operator',
        can_create_issue: true,
        can_control_issues: true,
        token_required: false,
      };
    }

    const presentedToken = readWriteToken(headers);
    const isOperator = Boolean(presentedToken && presentedToken === writeToken);
    return {
      mode: 'token',
      viewer_role: isOperator ? 'operator' : 'viewer',
      can_create_issue: isOperator,
      can_control_issues: isOperator,
      token_required: true,
    };
  };

  return {
    describe,
    authorizeMutation(headers) {
      const access = describe(headers);
      return {
        allowed: access.can_create_issue && access.can_control_issues,
        access,
      };
    },
  };
}

export function createRuntimeAccessControllerFromEnv(): RuntimeAccessController {
  return createRuntimeAccessController({
    writeToken: process.env.SYMPHONY_RUNTIME_WRITE_TOKEN || null,
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
