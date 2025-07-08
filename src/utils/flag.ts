/**
 * Converts kebab-case flag names to camelCase
 * For example: 'base-config' -> 'baseConfig'
 *
 * @param flagName The flag name that might be in kebab-case
 * @returns The camelCase version of the flag name
 */
export function kebabToCamelCase(flagName: string): string {
  return flagName.replaceAll(/-([a-z])/g, (_, char) => char.toUpperCase())
}

/**
 * Normalizes flag names from kebab-case to camelCase
 * This allows users to use --kebab-case flags while the code uses camelCase
 *
 * @param flags The original flags object
 * @returns A new flags object with normalized keys
 */
export function normalizeFlags<T>(flags: Record<string, unknown>): T {
  const normalizedFlags: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(flags)) {
    const normalizedKey = kebabToCamelCase(key)
    normalizedFlags[normalizedKey] = value
  }

  return normalizedFlags as T
}
