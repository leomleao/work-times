import { json } from '@sveltejs/kit';
import { getRuntimeConfig } from '$lib/server/config';
import { protectedResourceMetadata } from '$lib/server/oauth/metadata';

export function GET() {
  return json(protectedResourceMetadata(getRuntimeConfig().publicUrl), {
    headers: { 'cache-control': 'public, max-age=300' }
  });
}
