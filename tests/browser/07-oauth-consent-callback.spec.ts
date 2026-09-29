import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { test, expect } from '@playwright/test';
import { loginAsAdmin, seedCleanTestState } from './helpers';

test('OAuth consent can redirect a browser to the registered loopback callback', async ({ page, request }) => {
  seedCleanTestState();
  const callback = createServer((_req, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('OAuth callback received');
  });
  await new Promise<void>((resolve) => callback.listen(0, '127.0.0.1', resolve));

  try {
    const address = callback.address();
    if (!address || typeof address === 'string') throw new Error('Loopback callback did not bind');
    const callbackOrigin = `http://127.0.0.1:${address.port}`;
    const redirectUri = `${callbackOrigin}/callback`;
    const registration = await request.post('/oauth/register', {
      data: {
        client_name: 'Browser Callback Test',
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: 'none',
        scope: 'activity:read'
      }
    });
    expect(registration.status()).toBe(201);
    const { client_id: clientId } = await registration.json();

    await loginAsAdmin(page, '/admin');
    const verifier = 'a'.repeat(43);
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: redirectUri,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'activity:read',
      resource: 'http://127.0.0.1:4173/mcp',
      state: 'browser-callback-test'
    });
    const consent = await page.goto(`/oauth/authorize?${params}`);
    expect(consent?.status()).toBe(200);
    expect(consent?.headers()['content-security-policy']).toContain(
      `form-action 'self' ${callbackOrigin}`
    );

    await page.getByRole('button', { name: 'Approve & Authorize' }).click();
    await page.waitForURL(`${redirectUri}*`);
    await expect(page.getByText('OAuth callback received')).toBeVisible();
  } finally {
    callback.close();
  }
});
