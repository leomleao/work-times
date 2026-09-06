/**
 * Bounded form body parsing for the OAuth protocol endpoints (`/oauth/token`,
 * `/oauth/revoke`).
 *
 * These endpoints are reached by non-browser clients, so they carry no Origin or CSRF
 * protection. Everything about the request body is therefore treated as hostile:
 *
 * - `application/x-www-form-urlencoded` is the only accepted media type
 * - a declared `Content-Length` must be well formed, within bounds, and honest —
 *   it must match the number of bytes actually read
 * - the body is capped while it is being read, not only after
 * - a security-critical parameter may appear at most once, so that a smuggled second
 *   copy cannot change which value a downstream `URLSearchParams.get` observes
 *
 * Failures are generic and `no-store`: they never restate the submitted values.
 */

export const PROTOCOL_HEADERS: Record<string, string> = {
  'cache-control': 'no-store',
  pragma: 'no-cache'
};

export const MAX_FORM_BODY_BYTES = 64 * 1024;

/**
 * Parameters where a duplicate changes the meaning of the request. `URLSearchParams.get`
 * silently returns the first of several values, so a duplicate is a parameter-smuggling
 * attempt rather than a client mistake.
 */
export const SECURITY_CRITICAL_PARAMS: ReadonlySet<string> = new Set([
  'grant_type',
  'code',
  'redirect_uri',
  'client_id',
  'client_secret',
  'code_verifier',
  'refresh_token',
  'resource',
  'token',
  'token_type_hint',
  'scope',
  'state',
  'response_type',
  'code_challenge',
  'code_challenge_method'
]);

export type ParseFormResult =
  | { readonly ok: true; readonly params: URLSearchParams }
  | { readonly ok: false; readonly response: Response };

function formError(description: string): { ok: false; response: Response } {
  return {
    ok: false,
    response: new Response(
      JSON.stringify({ error: 'invalid_request', error_description: description }),
      {
        status: 400,
        headers: { 'content-type': 'application/json', ...PROTOCOL_HEADERS }
      }
    )
  };
}

const OVERSIZE = 'Request payload exceeds maximum allowed size';

/** Reads at most `maxBytes + 1` bytes so an oversized body is refused mid-stream. */
async function readBoundedBody(request: Request, maxBytes: number): Promise<Uint8Array | null> {
  const body = request.body;
  if (!body || typeof body.getReader !== 'function') {
    const text = await request.text();
    const bytes = Buffer.from(text, 'utf-8');
    return bytes.byteLength > maxBytes ? null : bytes;
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/**
 * Validates media type and `Content-Length`, reads the body under a hard byte cap, parses
 * it as form-urlencoded, and rejects duplicated security-critical parameters.
 */
export async function readAndValidateFormBody(
  request: Request,
  options: {
    maxBytes?: number;
    securityCriticalParams?: ReadonlySet<string>;
  } = {}
): Promise<ParseFormResult> {
  const maxBytes = options.maxBytes ?? MAX_FORM_BODY_BYTES;
  const criticalParams = options.securityCriticalParams ?? SECURITY_CRITICAL_PARAMS;

  const mime = (request.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
  if (mime !== 'application/x-www-form-urlencoded') {
    return formError('Content-Type must be application/x-www-form-urlencoded');
  }

  const contentLengthHeader = request.headers.get('content-length');
  let declaredLength: number | null = null;
  if (contentLengthHeader !== null) {
    const raw = contentLengthHeader.trim();
    // A single decimal integer: no signs, no exponents, no comma-joined duplicates.
    if (!/^\d{1,15}$/.test(raw)) {
      return formError('Invalid Content-Length header');
    }
    declaredLength = Number.parseInt(raw, 10);
    if (declaredLength > maxBytes) {
      return formError(OVERSIZE);
    }
  }

  let bytes: Uint8Array | null;
  try {
    bytes = await readBoundedBody(request, maxBytes);
  } catch {
    return formError('Failed to read request body');
  }
  if (bytes === null) {
    return formError(OVERSIZE);
  }

  // An honest Content-Length is one the body actually matches.
  if (declaredLength !== null && bytes.byteLength !== declaredLength) {
    return formError('Content-Length does not match request body');
  }

  const params = new URLSearchParams(Buffer.from(bytes).toString('utf-8'));

  const seenCritical = new Set<string>();
  for (const [key] of params) {
    const normalizedKey = key.toLowerCase();
    if (!criticalParams.has(normalizedKey)) continue;
    if (seenCritical.has(normalizedKey)) {
      return formError('Duplicate parameter in request');
    }
    seenCritical.add(normalizedKey);
  }

  return { ok: true, params };
}
