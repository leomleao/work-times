import { runtime } from '$lib/server/runtime';
import type { RequestHandler } from './$types';

export const prerender = false;

export const GET: RequestHandler = async ({ request }) => {
  return runtime.authenticatedMcpHandler(request);
};

export const POST: RequestHandler = async ({ request }) => {
  return runtime.authenticatedMcpHandler(request);
};

export const DELETE: RequestHandler = async ({ request }) => {
  return runtime.authenticatedMcpHandler(request);
};
