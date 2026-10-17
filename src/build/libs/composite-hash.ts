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

import crypto from 'crypto'
import fs from 'fs'
import { join } from 'path'
import { xxh64 } from '@node-rs/xxhash'

import { calculateOutputHashForDirs } from './cache.js'
import type { DependencyGraph } from '../types.js'

/**
 * Hash the emitted types/ of every package, once per run.
 * Maps package name to its types hash ('' when it emits none).
 */
export function computeTypesHashes (graph: DependencyGraph): Map<string, string> {
  const hashes = new Map<string, string>()
  for (const [name, node] of graph) {
    const path = node.project?.fullPath
    if (!path) continue
    hashes.set(name, calculateOutputHashForDirs(path, ['types']) ?? '')
  }
  return hashes
}

function collectDeps (name: string, graph: DependencyGraph, seen: Set<string>): void {
  const node = graph.get(name)
  if (node === undefined) return
  for (const dep of node.dependencies) {
    if (seen.has(dep)) continue
    seen.add(dep)
    collectDeps(dep, graph, seen)
  }
}

function hashFileIfPresent (absPath: string): string | null {
  try {
    if (!fs.statSync(absPath).isFile()) return null
    return xxh64(fs.readFileSync(absPath)).toString(16)
  } catch {
    return null
  }
}

/**
 * Composite hash for phases that only read a dependency's public API (lint, svelte-check).
 *
 * Keying on a dependency's *sources* meant any edit anywhere upstream re-ran the phase for
 * the whole downstream closure. These phases see dependencies through their emitted .d.ts,
 * so the dependency's types hash is the input that actually matters.
 *
 * `packageHashes` holds the own-source hash per package; `extraConfigFiles` are
 * package-relative config files that change the result.
 */
export function compositeHashFromTypes (
  name: string,
  graph: DependencyGraph,
  packageHashes: Map<string, string>,
  typesHashes: Map<string, string>,
  extraConfigFiles: string[] = []
): string {
  const parts = [`self:${packageHashes.get(name) ?? ''}`]

  const deps = new Set<string>()
  collectDeps(name, graph, deps)
  for (const dep of [...deps].sort()) {
    parts.push(`${dep}:types:${typesHashes.get(dep) ?? ''}`)
  }

  const packagePath = graph.get(name)?.project?.fullPath
  if (packagePath) {
    for (const rel of extraConfigFiles) {
      const h = hashFileIfPresent(join(packagePath, rel))
      if (h) parts.push(`cfg:${rel}:${h}`)
    }
  }

  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}
