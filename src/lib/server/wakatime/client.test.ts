import { describe, it, expect, vi } from 'vitest';
import { WakaTimeClient, parseRetryAfter } from './client.js';
import {
  WakaTimeError,
  WakaTimeAuthError,
  CapabilityRestrictedError,
  WakaTimeThrottleError,
  WakaTimeServerError,
  WakaTimeNetworkError,
  WakaTimeParseError,
  WakaTimeApiError,
  WakaTimeDeferredRetryError,
  WakaTimeRequestTimeoutError,
  WakaTimeBudgetTimeoutError,
  WakaTimeResponseSizeExceededError,
  WakaTimeOAuthRevokedError,
  WakaTimeOAuthTransientError,
  sanitizeEndpoint,
  sanitizeErrorMessage
} from './errors.js';
import {
  WakaTimeRequestGate,
  resetApplicationRequestGate
} from './request-gate.js';
import { MAX_DAY_EXECUTION_BUDGET_MS, MIN_UPSTREAM_REQUEST_SPACING_MS } from '../sync/contracts.js';
import { WakaTimeOAuthService } from './oauth.js';
import { openTestDatabase } from '$lib/server/db/connection';
import { SqliteWakaTimeOAuthConnectionRepository } from '$lib/server/db/repositories';

describe('WakaTime Client and Error Handling', () => {
  const dummyAccessToken = 'sec_waka_test_key_12345';
  const expectedAuthHeader = `Bearer ${dummyAccessToken}`;

  // Helper to create mock response
  function createResponse(
    status: number,
    body: unknown,
    headers: Record<string, string> = {}
  ): Response {
    const isJson = typeof body === 'object' && body !== null;
    const bodyStr = isJson ? JSON.stringify(body) : (body as string | undefined);
    const headerObj = new Headers(headers);
    if (isJson && !headerObj.has('content-type')) {
      headerObj.set('content-type', 'application/json');
    }
    return new Response(bodyStr, {
      status,
      headers: headerObj
    });
  }

  it('rejects an empty access token at construction', () => {
    expect(() => new WakaTimeClient({ accessToken: '' })).toThrow(WakaTimeError);
    expect(() => new WakaTimeClient({ accessToken: '   ' })).toThrow(WakaTimeError);
  });

  it('does not leak OAuth token via JSON.stringify or properties', () => {
    const client = new WakaTimeClient({ accessToken: dummyAccessToken });
    const serialized = JSON.stringify(client);
    expect(serialized).not.toContain(dummyAccessToken);
    expect(serialized).not.toContain('sec_waka');
    expect((client as unknown as Record<string, unknown>).accessToken).toBeUndefined();
  });

  describe('Bearer Authentication & URL Construction', () => {
    it('defaults baseUrl to https://api.wakatime.com/api/v1 and normalizes trailing slashes', () => {
      const clientDefault = new WakaTimeClient({ accessToken: dummyAccessToken });
      expect(clientDefault.baseUrl).toBe('https://api.wakatime.com/api/v1');

      const clientCustom = new WakaTimeClient({
        accessToken: dummyAccessToken,
        baseUrl: 'https://custom.api.wakatime.com/api/v1///'
      });
      expect(clientCustom.baseUrl).toBe('https://custom.api.wakatime.com/api/v1');
    });

    it('authenticates with an OAuth Bearer token and never puts it in query params', async () => {
      let interceptedUrl: string | undefined;
      let interceptedHeaders: Headers | undefined;
      let interceptedRedirect: RequestRedirect | undefined;

      const mockFetch: typeof fetch = async (input, init) => {
        interceptedUrl = input.toString();
        interceptedHeaders = new Headers(init?.headers);
        interceptedRedirect = init?.redirect;
        return createResponse(200, {
          data: [],
          start: '2026-09-01',
          end: '2026-09-02'
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch
      });

      await client.getSummaries({ start: '2026-09-01', end: '2026-09-02' });

      expect(interceptedHeaders?.get('Authorization')).toBe(expectedAuthHeader);
      expect(interceptedRedirect).toBe('manual');
      expect(interceptedUrl).toBe(
        'https://api.wakatime.com/api/v1/users/current/summaries?start=2026-09-01&end=2026-09-02'
      );
      expect(interceptedUrl).not.toContain('api_key');
      expect(interceptedUrl).not.toContain(dummyAccessToken);
    });
  });

  it('refreshes once after a 401 and retries with the rotated Bearer token', async () => {
    const authorizations: string[] = [];
    let refreshed = 0;
    const tokenProvider = {
      getAccessToken: async () => 'expired-token',
      refreshAccessToken: async () => {
        refreshed += 1;
        return 'fresh-token';
      }
    };
    const mockFetch: typeof fetch = async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get('Authorization') ?? '');
      return authorizations.length === 1
        ? createResponse(401, { error: 'expired' })
        : createResponse(200, { data: [] });
    };

    const client = new WakaTimeClient({ tokenProvider, fetch: mockFetch });
    await expect(client.getHeartbeats('2026-09-01')).resolves.toMatchObject({ data: [] });
    expect(authorizations).toEqual(['Bearer expired-token', 'Bearer fresh-token']);
    expect(refreshed).toBe(1);
  });

  describe('Privacy, Redaction and Sanitization', () => {
    it('sanitizes endpoints by removing query strings and hostnames', () => {
      expect(
        sanitizeEndpoint('https://api.wakatime.com/api/v1/users/current/data_dumps?foo=bar&secret=123')
      ).toBe('/api/v1/users/current/data_dumps');
      expect(
        sanitizeEndpoint('https://wakatime.com/api/v1/users/current/summaries?start=2026-09-01')
      ).toBe('/api/v1/users/current/summaries');
      expect(
        sanitizeEndpoint('/users/current/heartbeats?date=2026-09-01&user_id=private')
      ).toBe('/users/current/heartbeats');
      expect(sanitizeEndpoint('')).toBe('');
    });

    it('never exposes OAuth tokens, PII, entity paths or raw bodies in errors', async () => {
      const mockFetch: typeof fetch = async () => {
        // Upstream returns private PII and raw body in response
        return createResponse(
          500,
          JSON.stringify({
            error: 'Server crashed on file /Users/private/secret-repo/secret.ts for user secret@example.com'
          })
        );
      };

      const recordedSleeps: number[] = [];
      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async (ms) => {
          recordedSleeps.push(ms);
        },
        maxRetries5xx: 1
      });

      try {
        await client.getHeartbeats('2026-09-01');
        expect.unreachable('Should have thrown server error');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeServerError);
        const errMessage = (err as Error).message;
        expect(errMessage).not.toContain('secret@example.com');
        expect(errMessage).not.toContain('/Users/private');
        expect(errMessage).not.toContain(dummyAccessToken);
        expect(errMessage).not.toContain('secret.ts');
        expect((err as WakaTimeServerError).endpoint).toBe('/api/v1/users/current/heartbeats');
      }
    });
  });

  describe('Typed Methods', () => {
    it('successfully calls getSummaries and parses response shape', async () => {
      const mockFetch: typeof fetch = async (input) => {
        expect(input.toString()).toContain('/users/current/summaries?start=2026-09-01&end=2026-09-01');
        return createResponse(200, {
          data: [
            {
              date: '2026-09-01',
              grand_total: {
                total_seconds: 3600,
                ai_additions: 10,
                ai_deletions: 5,
                human_additions: 50,
                human_deletions: 20
              },
              categories: [{ name: 'Coding', total_seconds: 3600, percent: 100 }],
              projects: [
                {
                  name: 'work-times',
                  total_seconds: 3600,
                  percent: 100,
                  entities: [
                    {
                      name: 'src/lib/server/wakatime/client.ts',
                      total_seconds: 1800,
                      percent: 50
                    }
                  ]
                }
              ]
            }
          ]
        });
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      const res = await client.getSummaries('2026-09-01', '2026-09-01');

      expect(res.data).toHaveLength(1);
      expect(res.data[0].grand_total.total_seconds).toBe(3600);
      expect(res.data[0].projects?.[0]?.name).toBe('work-times');
    });

    it('normalizes the live summaries range.date field into the canonical date', async () => {
      const mockFetch: typeof fetch = async () => createResponse(200, {
        data: [{
          grand_total: { total_seconds: 42 },
          range: { date: '2026-09-06', start: '2026-09-06T00:00:00Z', end: '2026-09-06T23:59:59Z' }
        }]
      });
      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      const response = await client.getSummaries('2026-09-06', '2026-09-06');
      expect(response.data[0].date).toBe('2026-09-06');
    });

    it('successfully calls getHeartbeats and parses response shape', async () => {
      const mockFetch: typeof fetch = async (input) => {
        expect(input.toString()).toContain('/users/current/heartbeats?date=2026-09-01');
        return createResponse(200, {
          data: [
            {
              id: 'hb_12345',
              entity: '/path/to/file.ts',
              type: 'file',
              time: 1700000000.5,
              project: 'work-times',
              is_write: true,
              dependencies: ['vitest', 'zod']
            }
          ],
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-01T23:59:59Z'
        });
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      const res = await client.getHeartbeats('2026-09-01');

      expect(res.data).toHaveLength(1);
      expect(res.data[0].id).toBe('hb_12345');
      expect(res.data[0].is_write).toBe(true);
      expect(res.data[0].dependencies).toEqual(['vitest', 'zod']);
    });

    it('successfully calls getDurations and parses response shape', async () => {
      const mockFetch: typeof fetch = async (input) => {
        expect(input.toString()).toContain('/users/current/durations?date=2026-09-01');
        return createResponse(200, {
          data: [
            {
              project: 'work-times',
              time: 1700000000,
              duration: 1200
            }
          ],
          start: '2026-09-01T00:00:00Z',
          end: '2026-09-01T23:59:59Z'
        });
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      const res = await client.getDurations('2026-09-01');

      expect(res.data).toHaveLength(1);
      expect(res.data[0].project).toBe('work-times');
      expect(res.data[0].duration).toBe(1200);
    });

    it('uses the paginated registry endpoints observed in live responses', async () => {
      const requested: string[] = [];
      const mockFetch: typeof fetch = async (input) => {
        const url = input.toString();
        requested.push(url);
        const page = { page: 2, total: 101, total_pages: 3, next_page: 3, prev_page: 1 };
        if (url.includes('/projects')) {
          return createResponse(200, { ...page, data: [{ id: 'project-id', name: 'project' }] });
        }
        if (url.includes('/machine_names')) {
          return createResponse(200, { ...page, data: [{ id: 'machine-id', name: 'host', value: 'host', ip: '0.0.0.0' }] });
        }
        return createResponse(200, { ...page, data: [{ id: 'agent-id', value: 'agent', editor: 'Editor', os: 'OS' }] });
      };
      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

      expect((await client.getProjects(2)).data[0].name).toBe('project');
      expect((await client.getMachineNames(2)).data[0].value).toBe('host');
      expect((await client.getUserAgents(2)).data[0].editor).toBe('Editor');
      expect(requested).toEqual([
        'https://api.wakatime.com/api/v1/users/current/projects?page=2',
        'https://api.wakatime.com/api/v1/users/current/machine_names?page=2',
        'https://api.wakatime.com/api/v1/users/current/user_agents?page=2'
      ]);
    });

    describe('Data Dumps (list, create, status polling)', () => {
      it('calls listDumps using GET /users/current/data_dumps with exact URL', async () => {
        let interceptedUrl: string | undefined;
        let interceptedMethod: string | undefined;

        const mockFetch: typeof fetch = async (input, init) => {
          interceptedUrl = input.toString();
          interceptedMethod = init?.method;
          return createResponse(200, {
            data: [
              {
                id: 'dump_1',
                type: 'heartbeats',
                status: 'Completed',
                created_at: '2026-09-01T12:00:00Z',
                percent_complete: 100,
                download_url: 'https://api.wakatime.com/download/dump_1.zip'
              }
            ]
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
        const list = await client.listDumps();

        expect(interceptedUrl).toBe('https://api.wakatime.com/api/v1/users/current/data_dumps');
        expect(interceptedMethod).toBe('GET');
        expect(list.data).toHaveLength(1);
        expect(list.data[0].id).toBe('dump_1');
        expect(list.data[0].type).toBe('heartbeats');
        expect(list.data[0].percent_complete).toBe(100);
      });

      it('calls createDump with exact URL and JSON body for daily type', async () => {
        let interceptedUrl: string | undefined;
        let interceptedMethod: string | undefined;
        let interceptedBody: string | undefined;
        let interceptedContentType: string | undefined;

        const mockFetch: typeof fetch = async (input, init) => {
          interceptedUrl = input.toString();
          interceptedMethod = init?.method;
          interceptedBody = init?.body as string;
          interceptedContentType = new Headers(init?.headers).get('Content-Type') ?? undefined;

          return createResponse(201, {
            data: {
              id: 'dump_daily_1',
              type: 'daily',
              status: 'Pending…',
              percent_complete: 0,
              download_url: null,
              created_at: '2026-09-02T12:00:00Z'
            }
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
        const res = await client.createDump({ type: 'daily' });

        expect(interceptedUrl).toBe('https://api.wakatime.com/api/v1/users/current/data_dumps');
        expect(interceptedMethod).toBe('POST');
        expect(interceptedContentType).toBe('application/json');
        expect(interceptedBody).toBe(JSON.stringify({ type: 'daily' }));
        expect(res.data.id).toBe('dump_daily_1');
        expect(res.data.type).toBe('daily');
        expect(res.data.status).toBe('Pending…');
      });

      it('calls createDump with optional email_when_finished: false in exact body', async () => {
        let interceptedBody: string | undefined;

        const mockFetch: typeof fetch = async (input, init) => {
          interceptedBody = init?.body as string;
          return createResponse(201, {
            data: {
              id: 'dump_hb_1',
              type: 'heartbeats',
              status: 'Pending…',
              created_at: '2026-09-02T12:00:00Z'
            }
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
        await client.createDump({ type: 'heartbeats', email_when_finished: false });

        expect(interceptedBody).toBe(JSON.stringify({ type: 'heartbeats', email_when_finished: false }));
      });

      it('calls createDump with optional email_when_finished: true in exact body', async () => {
        let interceptedBody: string | undefined;

        const mockFetch: typeof fetch = async (input, init) => {
          interceptedBody = init?.body as string;
          return createResponse(201, {
            data: {
              id: 'dump_hb_2',
              type: 'heartbeats',
              status: 'Pending…',
              created_at: '2026-09-02T12:00:00Z'
            }
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
        await client.createDump({ type: 'heartbeats', email_when_finished: true });

        expect(interceptedBody).toBe(JSON.stringify({ type: 'heartbeats', email_when_finished: true }));
      });

      it('rejects createDump when type is not exactly daily or heartbeats without dispatching request', async () => {
        let fetchCalled = false;
        const mockFetch: typeof fetch = async () => {
          fetchCalled = true;
          return createResponse(200, {});
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

        // @ts-expect-error test runtime validation of invalid dump type
        await expect(client.createDump({ type: 'monthly' })).rejects.toThrow(WakaTimeError);
        // @ts-expect-error test runtime validation of empty dump type
        await expect(client.createDump({ type: '' })).rejects.toThrow(WakaTimeError);
        // @ts-expect-error test runtime validation of arbitrary string
        await expect(client.createDump({ type: 'all' })).rejects.toThrow(WakaTimeError);

        expect(fetchCalled).toBe(false);
      });

      it('implements getDumpStatus by refetching documented list and finding ID locally', async () => {
        const fetchCalls: { url: string; method: string }[] = [];

        const mockFetch: typeof fetch = async (input, init) => {
          fetchCalls.push({ url: input.toString(), method: init?.method ?? 'GET' });
          return createResponse(200, {
            data: [
              {
                id: 'dump_first',
                type: 'daily',
                status: 'Completed',
                percent_complete: 100,
                created_at: '2026-09-01T10:00:00Z',
                download_url: 'https://api.wakatime.com/download/dump_first.zip'
              },
              {
                id: 'dump_target',
                type: 'heartbeats',
                status: 'Processing coding activity…',
                percent_complete: 45,
                created_at: '2026-09-02T12:00:00Z',
                download_url: null
              }
            ]
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
        const status = await client.getDumpStatus('dump_target');

        expect(fetchCalls).toHaveLength(1);
        // Verified: it refetches documented list /users/current/data_dumps and does NOT call GET /data_dumps/:id
        expect(fetchCalls[0].url).toBe('https://api.wakatime.com/api/v1/users/current/data_dumps');
        expect(fetchCalls[0].method).toBe('GET');

        expect(status.data.id).toBe('dump_target');
        expect(status.data.type).toBe('heartbeats');
        expect(status.data.status).toBe('Processing coding activity…');
        expect(status.data.percent_complete).toBe(45);
      });

      it('throws 404 WakaTimeApiError when dump ID is not found in the list', async () => {
        const mockFetch: typeof fetch = async () => {
          return createResponse(200, {
            data: [
              {
                id: 'dump_other',
                type: 'daily',
                status: 'Completed',
                created_at: '2026-09-01T10:00:00Z'
              }
            ]
          });
        };

        const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

        try {
          await client.getDumpStatus('non_existent_id');
          expect.unreachable('Should have thrown 404');
        } catch (err) {
          expect(err).toBeInstanceOf(WakaTimeApiError);
          const apiErr = err as WakaTimeApiError;
          expect(apiErr.status).toBe(404);
          expect(apiErr.endpoint).toBe('/users/current/data_dumps');
          expect(apiErr.message).toContain('non_existent_id');
        }
      });

      it('rejects getDumpStatus when dumpId is empty', async () => {
        const client = new WakaTimeClient({ accessToken: dummyAccessToken });
        await expect(client.getDumpStatus('')).rejects.toThrow(WakaTimeError);
        await expect(client.getDumpStatus('   ')).rejects.toThrow(WakaTimeError);
      });
    });

    it('successfully calls getCurrentUser', async () => {
      const mockFetch: typeof fetch = async (input) => {
        expect(input.toString()).toContain('/users/current');
        return createResponse(200, {
          data: {
            id: 'usr_abc123',
            timezone: 'America/New_York',
            plan: 'basic'
          }
        });
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      const res = await client.getCurrentUser();
      expect(res.data.id).toBe('usr_abc123');
      expect(res.data.timezone).toBe('America/New_York');
    });
  });

  describe('Throttling and Retry Policies (302, 429, 5xx)', () => {
    it('treats 302 redirect on data-endpoint as throttle and retries with backoff', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount === 1) {
          // First call: 302 redirect throttle with Retry-After: 2
          return createResponse(302, null, { 'Retry-After': '2' });
        }
        // Second call: succeeds
        return createResponse(200, {
          data: [],
          start: '2026-09-01',
          end: '2026-09-01'
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
        minSpacingMs: 0
      });

      const res = await client.getSummaries('2026-09-01', '2026-09-01');
      expect(callCount).toBe(2);
      expect(sleepDelays).toEqual([2000]); // 2 seconds from Retry-After
      expect(res.data).toEqual([]);
    });

    it('treats 429 as throttle and respects exponential backoff with jitter when no Retry-After', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount < 3) {
          return createResponse(429, null);
        }
        return createResponse(200, {
          data: [],
          start: '2026-09-01',
          end: '2026-09-01'
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
        baseBackoffMs: 1000,
        jitterMs: 100,
        random: () => 0.5, // deterministic jitter: 50ms
        minSpacingMs: 0
      });

      const res = await client.getSummaries('2026-09-01', '2026-09-01');
      expect(callCount).toBe(3);
      // Attempt 0: 1000 * 2^0 + 50 = 1050
      // Attempt 1: 1000 * 2^1 + 50 = 2050
      expect(sleepDelays).toEqual([1050, 2050]);
      expect(res.data).toEqual([]);
    });

    it('throws WakaTimeThrottleError when throttle retries are exhausted', async () => {
      const mockFetch: typeof fetch = async () => {
        return createResponse(429, null, { 'Retry-After': '1' });
      };

      const sleepDelays: number[] = [];
      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
        maxThrottleRetries: 2,
        minSpacingMs: 0
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeThrottleError
      );
      expect(sleepDelays).toHaveLength(2);
    });

    it('retries eligible 5xx up to 3 times and succeeds on third retry', async () => {
      let callCount = 0;
      const sleepDelays: number[] = [];

      const mockFetch: typeof fetch = async () => {
        callCount++;
        if (callCount <= 3) {
          return createResponse(503, null); // 503 Service Unavailable
        }
        return createResponse(200, {
          data: [],
          start: '2026-09-01',
          end: '2026-09-01'
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async (ms) => {
          sleepDelays.push(ms);
        },
        baseBackoffMs: 500,
        jitterMs: 0,
        maxRetries5xx: 3,
        minSpacingMs: 0
      });

      const res = await client.getSummaries('2026-09-01', '2026-09-01');
      expect(callCount).toBe(4); // 1 initial + 3 retries
      // Delays: 500 * 2^0 = 500, 500 * 2^1 = 1000, 500 * 2^2 = 2000
      expect(sleepDelays).toEqual([500, 1000, 2000]);
      expect(res.data).toEqual([]);
    });

    it('throws WakaTimeServerError when 5xx retries exceed 3', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return createResponse(500, null);
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        sleep: async () => {},
        maxRetries5xx: 3
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeServerError
      );
      expect(callCount).toBe(4); // 1 initial + 3 retries
    });
  });

  describe('Non-Retriable Status Codes (401, 402, 403, 404)', () => {
    it('treats 401 as non-retriable authentication failure (WakaTimeAuthError)', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return createResponse(401, null);
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeAuthError
      );
      expect(callCount).toBe(1); // No retries!
    });

    it('surfaces 402 as non-retriable CapabilityRestrictedError for durations endpoint', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return createResponse(402, null);
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

      try {
        await client.getDurations('2026-09-01');
        expect.unreachable('Should have thrown CapabilityRestrictedError');
      } catch (err) {
        expect(err).toBeInstanceOf(CapabilityRestrictedError);
        const restrictedErr = err as CapabilityRestrictedError;
        expect(restrictedErr.capability).toBe('durations');
        expect(restrictedErr.statusCode).toBe(402);
      }
      expect(callCount).toBe(1);
    });

    it('surfaces 403 as non-retriable CapabilityRestrictedError for heartbeats endpoint', async () => {
      let callCount = 0;
      const mockFetch: typeof fetch = async () => {
        callCount++;
        return createResponse(403, null);
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });

      try {
        await client.getHeartbeats('2026-09-01');
        expect.unreachable('Should have thrown CapabilityRestrictedError');
      } catch (err) {
        expect(err).toBeInstanceOf(CapabilityRestrictedError);
        const restrictedErr = err as CapabilityRestrictedError;
        expect(restrictedErr.capability).toBe('heartbeats');
        expect(restrictedErr.statusCode).toBe(403);
      }
      expect(callCount).toBe(1);
    });

    it('surfaces 404 as WakaTimeApiError', async () => {
      const mockFetch: typeof fetch = async () => {
        return createResponse(404, null);
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeApiError
      );
    });

    it('handles network transport failure with WakaTimeNetworkError', async () => {
      const mockFetch: typeof fetch = async () => {
        throw new Error('connect ECONNREFUSED 127.0.0.1:443');
      };

      const client = new WakaTimeClient({ accessToken: dummyAccessToken, fetch: mockFetch });
      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeNetworkError
      );
    });
  });

  describe('parseRetryAfter', () => {
    it('parses integer seconds correctly', () => {
      expect(parseRetryAfter('30')).toBe(30000);
      expect(parseRetryAfter('0')).toBe(0);
      expect(parseRetryAfter('   120  ')).toBe(120000);
    });

    it('parses HTTP date correctly', () => {
      const nowMs = 1700000000000;
      const futureDateStr = new Date(nowMs + 45000).toUTCString();
      expect(parseRetryAfter(futureDateStr, nowMs)).toBe(45000);
    });

    it('returns null for invalid or empty Retry-After header', () => {
      expect(parseRetryAfter(null)).toBeNull();
      expect(parseRetryAfter('')).toBeNull();
      expect(parseRetryAfter('invalid-date-string')).toBeNull();
    });
  });

  describe('Request Gate Integration', () => {
    it('enforces strictly 1 concurrent in-flight request across calls', async () => {
      let inFlight = 0;
      let maxInFlight = 0;

      const mockFetch: typeof fetch = async () => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((r) => setTimeout(r, 20));
        inFlight--;
        return createResponse(200, { data: [] });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        minSpacingMs: 0
      });

      await Promise.all([
        client.getSummaries('2026-09-01', '2026-09-01'),
        client.getSummaries('2026-09-02', '2026-09-02'),
        client.getHeartbeats('2026-09-01')
      ]);

      expect(maxInFlight).toBe(1);
    });

    it('enforces >= 1000ms between request starts with fake clock', async () => {
      let currentTime = 10000;
      const requestStartTimes: number[] = [];

      const mockFetch: typeof fetch = async () => {
        requestStartTimes.push(currentTime);
        return createResponse(200, { data: [] });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        now: () => currentTime,
        sleep: async (ms) => {
          currentTime += ms;
        },
        minSpacingMs: 1000
      });

      await client.getSummaries('2026-09-01', '2026-09-01');
      await client.getSummaries('2026-09-02', '2026-09-02');
      await client.getHeartbeats('2026-09-01');

      expect(requestStartTimes).toHaveLength(3);
      expect(requestStartTimes[1] - requestStartTimes[0]).toBeGreaterThanOrEqual(1000);
      expect(requestStartTimes[2] - requestStartTimes[1]).toBeGreaterThanOrEqual(1000);
    });

    it('enforces >= 1000ms between request starts with injected shared gate', async () => {
      let currentTime = 20000;
      const requestStartTimes: number[] = [];

      const sharedGate = new WakaTimeRequestGate({
        now: () => currentTime,
        delay: async (ms) => {
          currentTime += ms;
        }
      });

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: async () => {
          requestStartTimes.push(currentTime);
          return createResponse(200, { data: [] });
        },
        gate: sharedGate
      });

      await client.getSummaries('2026-09-01', '2026-09-01');
      await client.getSummaries('2026-09-02', '2026-09-02');

      expect(requestStartTimes).toHaveLength(2);
      expect(requestStartTimes[1] - requestStartTimes[0]).toBeGreaterThanOrEqual(1000);
    });

    it('paces across separate WakaTimeClient and WakaTimeOAuthService instances using default application gate', async () => {
      let fakeTime = 50000;
      const requestStartTimes: number[] = [];

      const sharedGate = new WakaTimeRequestGate({
        minSpacingMs: 1000,
        maxConcurrent: 1,
        now: () => fakeTime,
        delay: async (ms) => {
          fakeTime += ms;
        }
      });
      resetApplicationRequestGate(sharedGate);

      try {
        const client = new WakaTimeClient({
          accessToken: dummyAccessToken,
          fetch: async () => {
            requestStartTimes.push(fakeTime);
            return createResponse(200, { data: [] });
          }
        });

        const db = openTestDatabase();
        const repository = new SqliteWakaTimeOAuthConnectionRepository(db);
        const oauthService = new WakaTimeOAuthService({
          repository,
          clientId: 'app-id',
          clientSecret: 'app-secret',
          publicUrl: new URL('http://localhost:3002'),
          encryptionSecret: '0123456789abcdef0123456789abcdef',
          fetch: async () => {
            requestStartTimes.push(fakeTime);
            return new Response(
              JSON.stringify({
                access_token: 'acc',
                refresh_token: 'ref',
                token_type: 'Bearer',
                expires_in: 3600
              }),
              { status: 200, headers: { 'content-type': 'application/json' } }
            );
          }
        });

        // First request via client
        await client.getSummaries('2026-09-01', '2026-09-01');
        // Second request via oauthService
        await oauthService.exchangeCode('code');
        // Third request via client
        await client.getHeartbeats('2026-09-01');

        expect(requestStartTimes).toEqual([50000, 51000, 52000]);
      } finally {
        resetApplicationRequestGate();
      }
    });

    it('acquires token before taking request gate permit to prevent deadlock', async () => {
      const order: string[] = [];
      const gate = new WakaTimeRequestGate({ minSpacingMs: 0 });

      const originalAcquire = gate.acquire.bind(gate);
      gate.acquire = async (opts) => {
        order.push('gate:acquire');
        return originalAcquire(opts);
      };

      const tokenProvider = {
        getAccessToken: async () => {
          order.push('token:get');
          return 'dynamic-token';
        },
        refreshAccessToken: async () => 'refreshed-token'
      };

      const client = new WakaTimeClient({
        tokenProvider,
        gate,
        fetch: async () => createResponse(200, { data: [] })
      });

      await client.getSummaries('2026-09-01', '2026-09-01');
      expect(order).toEqual(['token:get', 'gate:acquire']);
    });

    it('releases gate permit before refreshing token on 401 to avoid deadlocking shared gate', async () => {
      const gate = new WakaTimeRequestGate({ minSpacingMs: 0 });
      let refreshCalled = false;

      const tokenProvider = {
        getAccessToken: async () => 'old-token',
        refreshAccessToken: async () => {
          refreshCalled = true;
          // Token refresh HTTP uses the shared request gate
          const refreshPermit = await gate.acquire();
          refreshPermit.release();
          return 'new-token';
        }
      };

      let attempts = 0;
      const mockFetch: typeof fetch = async () => {
        attempts++;
        if (attempts === 1) {
          return createResponse(401, { error: 'unauthorized' });
        }
        return createResponse(200, { data: [] });
      };

      const client = new WakaTimeClient({
        tokenProvider,
        gate,
        fetch: mockFetch
      });

      const res = await client.getSummaries('2026-09-01', '2026-09-01');
      expect(refreshCalled).toBe(true);
      expect(attempts).toBe(2);
      expect(res.data).toEqual([]);
    });
  });

  describe('Whole-Request Deadline (30s Timeout)', () => {
    it('throws WakaTimeRequestTimeoutError when network fetch hangs past deadline', async () => {
      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        requestTimeoutMs: 50,
        fetch: async (_url, init) => {
          return new Promise((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init.signal?.reason ?? new Error('Aborted'));
            });
          });
        }
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeRequestTimeoutError
      );
    });

    it('throws WakaTimeRequestTimeoutError when streaming body read hangs past deadline', async () => {
      const hangingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data":'));
          // Intentionally do not close controller to simulate hanging body read
        }
      });

      const mockFetch: typeof fetch = async () => {
        return new Response(hangingStream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        requestTimeoutMs: 50,
        fetch: mockFetch
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeRequestTimeoutError
      );
    });
  });

  describe('16 MiB Response Payload Limit', () => {
    it('throws WakaTimeResponseSizeExceededError and cancels stream when body exceeds maxResponseSizeBytes', async () => {
      let streamCancelled = false;
      const chunk = new Uint8Array(1024); // 1 KiB
      const stream = new ReadableStream({
        pull(controller) {
          controller.enqueue(chunk);
        },
        cancel() {
          streamCancelled = true;
        }
      });

      const mockFetch: typeof fetch = async () => {
        return new Response(stream, {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        maxResponseSizeBytes: 2048, // 2 KiB limit
        fetch: mockFetch
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeResponseSizeExceededError
      );
      expect(streamCancelled).toBe(true);
    });

    it('throws WakaTimeResponseSizeExceededError when non-streamed body exceeds maxResponseSizeBytes', async () => {
      const largePayload = { data: 'a'.repeat(5000) };
      const mockFetch: typeof fetch = async () => {
        return createResponse(200, largePayload);
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        maxResponseSizeBytes: 2048,
        fetch: mockFetch
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeResponseSizeExceededError
      );
    });
  });

  describe('Untruncated Retry-After and Deferred Retry', () => {
    it('throws WakaTimeDeferredRetryError without truncating wait when Retry-After exceeds budget', async () => {
      const mockFetch: typeof fetch = async () => {
        return createResponse(429, null, { 'Retry-After': '120' });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        budgetMs: 30000,
        now: () => 1700000000000
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should throw WakaTimeDeferredRetryError');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeDeferredRetryError);
        const defErr = err as WakaTimeDeferredRetryError;
        expect(defErr.isDeferred).toBe(true);
        expect(defErr.code).toBe('UPSTREAM_RETRY_AFTER_EXCEEDED');
        expect(defErr.retryAfterMs).toBe(120000);
        expect(defErr.retryAt).toBe(new Date(1700000000000 + 120000).toISOString());
      }
    });

    it('throws WakaTimeDeferredRetryError on 302 redirect with HTTP date Retry-After exceeding budget', async () => {
      const nowMs = 1700000000000;
      const futureDate = new Date(nowMs + 90000).toUTCString();

      const mockFetch: typeof fetch = async () => {
        return createResponse(302, null, { 'Retry-After': futureDate });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        budgetMs: 15000,
        now: () => nowMs
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should throw WakaTimeDeferredRetryError');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeDeferredRetryError);
        const defErr = err as WakaTimeDeferredRetryError;
        expect(defErr.isDeferred).toBe(true);
        expect(defErr.statusCode).toBe(302);
        expect(defErr.retryAfterMs).toBe(90000);
        expect(defErr.retryAt).toBe(new Date(nowMs + 90000).toISOString());
      }
    });

    it('throws WakaTimeDeferredRetryError on 5xx with Retry-After exceeding budget', async () => {
      const mockFetch: typeof fetch = async () => {
        return createResponse(503, null, { 'Retry-After': '180' });
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        budgetMs: 60000,
        now: () => 1700000000000
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should throw WakaTimeDeferredRetryError');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeDeferredRetryError);
        const defErr = err as WakaTimeDeferredRetryError;
        expect(defErr.statusCode).toBe(503);
        expect(defErr.retryAfterMs).toBe(180000);
      }
    });

    it('defaults work budget to MAX_DAY_EXECUTION_BUDGET_MS (5 minutes / 300,000ms)', () => {
      const client = new WakaTimeClient({ accessToken: dummyAccessToken });
      expect(client.budgetMs).toBe(300000);
      expect(client.budgetMs).toBe(MAX_DAY_EXECUTION_BUDGET_MS);
    });

    it('throws WakaTimeError when budget is exhausted during request gate wait and does not start HTTP fetch', async () => {
      let currentTime = 10000;
      let fetchCalled = false;

      // Gate advances time by 1500ms on acquire
      const gate = new WakaTimeRequestGate({
        now: () => currentTime,
        delay: async (ms) => {
          currentTime += ms;
        },
        minSpacingMs: 1500
      });

      // Warm gate so next acquire needs 1500ms spacing
      const warmPermit = await gate.acquire();
      warmPermit.release();

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        budgetMs: 1000, // Budget is 1000ms, but spacing wait will be 1500ms
        now: () => currentTime,
        gate,
        fetch: async () => {
          fetchCalled = true;
          return createResponse(200, { data: [] });
        }
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeError
      );
      expect(fetchCalled).toBe(false); // Proves HTTP fetch was never started
    });

    it('throws WakaTimeThrottleError without sleeping when computed backoff exceeds remaining budget on 429', async () => {
      let currentTime = 10000;
      let sleepCalled = false;
      let fetchCallCount = 0;

      const mockFetch: typeof fetch = async () => {
        fetchCallCount++;
        return createResponse(429, null); // 429 without Retry-After
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        minSpacingMs: 0,
        budgetMs: 1000,
        baseBackoffMs: 2000, // Computed backoff exceeds budget of 1000ms
        jitterMs: 0,
        now: () => currentTime,
        sleep: async (ms) => {
          sleepCalled = true;
          currentTime += ms;
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should throw WakaTimeThrottleError');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeThrottleError);
        expect(err).not.toBeInstanceOf(WakaTimeDeferredRetryError); // Truthful: not an upstream deferred retry!
        const throttleErr = err as WakaTimeThrottleError;
        expect(throttleErr.statusCode).toBe(429);
        expect(sleepCalled).toBe(false); // Proves it never slept past budget
        expect(fetchCallCount).toBe(1);
      }
    });

    it('throws WakaTimeServerError without sleeping when computed backoff exceeds remaining budget on 5xx', async () => {
      let currentTime = 10000;
      let sleepCalled = false;
      let fetchCallCount = 0;

      const mockFetch: typeof fetch = async () => {
        fetchCallCount++;
        return createResponse(503, null); // 503 without Retry-After
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        minSpacingMs: 0,
        budgetMs: 1000,
        baseBackoffMs: 2000, // Computed backoff exceeds budget of 1000ms
        jitterMs: 0,
        now: () => currentTime,
        sleep: async (ms) => {
          sleepCalled = true;
          currentTime += ms;
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should throw WakaTimeServerError');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeServerError);
        expect(err).not.toBeInstanceOf(WakaTimeDeferredRetryError);
        const serverErr = err as WakaTimeServerError;
        expect(serverErr.status).toBe(503);
        expect(sleepCalled).toBe(false);
        expect(fetchCallCount).toBe(1);
      }
    });
  });

  describe('Token Refresh Error Differentiation', () => {
    it('propagates WakaTimeOAuthRevokedError when refresh indicates revoked access', async () => {
      const tokenProvider = {
        getAccessToken: async () => 'expired',
        refreshAccessToken: async () => {
          throw new WakaTimeOAuthRevokedError('invalid_grant: token was revoked');
        }
      };

      const mockFetch: typeof fetch = async () => {
        return createResponse(401, null);
      };

      const client = new WakaTimeClient({
        tokenProvider,
        fetch: mockFetch
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeOAuthRevokedError
      );
    });

    it('propagates WakaTimeOAuthTransientError when refresh fails due to 5xx or network', async () => {
      const tokenProvider = {
        getAccessToken: async () => 'expired',
        refreshAccessToken: async () => {
          throw new WakaTimeOAuthTransientError('Upstream service unavailable', undefined, 503);
        }
      };

      const mockFetch: typeof fetch = async () => {
        return createResponse(401, null);
      };

      const client = new WakaTimeClient({
        tokenProvider,
        fetch: mockFetch
      });

      await expect(client.getSummaries('2026-09-01', '2026-09-01')).rejects.toThrow(
        WakaTimeOAuthTransientError
      );
    });
  });

  describe('AbortSignal Cancellation', () => {
    it('aborts while waiting in request gate permit queue', async () => {
      const gate = new WakaTimeRequestGate();
      const permit1 = await gate.acquire();

      const abortController = new AbortController();
      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        gate,
        fetch: async () => createResponse(200, { data: [] })
      });

      const reqPromise = client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: abortController.signal
      });

      abortController.abort(new Error('User cancelled request'));

      await expect(reqPromise).rejects.toThrow('User cancelled request');
      permit1.release();
    });

    it('aborts during backoff sleep immediately', async () => {
      let sleepCalled = false;
      const abortController = new AbortController();

      const mockFetch: typeof fetch = async () => {
        return createResponse(429, null);
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        fetch: mockFetch,
        minSpacingMs: 0,
        sleep: async (_ms, signal) => {
          sleepCalled = true;
          return new Promise((_, reject) => {
            signal?.addEventListener('abort', () => {
              reject(signal.reason ?? new Error('Sleep aborted'));
            });
          });
        }
      });

      const reqPromise = client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: abortController.signal
      });

      setTimeout(() => {
        abortController.abort(new Error('Cancelled while sleeping'));
      }, 10);

      await expect(reqPromise).rejects.toThrow('Cancelled while sleeping');
      expect(sleepCalled).toBe(true);
    });

    it('propagates caller AbortSignal to tokenProvider.getAccessToken and aborts before starting data request', async () => {
      let signalReceived: AbortSignal | undefined;
      let fetchCalled = false;
      const abortController = new AbortController();

      const tokenProvider = {
        getAccessToken: async (signal?: AbortSignal) => {
          signalReceived = signal;
          return new Promise<string>((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error('Token acquisition aborted'));
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason ?? new Error('Token acquisition aborted'));
            });
          });
        },
        refreshAccessToken: async () => 'refreshed'
      };

      const client = new WakaTimeClient({
        tokenProvider,
        minSpacingMs: 0,
        fetch: async () => {
          fetchCalled = true;
          return createResponse(200, { data: [] });
        }
      });

      const reqPromise = client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: abortController.signal
      });

      // Abort while token acquisition is in flight
      abortController.abort(new Error('User aborted during token acquisition'));

      await expect(reqPromise).rejects.toThrow('User aborted during token acquisition');
      expect(signalReceived).toBeDefined();
      expect(signalReceived?.aborted).toBe(true);
      expect((signalReceived?.reason as Error)?.message).toBe('User aborted during token acquisition');
      expect(fetchCalled).toBe(false); // Proves no data request starts afterward
    });

    it('propagates caller AbortSignal to tokenProvider.refreshAccessToken on 401 and prevents subsequent request', async () => {
      let refreshSignalReceived: AbortSignal | undefined;
      let fetchCallCount = 0;
      const abortController = new AbortController();

      const tokenProvider = {
        getAccessToken: async () => 'initial-token',
        refreshAccessToken: async (signal?: AbortSignal) => {
          refreshSignalReceived = signal;
          return new Promise<string>((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason ?? new Error('Token refresh aborted'));
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason ?? new Error('Token refresh aborted'));
            });
          });
        }
      };

      const client = new WakaTimeClient({
        tokenProvider,
        minSpacingMs: 0,
        fetch: async () => {
          fetchCallCount++;
          // First attempt returns 401
          return createResponse(401, null);
        }
      });

      const reqPromise = client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: abortController.signal
      });

      // Allow 401 to occur, then abort during refreshAccessToken
      setTimeout(() => {
        abortController.abort(new Error('User aborted during 401 token refresh'));
      }, 10);

      await expect(reqPromise).rejects.toThrow('User aborted during 401 token refresh');
      expect(refreshSignalReceived).toBeDefined();
      expect(refreshSignalReceived?.aborted).toBe(true);
      expect((refreshSignalReceived?.reason as Error)?.message).toBe('User aborted during 401 token refresh');
      expect(fetchCallCount).toBe(1); // Only initial 401 attempt; NO second attempt started afterward!
    });

    it('aborts and throws WakaTimeBudgetTimeoutError during initial token acquisition when budget is exceeded', async () => {
      let fetchCalled = false;
      const tokenProvider = {
        getAccessToken: async (signal?: AbortSignal) => {
          return new Promise<string>((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason);
            });
          });
        },
        refreshAccessToken: async () => 'refreshed'
      };

      const client = new WakaTimeClient({
        tokenProvider,
        budgetMs: 50,
        minSpacingMs: 0,
        fetch: async () => {
          fetchCalled = true;
          return createResponse(200, { data: [] });
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should have timed out on budget');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeBudgetTimeoutError);
        const budgetErr = err as WakaTimeBudgetTimeoutError;
        expect(budgetErr.code).toBe('DAY_EXECUTION_TIMEOUT');
        expect(budgetErr.status).toBe(408);
        expect(fetchCalled).toBe(false); // Proves no HTTP request started
      }
    });

    it('aborts and throws WakaTimeBudgetTimeoutError during gate wait when budget is exceeded', async () => {
      let fetchCalled = false;
      const gate = new WakaTimeRequestGate({
        delay: async (_ms, signal) => {
          return new Promise<void>((_, reject) => {
            if (signal?.aborted) {
              reject(signal.reason);
              return;
            }
            signal?.addEventListener('abort', () => {
              reject(signal.reason);
            });
          });
        },
        minSpacingMs: 1000
      });

      // Warm gate so next acquire enters delay
      const warmPermit = await gate.acquire();
      warmPermit.release();

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        budgetMs: 50,
        gate,
        fetch: async () => {
          fetchCalled = true;
          return createResponse(200, { data: [] });
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should have timed out on budget');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeBudgetTimeoutError);
        const budgetErr = err as WakaTimeBudgetTimeoutError;
        expect(budgetErr.code).toBe('DAY_EXECUTION_TIMEOUT');
        expect(fetchCalled).toBe(false);
      }
    });

    it('aborts and throws WakaTimeBudgetTimeoutError during streaming response body when budget is exceeded', async () => {
      let readerCancelled = false;
      const hangingStream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"data": ['));
        },
        cancel() {
          readerCancelled = true;
        }
      });

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        budgetMs: 50,
        minSpacingMs: 0,
        fetch: async () => {
          return new Response(hangingStream, {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          });
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should have timed out on budget during body read');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeBudgetTimeoutError);
        const budgetErr = err as WakaTimeBudgetTimeoutError;
        expect(budgetErr.code).toBe('DAY_EXECUTION_TIMEOUT');
        expect(readerCancelled).toBe(true);
      }
    });

    it('caps attempt deadline at min(requestTimeoutMs, remainingBudget) and throws DAY_EXECUTION_TIMEOUT instead of REQUEST_TIMEOUT', async () => {
      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        requestTimeoutMs: 30000,
        budgetMs: 60,
        minSpacingMs: 0,
        fetch: async (_url, init) => {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init?.signal?.reason);
            });
          });
        }
      });

      try {
        await client.getSummaries('2026-09-01', '2026-09-01');
        expect.unreachable('Should have timed out on budget');
      } catch (err) {
        expect(err).toBeInstanceOf(WakaTimeBudgetTimeoutError);
        expect(err).not.toBeInstanceOf(WakaTimeRequestTimeoutError);
        const budgetErr = err as WakaTimeBudgetTimeoutError;
        expect(budgetErr.code).toBe('DAY_EXECUTION_TIMEOUT');
        expect(budgetErr.code).not.toBe('REQUEST_TIMEOUT');
      }
    });

    it('caller cancellation wins with its reason even when budget deadline is close', async () => {
      const abortController = new AbortController();
      const customReason = new Error('Custom caller abort reason');

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        budgetMs: 80,
        minSpacingMs: 0,
        fetch: async (_url, init) => {
          return new Promise<Response>((_, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(init?.signal?.reason);
            });
          });
        }
      });

      const reqPromise = client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: abortController.signal
      });

      setTimeout(() => {
        abortController.abort(customReason);
      }, 10);

      try {
        await reqPromise;
        expect.unreachable('Should have aborted');
      } catch (err) {
        expect(err).toBe(customReason);
        expect(err).not.toBeInstanceOf(WakaTimeBudgetTimeoutError);
        expect(err).not.toBeInstanceOf(WakaTimeRequestTimeoutError);
      }
    });

    it('cleans up all abort listeners and timers on caller signal without leaks', async () => {
      const callerController = new AbortController();
      const callerSignal = callerController.signal;

      let addedListeners = 0;
      let removedListeners = 0;
      const originalAdd = callerSignal.addEventListener.bind(callerSignal);
      const originalRemove = callerSignal.removeEventListener.bind(callerSignal);

      callerSignal.addEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | AddEventListenerOptions
      ) => {
        if (type === 'abort') addedListeners++;
        return originalAdd(type, listener, options);
      };
      callerSignal.removeEventListener = (
        type: string,
        listener: EventListenerOrEventListenerObject,
        options?: boolean | EventListenerOptions
      ) => {
        if (type === 'abort') removedListeners++;
        return originalRemove(type, listener, options);
      };

      const client = new WakaTimeClient({
        accessToken: dummyAccessToken,
        budgetMs: 5000,
        minSpacingMs: 0,
        fetch: async () => createResponse(200, { data: [] })
      });

      await client.getSummaries({
        start: '2026-09-01',
        end: '2026-09-01',
        signal: callerSignal
      });

      expect(addedListeners).toBeGreaterThan(0);
      expect(removedListeners).toBe(addedListeners);
    });
  });

  describe('Error Message Sanitization', () => {
    it('redacts sensitive credentials, tokens, emails, paths, SQL, and JSON payloads', () => {
      const raw =
        'Error with sec_1234567890abcdef and Bearer my_secret_token at /Users/john/repo/src/file.ts for john.smith@company.com with client_secret=very_secret SELECT * FROM accounts WHERE password = 123 {"raw":"secret_data"}';
      const sanitized = sanitizeErrorMessage(raw);

      expect(sanitized).not.toContain('sec_1234567890abcdef');
      expect(sanitized).not.toContain('my_secret_token');
      expect(sanitized).not.toContain('/Users/john');
      expect(sanitized).not.toContain('john.smith@company.com');
      expect(sanitized).not.toContain('very_secret');
      expect(sanitized).not.toContain('SELECT * FROM');
      expect(sanitized).not.toContain('secret_data');
    });
  });
});
