import {afterEach, describe, expect, it, vi} from 'vitest'

import {proxySource, routePrefix} from '../../src/runtime/dev-proxy.js'

describe('routePrefix', () => {
  it.each([
    ['a route string', {route: 'example.com/api/*'}, '/api'],
    ['a route object', {route: {pattern: 'example.com/api/*', zone_name: 'example.com'}}, '/api'],
    ['the first of routes', {routes: ['example.com/a/*', 'example.com/b/*']}, '/a'],
    ['a route with a scheme', {route: 'https://example.com/api/*'}, '/api'],
    ['a nested path', {route: 'example.com/a/b/*'}, '/a/b'],
    ['a path with no wildcard', {route: 'example.com/a'}, '/a'],
  ])('reads %s', (_, config, prefix) => {
    expect(routePrefix(config)).toBe(prefix)
  })

  it.each([
    ['nothing', {}],
    ['a whole host', {route: 'example.com/*'}],
    ['a bare host', {route: 'example.com'}],
    ['a host with a scheme', {route: 'https://example.com/*'}],
    ['a custom domain', {routes: [{custom_domain: true, pattern: 'api.example.com'}]}],
  ])('finds no prefix in %s, rather than an empty one', (_, config) => {
    expect(routePrefix(config)).toBeUndefined()
  })

  it('prefers the env section, and falls back to the top level', () => {
    const config = {env: {none: {}, staging: {route: 'example.com/s/*'}}, route: 'example.com/top/*'}

    expect(routePrefix(config, 'staging')).toBe('/s')
    expect(routePrefix(config, 'none')).toBe('/top')
    expect(routePrefix(config)).toBe('/top')
  })
})

async function route(map: Record<string, number>, url: string): Promise<null | string> {
  const module = await import(`data:text/javascript,${encodeURIComponent(proxySource(map))}`)
  const forwarded: string[] = []
  vi.stubGlobal('fetch', async (request: Request) => {
    forwarded.push(request.url)
    return new Response('ok')
  })
  const response: Response = await module.default.fetch(new Request(url))
  return response.status === 404 ? null : forwarded[0]
}

describe('proxySource', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends a request to the port of its prefix', async () => {
    expect(await route({'/a': 9001, '/b': 9002}, 'http://localhost:8787/b/x?y=1')).toBe('http://localhost:9002/b/x?y=1')
  })

  it('prefers the longest prefix', async () => {
    expect(await route({'/a': 9001, '/a/b': 9002}, 'http://localhost:8787/a/b/c')).toBe('http://localhost:9002/a/b/c')
  })

  it('matches only on a path boundary', async () => {
    expect(await route({'/api': 9001}, 'http://localhost:8787/apiary')).toBeNull()
  })

  it('matches the prefix itself', async () => {
    expect(await route({'/api': 9001}, 'http://localhost:8787/api')).toBe('http://localhost:9001/api')
  })

  it('answers 404 for what no worker owns', async () => {
    expect(await route({'/api': 9001}, 'http://localhost:8787/')).toBeNull()
  })
})
