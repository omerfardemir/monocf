import {mkdirSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {envSection} from '../config/resolve.js'
import {isPlainObject, type RawConfig} from '../config/types.js'
import type {RunDir} from './run-dir.js'

export const PROXY_WORKER = 'proxy-worker'

function patternOf(route: unknown): string | undefined {
  if (typeof route === 'string') return route
  return isPlainObject(route) && typeof route.pattern === 'string' ? route.pattern : undefined
}

function firstRoute({route, routes}: RawConfig): string | undefined {
  return patternOf(route) ?? (Array.isArray(routes) ? patternOf(routes[0]) : undefined)
}

function pathOf(pattern: string): string {
  const withoutHost = pattern.startsWith('http') ? pattern.split('/').slice(3) : pattern.split('/').slice(1)
  const path = `/${withoutHost.join('/')}`.replace(/\*$/, '').replace(/\/$/, '')
  return path
}

/**
 * The path a worker's route gives it in the proxy, read from the env's section first, as wrangler does. A route that
 * covers a whole host has no path, and an empty prefix would catch every request, so it gets none here.
 */
export function routePrefix(config: RawConfig, env?: string): string | undefined {
  const pattern = firstRoute(envSection(config, env)) ?? firstRoute(config)
  if (pattern === undefined) return undefined
  return pathOf(pattern) || undefined
}

/** The proxy worker's source. The longest prefix wins, and a prefix matches only on a path boundary. */
export function proxySource(map: Record<string, number>): string {
  return `const map = ${JSON.stringify(map, null, 2)};
const prefixes = Object.keys(map).sort((a, b) => b.length - a.length);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const match = prefixes.find((p) => url.pathname === p || url.pathname.startsWith(p + "/"));
    if (!match) return new Response("Not found", { status: 404 });
    url.port = String(map[match]);
    return fetch(new Request(url.toString(), request));
  },
};
`
}

/** Writes the proxy worker into the run directory and returns its config path. */
export function materialiseProxy(map: Record<string, number>, port: number, runDir: RunDir): string {
  const dir = runDir.workerDir(PROXY_WORKER)
  mkdirSync(join(dir, 'src'), {recursive: true})
  writeFileSync(join(dir, 'src', 'index.ts'), proxySource(map))
  const configPath = join(dir, 'wrangler.json')
  const config = {compatibility_date: '2025-01-09', dev: {port}, main: './src/index.ts', name: PROXY_WORKER}
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  return configPath
}
