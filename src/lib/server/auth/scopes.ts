export const APPLICATION_SCOPES = [
  'activity:read',
  'activity:detail',
  'operations:read'
] as const;

export type ApplicationScope = (typeof APPLICATION_SCOPES)[number];

const scopeSet = new Set<string>(APPLICATION_SCOPES);

export function parseScopes(input: string | readonly string[]): ApplicationScope[] {
  const values: string[] = typeof input === 'string' ? input.split(/[\s,]+/) : [...input];
  const result = [...new Set(values.map((value) => value.trim()).filter(Boolean))];

  for (const value of result) {
    if (!scopeSet.has(value)) throw new Error(`Unsupported scope: ${value}`);
  }

  return result.sort() as ApplicationScope[];
}

export function hasRequiredScopes(
  granted: readonly ApplicationScope[],
  required: readonly ApplicationScope[]
): boolean {
  const available = new Set(granted);
  return required.every((scope) => available.has(scope));
}
