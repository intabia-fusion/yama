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

import { readFileSync, existsSync, statSync, globSync } from 'fs'
import { join, dirname } from 'path'
import type { WorkspaceProjectsCache, WorkspaceProject } from '../types.js'

let cache: WorkspaceProjectsCache | null = null

export function findWorkspaceRoot (startPath: string = process.cwd()): string | null {
  let current = startPath
  while (true) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return null
    current = parent
  }
}

/**
 * Projects declared in pnpm-workspace.yaml. Entries may be plain paths or globs.
 */
export function listWorkspaceProjects (rootDir: string | null = findWorkspaceRoot()): WorkspaceProject[] {
  if (rootDir == null) throw new Error('pnpm-workspace.yaml not found')
  const wsPath = join(rootDir, 'pnpm-workspace.yaml')
  const key = `${rootDir}:${statSync(wsPath).mtimeMs}`
  if (cache !== null && cache.key === key) return cache.projects

  const patterns: string[] = []
  let inPackages = false
  for (const raw of readFileSync(wsPath, 'utf-8').split('\n')) {
    if (/^packages:\s*$/.test(raw)) {
      inPackages = true
      continue
    }
    if (!inPackages) continue
    const m = raw.match(/^\s*-\s*['"]?(.+?)['"]?\s*$/)
    if (m !== null) {
      patterns.push(m[1])
      continue
    }
    if (raw.trim() !== '' && !raw.trimStart().startsWith('#')) inPackages = false
  }

  const folders = new Set<string>()
  for (const pattern of patterns) {
    if (/[*?[]/.test(pattern)) {
      for (const f of globSync(pattern, { cwd: rootDir })) folders.add(f)
    } else {
      folders.add(pattern)
    }
  }

  const projects: WorkspaceProject[] = []
  for (const folder of [...folders].sort()) {
    const pkgJsonPath = join(rootDir, folder, 'package.json')
    if (!existsSync(pkgJsonPath)) continue
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { name: string, private?: boolean }
    projects.push({ name: pkg.name, path: folder, fullPath: join(rootDir, folder), private: pkg.private === true })
  }

  cache = { key, projects }
  return projects
}
