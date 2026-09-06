import {
  bearerAuthChallengeResponse,
  getOAuthProtectedResourceMetadataUrl,
  hostHeaderValidationResponse,
  localhostAllowedHostnames,
  localhostAllowedOrigins,
  OAuthError,
  OAuthErrorCode,
  originValidationResponse,
  requireBearerAuth,
  type AuthInfo,
  type McpHandlerRequestOptions,
  type McpHttpHandler,
  type OAuthTokenVerifier
} from '@modelcontextprotocol/server';

export interface AuthenticatedMcpHandlerOptions {
  /** The underlying McpHttpHandler to delegate valid requests to. */
  handler: McpHttpHandler;
  /** Token verifier used to validate incoming Bearer access tokens. */
  verifier: OAuthTokenVerifier;
  /** The exact configured MCP resource URL (e.g. http://localhost:3002/mcp). */
  resource?: URL | string;
  /** Optional alias for resource. */
  resourceServerUrl?: URL | string;
  /** Optional alias for resource. */
  mcpUrl?: URL | string;
  /** Optional base public URL used to resolve /mcp if resource is not specified. */
  publicUrl?: URL | string;
  /** Explicit list of allowed hostnames for Host header validation. */
  allowedHosts?: readonly string[];
  /** Alias for allowedHosts. */
  allowedHostnames?: readonly string[];
  /** Explicit list of allowed hostnames for Origin header validation. */
  allowedOrigins?: readonly string[];
  /** Alias for allowedOrigins. */
  allowedOriginHostnames?: readonly string[];
  /** Additional required scopes (always includes activity:read). */
  requiredScopes?: readonly string[];
}

export interface AuthenticatedMcpHandler extends McpHttpHandler {
  (request: Request, options?: McpHandlerRequestOptions): Promise<Response>;
  readonly handler: McpHttpHandler;
}

const ALLOWED_METHODS = new Set(['GET', 'POST', 'DELETE']);
const ALLOW_HEADER_VALUE = 'GET, POST, DELETE';

function normalizeHostnames(items?: readonly string[]): string[] | undefined {
  if (!items || items.length === 0) return undefined;
  const result = new Set<string>();
  for (const item of items) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    result.add(trimmed);
    try {
      const url = new URL(trimmed.includes('://') ? trimmed : `http://${trimmed}`);
      if (url.hostname) {
        result.add(url.hostname);
      }
    } catch {}
  }
  return [...result];
}

function resolveResource(options: AuthenticatedMcpHandlerOptions): URL {
  const raw =
    options.resource ??
    options.resourceServerUrl ??
    options.mcpUrl ??
    (options.publicUrl ? new URL('/mcp', options.publicUrl) : undefined);

  if (!raw) {
    throw new TypeError('A configured MCP resource URL is required');
  }

  return raw instanceof URL ? raw : new URL(raw);
}

/**
 * Creates an authenticated MCP HTTP boundary wrapping an McpHttpHandler.
 *
 * Enforces:
 * - Host and Origin validation using official SDK helpers
 * - Acceptance of non-browser clients without Origin
 * - Bearer auth with required scope `activity:read`
 * - RFC 9728 metadata URL in WWW-Authenticate
 * - Verification that AuthInfo.resource matches the exact configured MCP URL
 * - Method whitelisting: GET, POST, DELETE reach the handler; others are rejected (405)
 * - Safe authInfo forwarding without logging tokens, bodies, or tool payloads
 */
export function createAuthenticatedMcpHandler(
  options: AuthenticatedMcpHandlerOptions
): AuthenticatedMcpHandler;
export function createAuthenticatedMcpHandler(
  handler: McpHttpHandler,
  options: Omit<AuthenticatedMcpHandlerOptions, 'handler'>
): AuthenticatedMcpHandler;
export function createAuthenticatedMcpHandler(
  handlerOrOptions: McpHttpHandler | AuthenticatedMcpHandlerOptions,
  maybeOptions?: Omit<AuthenticatedMcpHandlerOptions, 'handler'>
): AuthenticatedMcpHandler {
  const options: AuthenticatedMcpHandlerOptions =
    'fetch' in handlerOrOptions && typeof handlerOrOptions.fetch === 'function'
      ? { ...maybeOptions!, handler: handlerOrOptions as McpHttpHandler }
      : (handlerOrOptions as AuthenticatedMcpHandlerOptions);

  const handler = options.handler;
  if (!handler || typeof handler.fetch !== 'function') {
    throw new TypeError('A valid McpHttpHandler is required');
  }

  const verifier = options.verifier;
  if (!verifier || typeof verifier.verifyAccessToken !== 'function') {
    throw new TypeError('An OAuthTokenVerifier is required');
  }

  const resource = resolveResource(options);
  const resourceMetadataUrl = getOAuthProtectedResourceMetadataUrl(resource);

  const requiredScopes = options.requiredScopes && options.requiredScopes.length > 0
    ? [...new Set(['activity:read', ...options.requiredScopes])]
    : ['activity:read'];

  const isLocal =
    resource.hostname === 'localhost' ||
    resource.hostname === '127.0.0.1' ||
    resource.hostname === '[::1]';

  const rawAllowedHosts = options.allowedHosts ?? options.allowedHostnames;
  const allowedHosts =
    normalizeHostnames(rawAllowedHosts) ??
    (isLocal ? localhostAllowedHostnames() : [resource.hostname]);

  const rawAllowedOrigins = options.allowedOrigins ?? options.allowedOriginHostnames;
  const allowedOrigins =
    normalizeHostnames(rawAllowedOrigins) ??
    (rawAllowedHosts ? allowedHosts : (isLocal ? localhostAllowedOrigins() : [resource.hostname]));

  const bearerGate = requireBearerAuth({
    verifier,
    requiredScopes,
    resourceMetadataUrl
  });

  async function handle(
    request: Request,
    requestOptions?: McpHandlerRequestOptions
  ): Promise<Response> {
    // 1. Validate Host header using official SDK helper
    const hostRejection = hostHeaderValidationResponse(request, allowedHosts);
    if (hostRejection) {
      return hostRejection;
    }

    // 2. Validate Origin header if present using official SDK helper (absent Origin passes)
    const originRejection = originValidationResponse(request, allowedOrigins);
    if (originRejection) {
      return originRejection;
    }

    // 3. Allow GET, POST, DELETE to reach the SDK handler; reject unsupported methods
    const method = request.method.toUpperCase();
    if (!ALLOWED_METHODS.has(method)) {
      const error = new OAuthError(
        OAuthErrorCode.MethodNotAllowed,
        `Method ${request.method} is not allowed for this endpoint`
      );
      return Response.json(error.toResponseObject(), {
        status: 405,
        headers: {
          Allow: ALLOW_HEADER_VALUE,
          'Content-Type': 'application/json'
        }
      });
    }

    // 4. Require Authorization: Bearer using requireBearerAuth gate
    const authResult = await bearerGate(request);
    if (authResult instanceof Response) {
      return authResult;
    }

    // 5. Validate that AuthInfo.resource is the exact configured MCP URL or reject
    let authResourceHref: string | undefined;
    if (authResult.resource instanceof URL) {
      authResourceHref = authResult.resource.href;
    } else if (typeof authResult.resource === 'string') {
      try {
        authResourceHref = new URL(authResult.resource).href;
      } catch {}
    } else if (authResult.resource && typeof (authResult.resource as { href?: unknown }).href === 'string') {
      authResourceHref = (authResult.resource as { href: string }).href;
    }

    if (!authResourceHref || authResourceHref !== resource.href) {
      return bearerAuthChallengeResponse(
        new OAuthError(
          OAuthErrorCode.InvalidToken,
          'Token resource does not match configured MCP resource'
        ),
        {
          requiredScopes,
          resourceMetadataUrl
        }
      );
    }

    // 6. Pass validated authInfo into handler.fetch without logging tokens or payloads
    return handler.fetch(request, {
      ...requestOptions,
      authInfo: authResult
    });
  }

  const fetchFace = (request: Request, requestOptions?: McpHandlerRequestOptions) =>
    handle(request, requestOptions);

  const wrapper = Object.assign(fetchFace, {
    fetch: fetchFace,
    close: () => handler.close(),
    notify: handler.notify,
    bus: handler.bus,
    handler
  });

  return wrapper as AuthenticatedMcpHandler;
}

export { createAuthenticatedMcpHandler as createAuthenticatedMcpHttpHandler };
export { createAuthenticatedMcpHandler as wrapMcpHandler };
export { createAuthenticatedMcpHandler as wrapMcpHttpHandler };
