import {describe, expect, it} from 'vitest'

import type {RawConfig, ResolvedBinding, ResolvedWorker} from '../../src/config/types.js'
import {buildGraph} from '../../src/graph/graph.js'

function node(dir: string, bindings: ResolvedBinding[] = [], config: RawConfig = {}, env?: string): ResolvedWorker {
  return {bindings, config, deployedName: dir, dir, env, path: dir}
}

function local(dir: string, source: ResolvedBinding['source'] = 'services', binding = 'B'): ResolvedBinding {
  return {binding, source, target: {dir, kind: 'local'}}
}

function queues(section: RawConfig, env: string): RawConfig {
  return {env: {[env]: {queues: section}}}
}

describe('buildGraph', () => {
  it('makes an edge from every local binding, with its kind', () => {
    const graph = buildGraph([
      node('a', [local('b'), local('c', 'workflows'), local('d', 'durable_objects'), local('e', 'tail_consumers')]),
      node('b'),
      node('c'),
      node('d'),
      node('e'),
    ])

    expect(graph.nodes).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(graph.edges).toEqual([
      {from: 'a', kind: 'services', to: 'b', via: 'B'},
      {from: 'a', kind: 'workflows', to: 'c', via: 'B'},
      {from: 'a', kind: 'durable_objects', to: 'd', via: 'B'},
      {from: 'a', kind: 'tail_consumers', to: 'e', via: 'B'},
    ])
  })

  it('lists external bindings apart, without edges or nodes', () => {
    const graph = buildGraph([
      node('a', [{binding: 'X', source: 'services', target: {kind: 'external', name: 'elsewhere'}}]),
    ])

    expect(graph.nodes).toEqual(['a'])
    expect(graph.edges).toEqual([])
    expect(graph.external).toEqual([{binding: 'X', name: 'elsewhere', source: 'services', worker: 'a'}])
  })

  it('makes a queue edge from the producer to the consumer', () => {
    const graph = buildGraph([
      node('producer', [], {queues: {producers: [{binding: 'Q', queue: 'jobs'}]}}),
      node('consumer', [], {queues: {consumers: [{queue: 'jobs'}]}}),
    ])

    expect(graph.edges).toEqual([{from: 'producer', kind: 'queues', to: 'consumer', via: 'jobs'}])
  })

  it('reads queues from the env section when an env is selected, since they do not inherit', () => {
    const graph = buildGraph([
      node('p', [], {...queues({producers: [{queue: 'jobs'}]}, 'staging'), queues: {producers: [{queue: 'top'}]}}, 'staging'),
      node('c', [], {...queues({consumers: [{queue: 'jobs'}]}, 'staging'), queues: {consumers: [{queue: 'top'}]}}, 'staging'),
      node('other', [], queues({consumers: [{queue: 'jobs'}]}, 'production'), 'staging'),
    ])

    expect(graph.edges).toEqual([{from: 'p', kind: 'queues', to: 'c', via: 'jobs'}])
  })

  it('makes one queue edge per consumer, and none for a queue with no local consumer', () => {
    const graph = buildGraph([
      node('p', [], {queues: {producers: [{queue: 'jobs'}, {queue: 'external'}]}}),
      node('c1', [], {queues: {consumers: [{queue: 'jobs'}]}}),
      node('c2', [], {queues: {consumers: [{queue: 'jobs'}]}}),
    ])

    expect(graph.edges.map(({to}) => to)).toEqual(['c1', 'c2'])
  })

  it('makes an edge from every other reference kind', () => {
    const graph = buildGraph([
      node('a', [local('b', 'streaming_tail_consumers'), local('c', 'dispatch_namespaces')]),
      node('b'),
      node('c'),
    ])

    expect(graph.edges.map(({kind, to}) => [kind, to])).toEqual([
      ['streaming_tail_consumers', 'b'],
      ['dispatch_namespaces', 'c'],
    ])
  })

  it('makes an edge from a consumer to the consumer of its dead letter queue', () => {
    const graph = buildGraph([
      node('worker', [], {queues: {consumers: [{dead_letter_queue: 'jobs-dlq', queue: 'jobs'}]}}),
      node('rescue', [], {queues: {consumers: [{queue: 'jobs-dlq'}]}}),
      node('other', [], {queues: {consumers: [{dead_letter_queue: 'nobody-reads-this', queue: 'other'}]}}),
    ])

    expect(graph.edges).toEqual([{from: 'worker', kind: 'queues', to: 'rescue', via: 'jobs-dlq'}])
  })

  it('reads a dead letter queue from the env section only', () => {
    const graph = buildGraph([
      node('worker', [], {queues: {consumers: [{dead_letter_queue: 'dlq', queue: 'q'}]}}, 'staging'),
      node('rescue', [], queues({consumers: [{queue: 'dlq'}]}, 'staging'), 'staging'),
    ])

    expect(graph.edges).toEqual([])
  })

  it('keeps a self edge', () => {
    const graph = buildGraph([node('a', [local('a')], {queues: {consumers: [{queue: 'q'}], producers: [{queue: 'q'}]}})])
    expect(graph.edges.map(({from, kind, to}) => [from, kind, to])).toEqual([
      ['a', 'queues', 'a'],
      ['a', 'services', 'a'],
    ])
  })

  it('drops an edge to a worker that is not in the graph', () => {
    expect(buildGraph([node('a', [local('failed')])]).edges).toEqual([])
  })

  it('does not depend on input order', () => {
    const a = node('a', [local('b', 'services', 'Y'), local('b', 'services', 'X')])
    const b = node('b', [{binding: 'Z', source: 'services', target: {kind: 'external', name: 'z'}}])
    expect(buildGraph([b, a])).toEqual(buildGraph([a, b]))
  })
})
