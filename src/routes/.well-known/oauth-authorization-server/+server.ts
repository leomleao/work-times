import { json } from '@sveltejs/kit';
import { getRuntimeConfig } from '$lib/server/config';
import { authorizationServerMetadata } from '$lib/server/oauth/metadata';

export function GET() {
  return json(authorizationServerMetadata(getRuntimeConfig().publicUrl), {
    headers: { 'cache-control': 'public, max-age=300' }
  });
}
