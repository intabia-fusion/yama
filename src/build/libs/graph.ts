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

import { join } from 'path'
import { promises as fsPromises } from 'fs'

import { listWorkspaceProjects } from './workspace.js'
import type {
  DependencyGraph,
  DependencyGraphResult,
  PackageInfo,
  PackageJsonFields,
  PackageNode,
  WorkspaceProject
} from '../types.js'

export { listWorkspaceProjects }

/**
 * Read package.json and extract dependencies and phase scripts
 */
async function getPackageInfoAsync (packageJsonPath: string): Promise<PackageInfo> {
  try {
    const content = await fsPromises.readFile(packageJsonPath, 'utf-8')
    const packageJson = JSON.parse(content) as PackageJsonFields
    return parsePackageJson(packageJson)
  } catch {
    return {
      dependencies: [],
      phaseBuild: null,
      phaseTest: null,
      phaseBundle: null,
      phasePackage: null,
      phaseDockerBuild: null,
      phaseFormat: null,
      phaseSvelteCheck: null,
      bundleScript: null,
      packageScript: null,
      dockerBuildScript: null
    }
  }
}

function parsePackageJson (packageJson: PackageJsonFields): PackageInfo {
  const scripts = packageJson.scripts
  const phaseBuild = scripts?.['_phase:build'] ?? null
  const phaseTest = scripts?.['_phase:test'] ?? null
  const phaseBundle = scripts?.['_phase:bundle'] ?? null
  const phasePackage = scripts?.['_phase:package'] ?? null
  const phaseDockerBuild = scripts?.['_phase:docker-build'] ?? null
  const phaseFormat = scripts?.['_phase:format'] ?? null
  const phaseSvelteCheck = scripts?.['_phase:svelte-check'] ?? null
  const bundleScript = scripts?.bundle ?? null
  const packageScript = scripts?.package ?? null
  const dockerBuildScript = scripts?.['docker:build'] ?? null

  const allDeps: Record<string, string> = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.peerDependencies
  }

  const dependencies = Object.keys(allDeps).filter((dep) => {
    const version = allDeps[dep]
    // workspace: dependencies are local packages
    return version && (version.startsWith('workspace:') || version.startsWith('link:'))
  })

  return {
    dependencies,
    phaseBuild,
    phaseTest,
    phaseBundle,
    phasePackage,
    phaseDockerBuild,
    phaseFormat,
    phaseSvelteCheck,
    bundleScript,
    packageScript,
    dockerBuildScript
  }
}

/**
 * Build dependency graph for all projects
 */
export async function buildDependencyGraph (rootDir: string, verbose?: boolean): Promise<DependencyGraphResult> {
  const projects = listWorkspaceProjects(rootDir)
  if (verbose === true) console.log(`workspace: ${projects.length} projects`)
  const graph: DependencyGraph = new Map()
  const projectByName = new Map<string, WorkspaceProject>()

  // First pass: read all package.json files in parallel
  const packageInfos = await Promise.all(
    projects.map(async (project) => {
      const info = await getPackageInfoAsync(join(project.fullPath, 'package.json'))
      return { project, info }
    })
  )

  // Second pass: initialize all nodes
  for (const { project, info } of packageInfos) {
    projectByName.set(project.name, project)
    const { dependencies, ...scripts } = info

    graph.set(project.name, {
      project,
      dependencies: new Set(dependencies),
      dependents: new Set(),
      ...scripts
    })
  }

  // Third pass: keep only dependencies that are workspace projects and fill dependents
  for (const [name, node] of graph) {
    const validDeps = new Set<string>()
    for (const dep of node.dependencies) {
      const depNode = graph.get(dep)
      if (depNode !== undefined) {
        validDeps.add(dep)
        depNode.dependents.add(name)
      }
    }
    node.dependencies = validDeps
  }

  return { graph, projects, projectByName }
}

/**
 * Get all dependencies of a package (transitive closure)
 */
export function getAllDependencies (
  graph: DependencyGraph,
  packageName: string,
  result: Set<string> = new Set()
): Set<string> {
  const node = graph.get(packageName)
  if (node === undefined) return result

  for (const dep of node.dependencies) {
    if (!result.has(dep)) {
      result.add(dep)
      getAllDependencies(graph, dep, result)
    }
  }

  return result
}

/**
 * Topological sort using Kahn's algorithm
 * Returns array of "waves" - each wave contains packages that can be built in parallel
 */
export function topologicalSortWaves (
  graph: DependencyGraph,
  filterFn: (node: PackageNode, name: string) => boolean
): WorkspaceProject[][] {
  const filteredNames = new Set<string>()
  for (const [name, node] of graph) {
    if (filterFn(node, name)) {
      filteredNames.add(name)
    }
  }

  // In-degree counts only dependencies that are themselves filtered in
  const inDegree = new Map<string, number>()
  for (const name of filteredNames) {
    let count = 0
    for (const dep of graph.get(name)?.dependencies ?? []) {
      if (filteredNames.has(dep)) {
        count++
      }
    }
    inDegree.set(name, count)
  }

  const waves: WorkspaceProject[][] = []
  const processed = new Set<string>()

  while (processed.size < filteredNames.size) {
    const wave: WorkspaceProject[] = []
    for (const name of filteredNames) {
      if (!processed.has(name) && inDegree.get(name) === 0) {
        const node = graph.get(name)
        if (node !== undefined) wave.push({ ...node.project })
      }
    }

    if (wave.length === 0) {
      const remaining = [...filteredNames].filter((n) => !processed.has(n))
      throw new Error(`Circular dependency detected among: ${remaining.join(', ')}`)
    }

    waves.push(wave)

    for (const project of wave) {
      processed.add(project.name)
      const node = graph.get(project.name)
      for (const dependent of node?.dependents ?? []) {
        const degree = inDegree.get(dependent)
        if (filteredNames.has(dependent) && degree !== undefined) {
          inDegree.set(dependent, degree - 1)
        }
      }
    }
  }

  return waves
}
