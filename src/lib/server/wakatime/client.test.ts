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
  sanitizeEndpoint
} from './errors.js';

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
      expect(res.data[0].projects[0].name).toBe('work-times');
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
        }
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
        random: () => 0.5 // deterministic jitter: 50ms
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
        maxThrottleRetries: 2
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
        maxRetries5xx: 3
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
});
