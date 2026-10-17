//
// Copyright © 2026 Intabia Fusion.
//
// Licensed under the Eclipse Public License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License. You may
// obtain a copy of the License at https://www.eclipse.org/legal/epl-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
//
// See the License for the specific language governing permissions and
// limitations under the License.
//

import { describe, it, expect } from 'vitest'

import { getAllDependencies, topologicalSortWaves } from '../libs/graph.js'
import type { DependencyGraph, PackageNode } from '../types.js'

interface NodeSpec {
  deps?: string[]
  phaseBuild?: string
  phaseBundle?: string
  phasePackage?: string
  phaseDockerBuild?: string
  phaseFormat?: string
  phaseSvelteCheck?: string
  phaseTest?: string
}

// a -> b -> c, and d standing alone.
function makeGraph (spec: Record<string, NodeSpec>): DependencyGraph {
  const graph: DependencyGraph = new Map()
  for (const [name, node] of Object.entries(spec)) {
    graph.set(name, {
      project: { name, fullPath: `/repo/${name}` },
      dependencies: new Set(node.deps ?? []),
      dependents: new Set(),
      phaseBuild: node.phaseBuild ?? 'compile build',
      phaseBundle: node.phaseBundle,
      phasePackage: node.phasePackage,
      phaseDockerBuild: node.phaseDockerBuild,
      phaseFormat: node.phaseFormat,
      phaseSvelteCheck: node.phaseSvelteCheck,
      phaseTest: node.phaseTest
    } as unknown as PackageNode)
  }
  for (const [name, node] of graph) {
    for (const dep of node.dependencies) {
      graph.get(dep)?.dependents.add(name)
    }
  }
  return graph
}

describe('getAllDependencies', () => {
  it('collects the transitive closure', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['c'] }, c: {}, d: {} })
    expect([...getAllDependencies(graph, 'a')].sort()).toEqual(['b', 'c'])
  })

  it('does not include the package itself', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: {} })
    expect(getAllDependencies(graph, 'a').has('a')).toBe(false)
  })

  it('terminates on a dependency cycle', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['a'] } })
    expect([...getAllDependencies(graph, 'a')].sort()).toEqual(['a', 'b'])
  })

  it('returns empty for an unknown package', () => {
    const graph = makeGraph({ a: {} })
    expect(getAllDependencies(graph, 'nope').size).toBe(0)
  })
})

describe('topologicalSortWaves', () => {
  it('orders dependencies before dependents', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['c'] }, c: {} })
    const waves = topologicalSortWaves(graph, () => true)
    const order = waves.map(w => w.map(p => p.name))
    expect(order).toEqual([['c'], ['b'], ['a']])
  })

  it('puts independent packages in the same wave', () => {
    const graph = makeGraph({ a: {}, b: {}, c: { deps: ['a', 'b'] } })
    const waves = topologicalSortWaves(graph, () => true)
    expect(waves[0].map(p => p.name).sort()).toEqual(['a', 'b'])
    expect(waves[1].map(p => p.name)).toEqual(['c'])
  })

  it('ignores edges to packages excluded by the filter', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: {} })
    const waves = topologicalSortWaves(graph, (_node, name) => name === 'a')
    expect(waves).toEqual([[waves[0][0]]].map(w => w))
    expect(waves[0].map(p => p.name)).toEqual(['a'])
  })

  it('throws on a cycle instead of looping forever', () => {
    const graph = makeGraph({ a: { deps: ['b'] }, b: { deps: ['a'] } })
    expect(() => topologicalSortWaves(graph, () => true)).toThrow(/Circular dependency/)
  })
})
