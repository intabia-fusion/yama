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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'

import { computeTypesHashes, compositeHashFromTypes } from '../libs/composite-hash.js'
import type { DependencyGraph, PackageNode } from '../types.js'

let root: string

beforeEach(() => {
  root = fs.mkdtempSync(join(os.tmpdir(), 'rig-comp-'))
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

// core <- mid <- app
function makeGraph (): DependencyGraph {
  const graph: DependencyGraph = new Map()
  const add = (name: string, deps: string[]): void => {
    const fullPath = join(root, name)
    fs.mkdirSync(join(fullPath, 'types'), { recursive: true })
    fs.writeFileSync(join(fullPath, 'types', 'index.d.ts'), `export declare const ${name}: number\n`)
    graph.set(name, { project: { name, fullPath }, dependencies: new Set(deps), dependents: new Set() } as unknown as PackageNode)
  }
  add('core', [])
  add('mid', ['core'])
  add('app', ['mid'])
  return graph
}

const OWN = new Map([['core', 'h-core'], ['mid', 'h-mid'], ['app', 'h-app']])

describe('compositeHashFromTypes', () => {
  // Regression: lint/svelte-check keyed on dependency *sources*, so editing anything
  // upstream re-ran them for the whole downstream closure even when no API changed.
  it('ignores a dependency source change that leaves its types alone', () => {
    const graph = makeGraph()
    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    const changedSources = new Map(OWN)
    changedSources.set('core', 'h-core-EDITED')
    const after = compositeHashFromTypes('app', graph, changedSources, computeTypesHashes(graph))

    expect(after).toBe(before)
  })

  it('changes when a transitive dependency emits different types', () => {
    const graph = makeGraph()
    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    fs.writeFileSync(join(root, 'core', 'types', 'index.d.ts'), 'export declare const core: string\n')
    const after = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))

    expect(after).not.toBe(before)
  })

  it('changes when the package own sources change', () => {
    const graph = makeGraph()
    const types = computeTypesHashes(graph)
    const before = compositeHashFromTypes('app', graph, OWN, types)

    const own = new Map(OWN)
    own.set('app', 'h-app-EDITED')
    expect(compositeHashFromTypes('app', graph, own, types)).not.toBe(before)
  })

  it('changes when a listed config file changes', () => {
    const graph = makeGraph()
    const types = computeTypesHashes(graph)
    const cfg = ['.eslintrc.js']
    const before = compositeHashFromTypes('app', graph, OWN, types, cfg)

    fs.writeFileSync(join(root, 'app', '.eslintrc.js'), 'module.exports = { rules: {} }\n')
    expect(compositeHashFromTypes('app', graph, OWN, types, cfg)).not.toBe(before)
  })

  it('is independent of an unrelated package', () => {
    const graph = makeGraph()
    graph.set('other', {
      project: { name: 'other', fullPath: join(root, 'other') },
      dependencies: new Set(),
      dependents: new Set()
    } as unknown as PackageNode)
    fs.mkdirSync(join(root, 'other', 'types'), { recursive: true })
    fs.writeFileSync(join(root, 'other', 'types', 'index.d.ts'), 'export declare const other: 1\n')

    const before = compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))
    fs.writeFileSync(join(root, 'other', 'types', 'index.d.ts'), 'export declare const other: 2\n')
    expect(compositeHashFromTypes('app', graph, OWN, computeTypesHashes(graph))).toBe(before)
  })

  it('computeTypesHashes reports an empty hash for a package without types/', () => {
    const graph = makeGraph()
    graph.set('notypes', {
      project: { name: 'notypes', fullPath: join(root, 'notypes') },
      dependencies: new Set(),
      dependents: new Set()
    } as unknown as PackageNode)
    fs.mkdirSync(join(root, 'notypes'), { recursive: true })

    expect(computeTypesHashes(graph).get('notypes')).toBe('')
  })
})
