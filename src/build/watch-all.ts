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

import { resolve, join, relative } from 'path'
import { existsSync, watch, readdirSync } from 'fs'
import type { FSWatcher } from 'fs'
import { cpus } from 'os'
import { performance } from 'perf_hooks'

import { buildDependencyGraph, getAllDependencies } from './libs/graph.js'
import { getDefaultWorkerCount, getOptimalWorkerCount } from './libs/utils.js'
import { runBuildPhase } from './phases/build.js'
import { runLintPhase } from './phases/lint.js'
import { BUILD_SCRIPTS } from './libs/phase-select.js'
import { calculatePackageHash } from './libs/cache.js'
import { success, error, warn, info, dim, bold, colorizeErrorMessage } from './libs/colors.js'
import type { DependencyGraph, WatchAllOptions } from './types.js'

// Strips the npm scope for display, e.g. "@scope/core" -> "core".
const displayName = (name: string): string => name.replace(/^@[^/]+\//, '')

const errorText = (e: Error | string | undefined): string => (typeof e === 'string' ? e : e?.message ?? '')

export function parseArgs (args: string[]): WatchAllOptions {
  let parallel = getDefaultWorkerCount()
  let verbose = false
  let doValidate = false
  let doLint = false
  let force = false
  let toPackage: string | null = null
  let rootDir = ''
  let debounceMs = 300

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--parallel' || arg === '-p') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        parallel = parseInt(next, 10)
        if (isNaN(parallel) || parallel < 1) parallel = 1
        i++
      } else {
        parallel = cpus().length
      }
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--validate') {
      doValidate = true
    } else if (arg === '--lint') {
      doLint = true
      doValidate = true // --lint implies --validate
    } else if (arg === '--force' || arg === '-f') {
      force = true
    } else if (arg === '--to') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        toPackage = next
        i++
      }
    } else if (arg === '--debounce') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        debounceMs = parseInt(next, 10)
        if (isNaN(debounceMs) || debounceMs < 50) debounceMs = 50
        i++
      }
    } else if (arg === '--help' || arg === '-h') {
      printUsage()
      process.exit(0)
    } else if (!arg.startsWith('-')) {
      rootDir = arg
    }
  }

  if (toPackage === null || toPackage === '') {
    const envTo = process.env.TO
    toPackage = envTo !== undefined && envTo !== '' ? envTo : null
  }
  if (!verbose) {
    verbose = process.env.VERBOSE === '1'
  }

  return { parallel, verbose, doValidate, doLint, force, toPackage, rootDir, debounceMs }
}

export function printUsage (): void {
  console.log(`
Usage: watch_all <rootDir> [options]

Arguments:
  rootDir                Root directory of the monorepo

Options:
  --parallel, -p <n>     Number of parallel workers (default: auto)
  --verbose, -v          Show detailed output
  --validate             Also run TypeScript validation after transpile
  --lint                 Run ESLint check (no fix) after validation (implies --validate)
  --force, -f            Disable all caching (forces full rebuild)
  --to <package>         Only watch the specified package and its dependencies
  --debounce <ms>        Debounce interval in ms (default: 300)
  --help, -h             Show this help message

Description:
  Watches all workspace packages for file changes and triggers incremental
  rebuilds using esbuild. Only changed packages and their dependents
  are rebuilt.

Examples:
  watch_all .
  watch_all . --validate
  watch_all . --lint
  watch_all . --to <package> --verbose
`)
}

function isSourceFile (filename: string): boolean {
  return filename.endsWith('.ts') || filename.endsWith('.js') ||
    filename.endsWith('.svelte') || filename.endsWith('.json')
}

/**
 * Recursively watch a directory for changes
 * Returns an array of watchers that can be closed
 */
function watchDirectory (dir: string, callback: (eventType: string, filePath: string) => void): FSWatcher[] {
  const watchers: FSWatcher[] = []
  if (!existsSync(dir)) return watchers

  try {
    // Watch the directory itself (recursive on macOS, manual on Linux)
    const watcher = watch(dir, { recursive: true }, (eventType, filename) => {
      if (filename !== null && filename !== '' && isSourceFile(filename)) {
        callback(eventType, join(dir, filename))
      }
    })
    watchers.push(watcher)
  } catch {
    // Fallback: watch subdirectories individually (Linux without recursive support)
    try {
      const watcher = watch(dir, (eventType, filename) => {
        if (filename !== null && filename !== '' && isSourceFile(filename)) {
          callback(eventType, join(dir, filename))
        }
      })
      watchers.push(watcher)
    } catch {
      // Ignore watch errors for inaccessible directories
    }

    try {
      const entries = readdirSync(dir, { withFileTypes: true })
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules') {
          watchers.push(...watchDirectory(join(dir, entry.name), callback))
        }
      }
    } catch {
      // Ignore
    }
  }

  return watchers
}

/**
 * Build a reverse dependency map: package -> all packages that depend on it (transitively)
 */
function buildReverseDependencyMap (graph: DependencyGraph, packageNames: string[]): Map<string, Set<string>> {
  const reverseMap = new Map<string, Set<string>>()

  for (const name of packageNames) {
    reverseMap.set(name, new Set())
  }

  for (const name of packageNames) {
    const node = graph.get(name)
    if (node === undefined) continue
    for (const dep of node.dependencies) {
      reverseMap.get(dep)?.add(name)
    }
  }

  // Compute transitive dependents
  const transitiveDependents = new Map<string, Set<string>>()
  for (const name of packageNames) {
    const result = new Set<string>()
    const queue = [name]
    while (queue.length > 0) {
      const current = queue.shift() as string
      const directDependents = reverseMap.get(current)
      if (directDependents !== undefined) {
        for (const dep of directDependents) {
          if (!result.has(dep)) {
            result.add(dep)
            queue.push(dep)
          }
        }
      }
    }
    transitiveDependents.set(name, result)
  }

  return transitiveDependents
}

export async function main (args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)

  if (options.rootDir === '') {
    console.error('Error: rootDir argument is required')
    printUsage()
    process.exit(1)
  }

  const rootDir = resolve(options.rootDir)

  if (!existsSync(join(rootDir, 'pnpm-workspace.yaml'))) {
    console.error(`Error: pnpm-workspace.yaml not found in ${rootDir}`)
    process.exit(1)
  }

  const validationWorkers = getOptimalWorkerCount(options.parallel, 'typescript').workers

  console.log('Building dependency graph...')
  const { graph } = await buildDependencyGraph(rootDir, options.verbose)

  // Collect packages to watch
  const packagesToWatch: string[] = []

  // Pre-compute --to filter once
  const toPackage = options.toPackage
  const targetDeps = toPackage !== null ? getAllDependencies(graph, toPackage) : null
  const passesToFilter = (name: string): boolean =>
    toPackage === null || name === toPackage || (targetDeps !== null && targetDeps.has(name))

  for (const [name, node] of graph) {
    if (!passesToFilter(name)) continue

    if (BUILD_SCRIPTS.has(node.phaseBuild)) {
      packagesToWatch.push(name)
    }
  }

  // Build reverse dependency map
  const reverseDeps = buildReverseDependencyMap(graph, packagesToWatch)

  console.log(`\nWatching ${info(packagesToWatch.length + ' packages')} for changes...`)

  // Initial full build
  console.log(`\n${bold('=== Initial build ===')}`)

  // Calculate package hashes for ALL packages in graph (not just packagesToWatch)
  const packageHashes = new Map<string, string>()
  for (const [name, node] of graph) {
    if (node.project?.fullPath !== undefined) {
      packageHashes.set(name, calculatePackageHash(node.project.fullPath))
    }
  }

  const initialStart = performance.now()
  const buildResult = await runBuildPhase(graph, packagesToWatch, validationWorkers, { force: options.force, packageHashes })
  console.log(`Initial build: ${buildResult.successCount}/${buildResult.total} in ${Math.round(performance.now() - initialStart)}ms`)

  if (buildResult.errors.length > 0) {
    console.error('Initial build errors:')
    for (const err of buildResult.errors) {
      const { colored } = colorizeErrorMessage(errorText(err.error))
      console.error(`  ${err.package}: ${colored}`)
    }
  }

  // Run initial lint after a clean build (only when --lint flag is passed)
  if (options.doLint && buildResult.errors.length === 0) {
    const packagesToLint = packagesToWatch.filter((name) => graph.get(name)?.phaseFormat)
    if (packagesToLint.length > 0) {
      console.log(`\n${bold('=== Initial lint (' + packagesToLint.length + ' packages) ===')}`)
      const lintResult = await runLintPhase(graph, packagesToLint, validationWorkers, { force: options.force, packageHashes })
      console.log(`Linted: ${lintResult.successCount}/${lintResult.total} in ${Math.round(lintResult.time)}ms${lintResult.cacheHits > 0 ? ` (${lintResult.cacheHits} from cache)` : ''}`)
      if (lintResult.errors.length > 0) {
        console.error(`  ${error(lintResult.errors.length + ' lint error(s)')}`)
      }
    }
  }

  console.log(`\n${bold('=== Watching for changes (Ctrl+C to stop) ===')}\n`)

  // Debounced rebuild
  const pendingChanges = new Set<string>()
  let rebuildTimer: ReturnType<typeof setTimeout> | null = null
  let isRebuilding = false

  function scheduleRebuild (): void {
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
    }

    rebuildTimer = setTimeout(async () => {
      if (isRebuilding) {
        // Re-schedule if currently building
        scheduleRebuild()
        return
      }

      isRebuilding = true
      const changedPackages = new Set(pendingChanges)
      pendingChanges.clear()

      // Expand to include all dependents
      const packagesToRebuild = new Set(changedPackages)
      for (const pkg of changedPackages) {
        const dependents = reverseDeps.get(pkg)
        if (dependents !== undefined) {
          for (const dep of dependents) {
            packagesToRebuild.add(dep)
          }
        }
      }

      // Sort by dependency order (packages in packagesToWatch order)
      const orderedPackages = packagesToWatch.filter((p) => packagesToRebuild.has(p))

      if (orderedPackages.length === 0) {
        isRebuilding = false
        return
      }

      const changeList = [...changedPackages].map(displayName).join(', ')
      console.log(`\n--- Change detected in: ${info(changeList)} ---`)
      console.log(`Rebuilding ${orderedPackages.length} package(s)...`)

      const rebuildStart = performance.now()
      try {
        // Refresh the hashes of the packages whose files actually changed, then hand the
        // map to transpile. Without it every dependent skipped its cache check and was
        // rebuilt on every keystroke, and the transpile cache was never written at all.
        for (const pkg of changedPackages) {
          const node = graph.get(pkg)
          if (node?.project?.fullPath !== undefined) {
            packageHashes.set(pkg, calculatePackageHash(node.project.fullPath))
          }
        }

        const result = await runBuildPhase(graph, orderedPackages, validationWorkers, { packageHashes })
        const elapsed = Math.round(performance.now() - rebuildStart)

        // Outputs changed, so their own hashes need refreshing for later rebuilds.
        for (const pkg of result.changedPackages ?? []) {
          const node = graph.get(pkg)
          if (node?.project?.fullPath !== undefined) {
            packageHashes.set(pkg, calculatePackageHash(node.project.fullPath))
          }
        }

        if (result.errors.length > 0) {
          for (const err of result.errors) {
            const { colored } = colorizeErrorMessage(errorText(err.error))
            console.error(`  ${error('ERROR')}: ${err.package}: ${colored}`)
          }
          console.log(`Rebuild completed with ${error('errors')} in ${elapsed}ms`)
        } else {
          console.log(`Rebuilt ${success(result.successCount - result.cacheHits + ' package(s)')} in ${elapsed}ms`)

          if (options.doLint) {
            const pkgsToLint = orderedPackages.filter((name) => graph.get(name)?.phaseFormat)
            if (pkgsToLint.length > 0) {
              const lintList = pkgsToLint.map(displayName).join(', ')
              console.log(`Linting ${info(pkgsToLint.length + ' package(s)')}: ${info(lintList)}`)
              try {
                const lintResult = await runLintPhase(graph, pkgsToLint, validationWorkers, { force: options.force, packageHashes })
                if (lintResult.errors.length === 0) {
                  console.log(success('  All lints passed'))
                } else {
                  console.error(error(`  ${lintResult.errors.length} lint error(s)`))
                }
              } catch (err) {
                console.error(error(`  Lint failed: ${err instanceof Error ? err.message : String(err)}`))
              }
            }
          }
        }
      } catch (err) {
        console.error(`Rebuild failed: ${err instanceof Error ? err.message : String(err)}`)
      }

      isRebuilding = false

      // Check if more changes accumulated during rebuild
      if (pendingChanges.size > 0) {
        scheduleRebuild()
      }
    }, options.debounceMs)
  }

  // Set up watchers for all packages
  const allWatchers: FSWatcher[] = []

  for (const packageName of packagesToWatch) {
    const node = graph.get(packageName)
    if (node === undefined) continue
    // Test-only packages keep sources in tests/ instead of src/.
    const srcPath = existsSync(join(node.project.fullPath, 'src'))
      ? join(node.project.fullPath, 'src')
      : join(node.project.fullPath, 'tests')

    if (!existsSync(srcPath)) continue

    const watchers = watchDirectory(srcPath, (eventType, filePath) => {
      if (options.verbose) {
        const relPath = relative(rootDir, filePath)
        const eventTypeColor = eventType === 'change' ? warn(eventType) : eventType === 'rename' ? info(eventType) : dim(eventType)
        console.log(`  [${eventTypeColor}] ${relPath}`)
      }

      pendingChanges.add(packageName)
      scheduleRebuild()
    })

    allWatchers.push(...watchers)
  }

  // Handle graceful shutdown
  let isShuttingDown = false

  function cleanup (): void {
    if (isShuttingDown) return
    isShuttingDown = true

    // Close all watchers immediately
    for (const watcher of allWatchers) {
      try {
        watcher.close()
      } catch {
        // Ignore
      }
    }
    // Clear rebuild timer immediately
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
  }

  process.on('SIGINT', () => {
    // Close all watchers synchronously
    for (const watcher of allWatchers) {
      try {
        watcher.close()
      } catch {
        // Ignore
      }
    }
    // Clear rebuild timer
    if (rebuildTimer !== null) {
      clearTimeout(rebuildTimer)
      rebuildTimer = null
    }
    // Exit immediately - shell will show prompt
    process.exit(0)
  })

  process.on('SIGTERM', () => {
    cleanup()
    process.exit(0)
  })
}
