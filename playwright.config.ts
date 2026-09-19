import { defineConfig, devices } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 4173;
const BASE_URL = `http://127.0.0.1:${PORT}`;
export const TEST_DB_PATH = join(tmpdir(), 'work-times-p8b-playwright.sqlite');

export default defineConfig({
  testDir: './tests/browser',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 45000,
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure'
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome']
      }
    }
  ],
  webServer: {
    command: 'node tests/browser/server-wrapper.mjs',
    url: `${BASE_URL}/login`,
    reuseExistingServer: false,
    timeout: 30000,
    env: {
      PORT: String(PORT),
      HOST: '127.0.0.1',
      PUBLIC_URL: BASE_URL,
      ORIGIN: BASE_URL,
      DATABASE_PATH: TEST_DB_PATH,
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD_HASH: 'scrypt$32768$8$1$GnW-FTpbx2FDQYua_EWO1w$Owxd1EosqWENIPHqXL8vOtB-nXwOt2ENoFolL2YtpdUTpVZZPvWtc6zsV7z0KqKQHbZZjm-ldW7771O48R-wNA',
      SESSION_SECRET: 'test-session-secret-for-deterministic-playwright-tests-at-least-32-chars-long!',
      WAKATIME_OAUTH_CLIENT_ID: 'test-wakatime-oauth-client-id-12345',
      WAKATIME_OAUTH_CLIENT_SECRET: 'test-wakatime-oauth-client-secret-67890',
      NODE_ENV: 'test'
    }
  }
});
