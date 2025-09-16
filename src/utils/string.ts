import {Unstable_RawConfig} from 'wrangler'

/**
 * Sanitizes a worker name
 * @param workerName Worker name
 * @returns Sanitized worker name
 */
export function sanitizeWorkerName(workerName: string): string {
  if (!/^[a-z0-9-]+$/.test(workerName)) {
    return workerName.replaceAll(/[^a-z0-9-]/g, '-')
  }

  return workerName
}

/**
 * Parses a route pattern
 * @param pattern Route pattern
 * @returns Parsed route pattern
 */
export function parseRouteFromPattern(pattern: string): string {
  // Remove protocol and domain if present
  const parts = pattern.startsWith('http') ? pattern.split('/').slice(3) : pattern.split('/').slice(1)
  // Remove trailing wildcard or empty segment
  if (parts.length > 0 && (parts.at(-1) === '*' || parts.at(-1) === '')) {
    parts.pop()
  }

  const result = '/' + parts.join('/')
  return result === '/' ? '' : result
}

/**
 * Helper to extract a simple path prefix from a wrangler config's route definition
 * @param config Wrangler config
 * @returns Simple path prefix
 */
export function getRoutePrefix(config: Unstable_RawConfig): string | undefined {
  // Prefer a single `route` string if present
  if (typeof config.route === 'string') {
    return parseRouteFromPattern(config.route)
  }

  if (typeof config.route === 'object' && 'pattern' in config.route) {
    return parseRouteFromPattern(config.route.pattern)
  }

  // If `routes` is an array, take the first entry (common case for dev)
  if (Array.isArray(config.routes) && config.routes.length > 0) {
    const first = config.routes[0]
    if (typeof first === 'string') {
      return parseRouteFromPattern(first)
    }

    if (first && typeof first === 'object' && 'pattern' in first) {
      return parseRouteFromPattern(first.pattern)
    }
  }

  // Fallback: use the worker name as a prefix
  return undefined
}
