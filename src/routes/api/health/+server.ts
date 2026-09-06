import { json } from '@sveltejs/kit';
import { runtime } from '$lib/server/runtime';

export const prerender = false;

export function GET() {
  let dbStatus = 'ready';
  let isReady = true;

  try {
    const row = runtime.db.prepare('SELECT 1 as ready').get() as { ready?: number } | undefined;
    if (row?.ready !== 1) {
      dbStatus = 'unavailable';
      isReady = false;
    }
  } catch {
    dbStatus = 'unavailable';
    isReady = false;
  }

  return json(
    {
      status: isReady ? 'ok' : 'degraded',
      service: 'work-times',
      database: dbStatus
    },
    {
      status: isReady ? 200 : 503,
      headers: {
        'cache-control': 'no-store'
      }
    }
  );
}
