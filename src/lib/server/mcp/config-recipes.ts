/**
 * MCP Client Configuration Recipes and Safe Metadata Helpers.
 *
 * Implements recipe generators for Codex CLI, Claude Code, Claude Desktop,
 * and Generic MCP clients with Bearer token (API key) and OAuth 2.0 auth methods.
 */

export type McpClientType = 'codex' | 'claude-code' | 'claude-desktop' | 'generic';
export type McpAuthMethod = 'bearer' | 'oauth';
export type SafeApiKeyStatus = 'active' | 'revoked' | 'expired' | 'wrong-scope';

export interface SafeApiKeyMetadata {
  id: string;
  name: string;
  prefix: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  status: SafeApiKeyStatus;
  isActive: boolean;
}

export interface McpRecipe {
  client: McpClientType;
  clientName: string;
  authMethod: McpAuthMethod;
  authMethodName: string;
  filename?: string;
  format: 'toml' | 'json' | 'text' | 'http';
  snippet: string;
  command?: string;
  warning?: string;
  instructions: string[];
  notes: string[];
  endpoint: string;
}

/**
 * Escapes a string for TOML basic string literal (using standard JSON string escaping,
 * which matches RFC-compliant TOML basic string escaping rules).
 */
export function serializeTomlString(value: string): string {
  return JSON.stringify(value);
}

/**
 * Evaluates and returns only safe, explicitly selected API-key metadata.
 * Treats active strictly as not revoked, not expired, and possessing 'activity:read'.
 * Never exposes secrets, tokens, or token hashes.
 */
export function selectSafeApiKeyMetadata(
  rawKeys: Array<Record<string, unknown>>,
  now = new Date()
): SafeApiKeyMetadata[] {
  const currentTime = now.getTime();

  return rawKeys.map((key) => {
    const id = String(key.id ?? '');
    const name = String(key.name ?? '');
    const prefix = String(key.tokenPrefix ?? key.prefix ?? '');

    let scopes: string[] = [];
    if (Array.isArray(key.scopes)) {
      scopes = key.scopes.map(String);
    } else if (typeof key.scopes === 'string') {
      try {
        const parsed = JSON.parse(key.scopes);
        if (Array.isArray(parsed)) {
          scopes = parsed.map(String);
        } else {
          scopes = key.scopes.split(/\s+/).filter(Boolean);
        }
      } catch {
        scopes = key.scopes.split(/\s+/).filter(Boolean);
      }
    }

    const createdAt = String(key.createdAt ?? '');
    const expiresAt = key.expiresAt ? String(key.expiresAt) : null;
    const lastUsedAt = key.lastUsedAt ? String(key.lastUsedAt) : null;
    const revokedAt = key.revokedAt ? String(key.revokedAt) : null;

    const isRevoked = revokedAt !== null;
    const isExpired =
      expiresAt !== null &&
      (isNaN(new Date(expiresAt).getTime()) || new Date(expiresAt).getTime() <= currentTime);
    const hasActivityRead = scopes.includes('activity:read');

    let status: SafeApiKeyStatus;
    if (isRevoked) {
      status = 'revoked';
    } else if (isExpired) {
      status = 'expired';
    } else if (!hasActivityRead) {
      status = 'wrong-scope';
    } else {
      status = 'active';
    }

    const isActive = status === 'active';

    return {
      id,
      name,
      prefix,
      tokenPrefix: prefix,
      scopes,
      createdAt,
      expiresAt,
      lastUsedAt,
      revokedAt,
      status,
      isActive
    };
  });
}

/**
 * Formats Codex TOML configuration for Bearer token auth.
 */
export function formatCodexBearerToml(endpoint: string): string {
  return [
    `[mcp_servers.work-times]`,
    `url = ${serializeTomlString(endpoint)}`,
    `bearer_token_env_var = "WORK_TIMES_API_KEY"`
  ].join('\n');
}

/**
 * Formats Codex TOML configuration for OAuth.
 * Omits the bearer setting.
 */
export function formatCodexOAuthToml(endpoint: string): string {
  return [
    `[mcp_servers.work-times]`,
    `url = ${serializeTomlString(endpoint)}`
  ].join('\n');
}

/**
 * Formats a local stdio bridge for Claude Code with Bearer token auth.
 * mcp-remote expands the environment variable in the header argument.
 */
export function formatClaudeCodeBearerJson(endpoint: string): string {
  const config = {
    mcpServers: {
      'work-times': {
        command: 'npx',
        args: [
          '-y',
          'mcp-remote@latest',
          endpoint,
          '--transport',
          'http-only',
          '--header',
          'Authorization: Bearer ${WORK_TIMES_API_KEY}'
        ]
      }
    }
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Formats a local stdio bridge for Claude Code with browser OAuth.
 */
export function formatClaudeCodeOAuthJson(endpoint: string): string {
  const config = {
    mcpServers: {
      'work-times': {
        command: 'npx',
        args: ['-y', 'mcp-remote@latest', endpoint, '--transport', 'http-only']
      }
    }
  };
  return JSON.stringify(config, null, 2);
}

/**
 * Formats a local Claude Desktop stdio bridge with browser OAuth.
 */
export function formatClaudeDesktopOAuth(endpoint: string): string {
  return formatClaudeCodeOAuthJson(endpoint);
}

/**
 * Formats Claude Desktop Bearer advisory.
 * Claude Desktop remote connectors do not support static Bearer headers.
 */
export function formatClaudeDesktopBearer(endpoint: string): string {
  return [
    `# Claude Desktop Remote Connector`,
    `# Remote connectors require OAuth 2.0 authentication.`,
    `# Static Bearer token headers are not supported by Claude Desktop remote connectors.`,
    `Endpoint URL: ${endpoint}`,
    `Authentication: OAuth 2.0`
  ].join('\n');
}

/**
 * Formats Generic streamable HTTP request with Bearer header.
 * Deliberately avoids invented client syntax.
 */
export function formatGenericBearer(endpoint: string): string {
  let host = 'localhost:3002';
  try {
    const parsed = new URL(endpoint);
    host = parsed.host;
  } catch {}

  return [
    `POST /mcp HTTP/1.1`,
    `Host: ${host}`,
    `Authorization: Bearer \${WORK_TIMES_API_KEY}`,
    `Content-Type: application/json`,
    `Accept: application/json, text/event-stream`,
    ``,
    `{"jsonrpc": "2.0", "method": "tools/list", "id": 1}`
  ].join('\n');
}

/**
 * Formats Generic streamable HTTP request with OAuth.
 */
export function formatGenericOAuth(endpoint: string): string {
  let host = 'localhost:3002';
  try {
    const parsed = new URL(endpoint);
    host = parsed.host;
  } catch {}

  return [
    `# 1. Unauthenticated challenge discovery (RFC 9728)`,
    `GET /mcp HTTP/1.1`,
    `Host: ${host}`,
    ``,
    `# 2. Authenticated request with Bearer access token`,
    `POST /mcp HTTP/1.1`,
    `Host: ${host}`,
    `Authorization: Bearer <access_token>`,
    `Content-Type: application/json`,
    `Accept: application/json, text/event-stream`,
    ``,
    `{"jsonrpc": "2.0", "method": "tools/list", "id": 1}`
  ].join('\n');
}

/**
 * Generates an MCP recipe for a specific client and authentication method.
 */
export function getRecipe(
  client: McpClientType,
  authMethod: McpAuthMethod,
  endpoint: string
): McpRecipe {
  switch (client) {
    case 'codex': {
      if (authMethod === 'bearer') {
        return {
          client: 'codex',
          clientName: 'Codex CLI',
          authMethod: 'bearer',
          authMethodName: 'API Key (Bearer Token)',
          filename: 'config.toml',
          format: 'toml',
          snippet: formatCodexBearerToml(endpoint),
          instructions: [
            'Obtain your full API key (starts with wtk_). If lost, generate a replacement at /admin/api-keys.',
            'Export the API key in your environment or shell profile: export WORK_TIMES_API_KEY="wtk_..."',
            'Add the snippet above to your Codex configuration file (e.g. ~/.codex/config.toml).',
            'Start Codex CLI. Codex will authenticate using the WORK_TIMES_API_KEY environment variable.'
          ],
          notes: [
            'Codex natively supports bearer_token_env_var in TOML configuration.',
            'Never commit your full API key to version control.',
            'Work Times MCP authorization is separate from upstream WakaTime OAuth.'
          ],
          endpoint
        };
      } else {
        return {
          client: 'codex',
          clientName: 'Codex CLI',
          authMethod: 'oauth',
          authMethodName: 'OAuth 2.0',
          filename: 'config.toml',
          format: 'toml',
          snippet: formatCodexOAuthToml(endpoint),
          command: 'codex mcp login work-times',
          instructions: [
            'Add the snippet above to your Codex configuration file (e.g. ~/.codex/config.toml). Note that the bearer setting is omitted.',
            'Run `codex mcp login work-times` to authenticate.',
            'Authorize the client in Work Times with activity:read scope.',
            'Once authorized, Codex stores its OAuth tokens and connects automatically.'
          ],
          notes: [
            'API keys are completely optional when using OAuth.',
            'Codex discovers OAuth endpoints via RFC 9728 on the /mcp endpoint.',
            'Work Times MCP OAuth is local agent authorization, separate from upstream WakaTime OAuth.'
          ],
          endpoint
        };
      }
    }

    case 'claude-code': {
      if (authMethod === 'bearer') {
        return {
          client: 'claude-code',
          clientName: 'Claude Code',
          authMethod: 'bearer',
          authMethodName: 'API Key (Bearer Token)',
          filename: '.mcp.json',
          format: 'json',
          snippet: formatClaudeCodeBearerJson(endpoint),
          instructions: [
            'Set your full API key in your environment: export WORK_TIMES_API_KEY="wtk_..."',
            'Add the work-times entry to .mcp.json in your project directory, or use claude mcp add-json for user scope.',
            'mcp-remote expands ${WORK_TIMES_API_KEY} from the process environment and sends it as a Bearer header.',
            'Start Claude Code and verify tool availability.'
          ],
          notes: [
            'This stdio bridge connects to the streamable HTTP /mcp endpoint; it does not require an SSE endpoint.',
            'Claude Code also supports native HTTP. Use this bridge if its native connection fails in your environment.',
            'Do not hardcode the secret into .mcp.json.',
            'API key must possess the activity:read scope.',
            'Work Times MCP OAuth is distinct from upstream WakaTime sync OAuth.'
          ],
          endpoint
        };
      } else {
        return {
          client: 'claude-code',
          clientName: 'Claude Code',
          authMethod: 'oauth',
          authMethodName: 'OAuth 2.0',
          filename: '.mcp.json',
          format: 'json',
          snippet: formatClaudeCodeOAuthJson(endpoint),
          instructions: [
            'Add the work-times entry to your project .mcp.json, or use claude mcp add-json for user scope.',
            'Start Claude Code and let mcp-remote open the browser for OAuth approval.',
            'Approve the authorization request in Work Times.',
            'mcp-remote completes OAuth and forwards Claude Code requests to /mcp.'
          ],
          notes: [
            'This stdio bridge connects to the streamable HTTP /mcp endpoint; it does not require an SSE endpoint.',
            'Claude Code also supports native HTTP. Use this bridge if its native connection fails in your environment.',
            'API keys are optional when using OAuth.',
            'Work Times MCP OAuth is local agent authorization, separate from upstream WakaTime OAuth.'
          ],
          endpoint
        };
      }
    }

    case 'claude-desktop': {
      if (authMethod === 'oauth') {
        return {
          client: 'claude-desktop',
          clientName: 'Claude Desktop',
          authMethod: 'oauth',
          authMethodName: 'Local Bridge (OAuth 2.0)',
          filename: 'claude_desktop_config.json',
          format: 'json',
          snippet: formatClaudeDesktopOAuth(endpoint),
          instructions: [
            'Add the work-times entry under mcpServers in ~/Library/Application Support/Claude/claude_desktop_config.json (macOS). Preserve any existing entries.',
            'Restart Claude Desktop so it starts the local mcp-remote bridge.',
            'Authorize Work Times in the browser when mcp-remote opens it.'
          ],
          notes: [
            'This local bridge uses stdio in Claude Desktop and streamable HTTP to Work Times.',
            'Claude Desktop cloud connectors are a separate option configured in Settings > Connectors; those require Anthropic to reach the endpoint.',
            'API keys are not required for this OAuth bridge.'
          ],
          endpoint
        };
      } else {
        return {
          client: 'claude-desktop',
          clientName: 'Claude Desktop',
          authMethod: 'bearer',
          authMethodName: 'API Key (Bearer Token)',
          format: 'text',
          snippet: formatClaudeDesktopBearer(endpoint),
          warning:
            'Claude Desktop remote connectors require OAuth 2.0 authentication and public reachability. ' +
            'Static Bearer token headers are not supported by Claude Desktop remote connectors. Please switch authentication method to OAuth 2.0.',
          instructions: [
            'Claude Desktop remote connectors do not support static Bearer token headers.',
            'Please select OAuth 2.0 as the authentication method above for Claude Desktop.',
            'Configure the remote connector in Claude Desktop Settings with the endpoint URL.'
          ],
          notes: [
            'Claude Desktop remote connectors strictly use OAuth 2.0 RFC 9728 discovery.',
            'Public HTTPS reachability is required for Anthropic cloud infrastructure to reach your instance.'
          ],
          endpoint
        };
      }
    }

    case 'generic': {
      if (authMethod === 'bearer') {
        return {
          client: 'generic',
          clientName: 'Generic MCP Client',
          authMethod: 'bearer',
          authMethodName: 'API Key (Bearer Token)',
          format: 'http',
          snippet: formatGenericBearer(endpoint),
          instructions: [
            'Send HTTP POST requests with Content-Type: application/json to the /mcp endpoint.',
            'Include the Authorization header: Bearer <WORK_TIMES_API_KEY>.',
            'Include Accept: application/json, text/event-stream for streamable HTTP transport.',
            'Use standard MCP JSON-RPC 2.0 message payloads (e.g. tools/list, tools/call).'
          ],
          notes: [
            'Work Times implements the official Model Context Protocol streamable HTTP transport.',
            'No client-specific syntax is invented; standard HTTP headers and JSON-RPC 2.0 are used.',
            'The API key must have the activity:read scope.'
          ],
          endpoint
        };
      } else {
        return {
          client: 'generic',
          clientName: 'Generic MCP Client',
          authMethod: 'oauth',
          authMethodName: 'OAuth 2.0',
          format: 'http',
          snippet: formatGenericOAuth(endpoint),
          instructions: [
            'Send an unauthenticated request to the /mcp endpoint to receive the RFC 9728 WWW-Authenticate challenge.',
            'Discover authorization servers and token endpoints via /.well-known/oauth-protected-resource.',
            'Obtain an access token with activity:read scope through the OAuth authorization code flow.',
            'Send requests to /mcp with Authorization: Bearer <access_token>.'
          ],
          notes: [
            'Adheres strictly to RFC 9728 OAuth 2.0 Protected Resource Metadata.',
            'API keys are not required when using OAuth.',
            'Work Times MCP OAuth is local agent authorization, separate from upstream WakaTime OAuth.'
          ],
          endpoint
        };
      }
    }
  }
}

/**
 * Returns all recipes for every combination of client and auth method.
 */
export function getAllRecipes(
  endpoint: string
): Record<McpClientType, Record<McpAuthMethod, McpRecipe>> {
  const clients: McpClientType[] = ['codex', 'claude-code', 'claude-desktop', 'generic'];
  const authMethods: McpAuthMethod[] = ['bearer', 'oauth'];

  const result = {} as Record<McpClientType, Record<McpAuthMethod, McpRecipe>>;

  for (const client of clients) {
    result[client] = {} as Record<McpAuthMethod, McpRecipe>;
    for (const auth of authMethods) {
      result[client][auth] = getRecipe(client, auth, endpoint);
    }
  }

  return result;
}
