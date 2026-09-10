import type { PageServerLoad } from './$types';
import { runtime } from '$lib/server/runtime';
import {
  getAllRecipes,
  selectSafeApiKeyMetadata,
  type McpAuthMethod,
  type McpClientType,
  type McpRecipe,
  type SafeApiKeyMetadata
} from '$lib/server/mcp/config-recipes';

export const load: PageServerLoad = async () => {
  const endpoint = new URL('/mcp', runtime.config.publicUrl).toString();
  const rawKeys = await runtime.apiKeys.list();
  const keys: SafeApiKeyMetadata[] = selectSafeApiKeyMetadata(rawKeys as Array<Record<string, unknown>>);
  const recipes: Record<McpClientType, Record<McpAuthMethod, McpRecipe>> = getAllRecipes(endpoint);

  const activeKeys = keys.filter((k) => k.isActive);

  return {
    endpoint,
    keys,
    activeKeysCount: activeKeys.length,
    hasActiveKey: activeKeys.length > 0,
    recipes
  };
};
