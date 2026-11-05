import {describe, expect, it} from 'vitest'

import type {Graph} from '../../src/graph/graph.js'
import type {ResolvedWorker} from '../../src/config/types.js'
import {callers, computeOrder, serviceClosure} from '../../src/graph/order.js'

function graphOf(nodes: string[], edges: [string, string][]): Graph {
  return {
    edges: edges.map(([from, to]) => ({from, kind: 'services', to, via: 'B'})),
    external: [],
    nodes,
  }
}

describe('computeOrder', () => {
  it('puts callees first', () => {
    const graph = graphOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['b', 'c'],
      ],
    )
    expect(computeOrder(graph)).toEqual({cycles: [], levels: [['c'], ['b'], ['a']]})
  })

  it('puts a worker one level above its deepest callee', () => {
    const graph = graphOf(
      ['a', 'b', 'c'],
      [
        ['a', 'b'],
        ['a', 'c'],
        ['b', 'c'],
      ],
    )
    expect(computeOrder(graph).levels).toEqual([['c'], ['b'], ['a']])
  })

  it('groups independent workers in sorted levels, whatever the input order', () => {
    const edges: [string, string][] = [
      ['z', 'y'],
      ['a', 'b'],
    ]
    const expected = [
      ['b', 'y'],
      ['a', 'z'],
    ]
    expect(computeOrder(graphOf(['z', 'y', 'b', 'a'], edges)).levels).toEqual(expected)
    expect(computeOrder(graphOf(['a', 'b', 'y', 'z'], edges.reverse())).levels).toEqual(expected)
  })

  it('returns a cycle as data, with its members on one level', () => {
    const graph = graphOf(
      ['a', 'b', 'c', 'leaf', 'top'],
      [
        ['a', 'b'],
        ['b', 'c'],
        ['c', 'a'],
        ['b', 'leaf'],
        ['top', 'a'],
      ],
    )

    expect(computeOrder(graph)).toEqual({
      cycles: [['a', 'b', 'c']],
      levels: [['leaf'], ['a', 'b', 'c'], ['top']],
    })
  })

  it('returns several cycles, sorted', () => {
    const graph = graphOf(
      ['d', 'c', 'b', 'a'],
      [
        ['d', 'c'],
        ['c', 'd'],
        ['b', 'a'],
        ['a', 'b'],
      ],
    )
    expect(computeOrder(graph).cycles).toEqual([
      ['a', 'b'],
      ['c', 'd'],
    ])
  })

  it('reports a self edge as a cycle without blocking the worker', () => {
    const graph = graphOf(
      ['a', 'b'],
      [
        ['a', 'a'],
        ['a', 'b'],
      ],
    )
    expect(computeOrder(graph)).toEqual({cycles: [['a']], levels: [['b'], ['a']]})
  })

  it('counts two edges between the same workers once', () => {
    const graph = graphOf(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['a', 'b'],
      ],
    )
    expect(computeOrder(graph).levels).toEqual([['b'], ['a']])
  })

  it('stays fast on a layered graph with an exponential number of paths', () => {
    const nodes: string[] = []
    const edges: [string, string][] = []
    for (let layer = 0; layer < 40; layer++) {
      for (const side of ['l', 'r']) {
        nodes.push(`${side}${layer}`)
        if (layer > 0) edges.push([`${side}${layer}`, `l${layer - 1}`], [`${side}${layer}`, `r${layer - 1}`])
      }
    }

    const graph = graphOf(nodes, edges)
    const started = Date.now()
    expect(computeOrder(graph).levels).toHaveLength(40)
    expect(callers(graph, 'l0')).toHaveLength(78)
    expect(Date.now() - started).toBeLessThan(1000)
  })

  it('handles an empty graph', () => {
    expect(computeOrder(graphOf([], []))).toEqual({cycles: [], levels: []})
  })
})

describe('callers', () => {
  const graph = graphOf(
    ['a', 'b', 'c', 'd'],
    [
      ['a', 'b'],
      ['b', 'c'],
      ['d', 'c'],
    ],
  )

  it('returns transitive callers, sorted', () => {
    expect(callers(graph, 'c')).toEqual(['a', 'b', 'd'])
  })

  it('returns nothing for a worker no one calls', () => {
    expect(callers(graph, 'a')).toEqual([])
  })

  it('excludes the worker itself, and ends on a cycle', () => {
    const cycle = graphOf(
      ['a', 'b'],
      [
        ['a', 'b'],
        ['b', 'a'],
        ['a', 'a'],
      ],
    )
    expect(callers(cycle, 'a')).toEqual(['b'])
  })

  it('returns nothing for an unknown worker', () => {
    expect(callers(graph, 'ghost')).toEqual([])
  })
})

const local = (source: string, dir: string) => ({source, target: {dir, kind: 'local'}})
const worker = (dir: string, ...bindings: unknown[]) => ({bindings, dir}) as unknown as ResolvedWorker

describe('serviceClosure', () => {
  it('reaches bindings transitively, each before what binds to it', () => {
    const workers = [
      worker('gateway', local('services', 'orders')),
      worker('orders', local('services', 'billing')),
      worker('billing'),
    ]

    expect(serviceClosure(workers, ['gateway']).reached).toEqual(['billing', 'orders'])
  })

  it('reaches each once through a cycle, and leaves out the start', () => {
    const workers = [worker('a', local('services', 'b')), worker('b', local('services', 'a'))]

    expect(serviceClosure(workers, ['a']).reached).toEqual(['b'])
  })

  it('follows only service bindings', () => {
    const workers = [worker('a', local('queues', 'b')), worker('b')]

    expect(serviceClosure(workers, ['a']).reached).toEqual([])
  })

  it('does not follow external targets', () => {
    const workers = [worker('a', {source: 'services', target: {kind: 'external', name: 'x'}})]

    expect(serviceClosure(workers, ['a'])).toEqual({reached: [], skipped: [], unresolved: []})
  })

  it('reports what it skips, and does not follow through it', () => {
    const workers = [worker('a', local('services', 'b')), worker('b', local('services', 'c')), worker('c')]

    expect(serviceClosure(workers, ['a'], ['b'])).toEqual({reached: [], skipped: ['b'], unresolved: []})
  })

  it('reports a target that could not be resolved', () => {
    const workers = [worker('a', local('services', 'broken'))]

    expect(serviceClosure(workers, ['a']).unresolved).toEqual(['broken'])
  })
})
