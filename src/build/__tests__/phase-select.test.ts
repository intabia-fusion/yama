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

import { selectPackagesForPhases } from '../libs/phase-select.js'
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

function makeGraph (spec: Record<string, NodeSpec>): DependencyGraph {
  const graph: DependencyGraph = new Map()
  for (const [name, node] of Object.entries(spec)) {
    graph.set(name, {
      project: { name, fullPath: `/repo/${name}` },
      dependencies: new Set(node.deps ?? []),
      dependents: new Set(),
      phaseBuild: node.phaseBuild,
      phaseBundle: node.phaseBundle,
      phasePackage: node.phasePackage,
      phaseDockerBuild: node.phaseDockerBuild,
      phaseFormat: node.phaseFormat,
      phaseSvelteCheck: node.phaseSvelteCheck,
      phaseTest: node.phaseTest
    } as unknown as PackageNode)
  }
  return graph
}

const ALL = { doTest: true, doBundle: true, doPackage: true, doDockerBuild: true, doSvelteCheck: true }

describe('selectPackagesForPhases', () => {
  it('picks up the three known build scripts', () => {
    const graph = makeGraph({
      src: { phaseBuild: 'compile build' },
      ui: { phaseBuild: 'compile build-ui' },
      uiEsbuild: { phaseBuild: 'compile ui-esbuild' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    expect(sel.build.sort()).toEqual(['src', 'ui', 'uiEsbuild'])
    expect(sel.unknown).toEqual([])
  })

  // Regression: `services/ai-bot/love-agent` ("wasm && node esbuild.config.js") was dropped
  // by a strict string comparison — never built and never reported.
  it('reports an unrecognised build script instead of dropping it silently', () => {
    const graph = makeGraph({ wasmPkg: { phaseBuild: 'wasm && node esbuild.config.js' } })
    const sel = selectPackagesForPhases(graph, ALL)
    expect(sel.build).toEqual([])
    expect(sel.unknown).toEqual([{ package: 'wasmPkg', phase: 'build', script: 'wasm && node esbuild.config.js' }])
  })

  it('"echo done" is an explicit no-op, not an unknown script', () => {
    const graph = makeGraph({
      noop: { phaseBuild: 'echo done', phaseBundle: 'echo done' }
    })
    const sel = selectPackagesForPhases(graph, ALL)
    expect(sel.build).toEqual([])
    expect(sel.bundle).toEqual([])
    expect(sel.unknown).toEqual([])
  })

  it('phases are skipped unless their flag is set', () => {
    const graph = makeGraph({
      a: {
        phaseBuild: 'compile build',
        phaseTest: 'jest --passWithNoTests',
        phaseBundle: 'node esbuild.js',
        phaseSvelteCheck: 'do-svelte-check'
      }
    })
    const sel = selectPackagesForPhases(graph, {})
    expect(sel.build).toEqual(['a'])
    expect(sel.test).toEqual([])
    expect(sel.bundle).toEqual([])
    expect(sel.svelteCheck).toEqual([])
  })

  it('honours the --to target set', () => {
    const graph = makeGraph({
      a: { phaseBuild: 'compile build' },
      b: { phaseBuild: 'compile build' }
    })
    const sel = selectPackagesForPhases(graph, { ...ALL, targetPackages: new Set(['a']) })
    expect(sel.build).toEqual(['a'])
  })

  it('format is always collected', () => {
    const graph = makeGraph({ a: { phaseBuild: 'compile build', phaseFormat: 'format src' } })
    expect(selectPackagesForPhases(graph, {}).format).toEqual(['a'])
  })
})
