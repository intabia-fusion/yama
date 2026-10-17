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

import { resolve, join } from 'path'
import { existsSync } from 'fs'
import { cpus } from 'os'
import { createHash } from 'crypto'
import { spawnSync } from 'child_process'
import { performance } from 'perf_hooks'

import { BuildTaskQueue, TaskType } from './libs/task-queue.js'
import { CpuTracker, getOptimalWorkerCount, getDefaultWorkerCount, getPeakMemoryMB } from './libs/utils.js'
import { calculatePackageHash } from './libs/cache.js'
import { success, error, warn, dim, bold, colorizeErrorMessage } from './libs/colors.js'
import { buildDependencyGraph } from './libs/graph.js'
import { terminateWorkerPool } from './libs/workers.js'

import { runBuildPhase } from './phases/build.js'
import { runBundlePhase } from './phases/bundle.js'
import { runPackagePhase } from './phases/package.js'
import { runDockerBuildPhase, preloadDockerImages, getDockerImageName } from './phases/docker-build.js'
import { runFormatPhase } from './phases/format.js'
import { runLintPhase } from './phases/lint.js'
import { runTestPhase } from './phases/test.js'
import { runSvelteCheckPhase } from './phases/svelte-check.js'
import { selectPackagesForPhases } from './libs/phase-select.js'
import { computeTypesHashes } from './libs/composite-hash.js'
import type {
  CommandError,
  CompileAllCliOptions,
  CompileAllError,
  CompileAllOptions,
  CompileAllResult,
  DependencyGraph,
  DockerImageInfo,
  GraphPhaseResults,
  PeakMemory,
  PhaseRunResults,
  PhaseStat,
  PipelineBucket,
  PipelineResults,
  WorkerCountInfo
} from './types.js'

export { runBuildPhase }

export function parseArgs (args: string[]): CompileAllCliOptions {
  let parallel = getDefaultWorkerCount()
  let verbose = false
  let doTest = false
  let doLint = false
  let doFormat = false
  let force = false
  let doBundle = false
  let doPackage = false
  let doDockerBuild = false
  let doSvelteCheck = false
  let noTypeCheck = false
  let esbuildEmit = false
  let help = false
  let list = false
  let toPackage: string | null = null
  let rootDir = ''
  let forceWorkers = false
  let groupTests = true
  let lintFix = false

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--force-workers') {
      forceWorkers = true
    } else if (arg === '--no-test-group') {
      groupTests = false
    } else if (arg === '--fix') {
      lintFix = true
    } else if (arg === '--parallel' || arg === '-p') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        parallel = parseInt(next, 10)
        if (isNaN(parallel) || parallel < 1) {
          parallel = 1
        }
        i++
      } else {
        // Default to CPU count if no number specified
        parallel = cpus().length
      }
    } else if (arg === '--verbose' || arg === '-v') {
      verbose = true
    } else if (arg === '--validate') {
      // Accepted for compatibility: validation is part of the build phase now.
    } else if (arg === '--test') {
      doTest = true
    } else if (arg === '--lint') {
      doLint = true
    } else if (arg === '--format') {
      doFormat = true
    } else if (arg === '--force' || arg === '-f') {
      force = true
    } else if (arg === '--bundle') {
      doBundle = true
    } else if (arg === '--package') {
      doPackage = true
      doBundle = true // package implies bundle
    } else if (arg === '--docker-build') {
      doDockerBuild = true
      doPackage = true // docker-build implies package
      doBundle = true // docker-build implies bundle
    } else if (arg === '--svelte-check') {
      doSvelteCheck = true
    } else if (arg === '--no-type-check') {
      noTypeCheck = true
    } else if (arg === '--esbuild-emit') {
      esbuildEmit = true
    } else if (arg === '--list' || arg === '-l') {
      list = true
    } else if (arg === '--to') {
      const next = args[i + 1]
      if (next !== undefined && !next.startsWith('-')) {
        if (toPackage !== null) {
          toPackage += ',' + next
        } else {
          toPackage = next
        }
        i++
      }
    } else if (arg === '--help' || arg === '-h') {
      help = true
    } else if (!arg.startsWith('-')) {
      // Positional argument - rootDir
      rootDir = arg
    }
  }

  if (toPackage === null || toPackage === '') {
    const envTo = process.env.TO
    toPackage = envTo !== undefined && envTo !== '' ? envTo : null
  }
  if (!list) {
    list = process.env.LIST === '1'
  }
  if (!verbose) {
    verbose = process.env.VERBOSE === '1'
  }

  return {
    parallel,
    verbose,
    doTest,
    doLint,
    doFormat,
    force,
    doBundle,
    doPackage,
    doDockerBuild,
    doSvelteCheck,
    noTypeCheck,
    esbuildEmit,
    help,
    list,
    toPackage,
    rootDir,
    forceWorkers,
    groupTests,
    lintFix
  }
}

export function printUsage (): void {
  console.log(`
Usage: compile-all <rootDir> [options]

Arguments:
  rootDir              Root directory of the monorepo (where pnpm-workspace.yaml is located)

Options:
  --parallel, -p <n>   Run compilation in parallel with n workers (default: 4, or 8 on systems with >64GB RAM)
                       If no number specified, uses CPU count (limited by available memory)
                       Parallel compilation respects dependency order (builds in waves)
  --force-workers      Force exact worker count, ignore memory limits (use with caution!)
  --no-test-group      Run every package's tests in its own jest process
  --fix                Apply eslint's automatic fixes while linting
  --verbose, -v        Show detailed output for each package
  --validate           Accepted for compatibility: type checking is part of the build
  --test               Run tests for packages with "_phase:test"
  --lint               Run ESLint check (no fix) after the build; for packages with "_phase:format"
  --format             Build, then run the format phase for packages with "_phase:format"
  --force, -f          Disable all caching (forces full rebuild, revalidation)
  --bundle             Run bundle phase for packages with "_phase:bundle"
  --docker-build       Run docker-build phase (implies --bundle)
  --svelte-check       Run svelte-check for packages with "_phase:svelte-check"
  --list, -l           Only print the list of packages in compilation order (no actual compilation)
  --no-type-check      Emit without checking types (tsc --noCheck); outputs are identical,
                       type errors are left to the build/lint jobs
  --esbuild-emit       Emit JS with esbuild and leave tsc declarations only (the pre-tsc7 split)
  --to <package>       Only compile the specified package and its dependencies
  --help, -h           Show this help message

Description:
  This script compiles all workspace packages that have a "_phase:build" script
  in their package.json scripts section. Packages are compiled in dependency order.

  When --lint is specified, also runs ESLint check (no fix) for
  packages that have "_phase:format" defined.

  When --format is specified, builds the selected packages first (cached), then runs the
  format phase for packages with "_phase:format".

  When --bundle is specified, runs the bundle phase for packages with "_phase:bundle".

  When --docker-build is specified, runs bundle first, then docker-build for packages
  with "_phase:docker-build".

  When --svelte-check is specified, runs svelte-check for packages
  with "_phase:svelte-check" defined.

  When --to is specified, only the specified package and all its dependencies will be compiled.

  When --list is specified, prints the compilation order without actually compiling.

  The script automatically detects available memory and limits workers to prevent OOM.

Examples:
  compile-all .
  compile-all . --parallel 4 --verbose
  compile-all /path/to/repo -p -v --validate
  compile-all . --validate --force
  compile-all . --bundle --to <package>
  compile-all . --docker-build --to <package>
  compile-all . --list
  compile-all . --to <package>
  compile-all . --format
  compile-all . --format --to <package>
  compile-all . --lint
  compile-all . --lint --to <package>
`)
}

// Transitive hash: dependency change invalidates dependents.
export function calculatePackageHashWithDeps (
  packageName: string,
  graph: DependencyGraph,
  packageHashes: Map<string, string>,
  processed: Set<string> = new Set(),
  depTypesHashes: Map<string, string> | null = null
): string {
  if (processed.has(packageName)) {
    return ''
  }
  processed.add(packageName)

  const node = graph.get(packageName)
  if (node === undefined) {
    return ''
  }

  // Get base hash of this package
  const baseHash = packageHashes.get(packageName) ?? ''
  const parts = [baseHash]

  for (const depName of node.dependencies) {
    const depHash = calculatePackageHashWithDeps(depName, graph, packageHashes, processed, depTypesHashes)
    if (depHash !== '') {
      parts.push(`${depName}:${depHash}`)
    }
    // Fold in dep's emitted .d.ts hash: API change without src change still invalidates dependents.
    if (depTypesHashes !== null) {
      const t = depTypesHashes.get(depName)
      if (t !== undefined && t !== '') {
        parts.push(`${depName}:types:${t}`)
      }
    }
  }

  parts.sort()

  return createHash('md5').update(parts.join('\n')).digest('hex')
}

// Errors reach here as Error, CommandError or a plain string depending on the phase.
function asCommandError (e: unknown): CommandError | undefined {
  return typeof e === 'object' && e !== null ? (e as CommandError) : undefined
}

function lastErrorLine (e: unknown): string {
  const ce = asCommandError(e)
  const msg = ce?.message
  if (msg !== undefined && msg !== '') return msg
  return ce?.stderr?.trim().split('\n').slice(-1)[0] ?? 'Unknown error'
}

function logPhaseFailure (letter: string, done: number, total: number, packageName: string, time: string, errors: PhaseRunResults['errors']): void {
  console.error(`    ${error(letter)} ${dim(String(done))}/${total} ${packageName} ${error('FAILED')} ${dim(time)}`)
  for (const err of errors) {
    const errMsg = lastErrorLine(err.error)
    const { colored } = colorizeErrorMessage(errMsg)
    console.error(`      ${colored}`)
  }
}

async function runBuildPipeline (
  packagesToBundle: string[],
  packagesToPackage: string[],
  packagesToDockerBuild: string[],
  graph: DependencyGraph,
  buildWorkers: number,
  force: boolean,
  packageHashes: Map<string, string>
): Promise<PipelineResults> {
  const taskQueue = new BuildTaskQueue(graph, { concurrency: buildWorkers })

  // Preload docker image metadata in a single `docker inspect` call
  // instead of spawning 2 docker processes per package later.
  let dockerImageCache: Map<string, DockerImageInfo> | undefined
  if (packagesToDockerBuild.length > 0 && !force) {
    const imageNames: string[] = []
    for (const pkg of packagesToDockerBuild) {
      const node = graph.get(pkg)
      if (node === undefined) continue
      const name = getDockerImageName(node.project.fullPath)
      if (name !== null && name !== '') imageNames.push(name)
    }
    if (imageNames.length > 0) {
      const preloadStart = performance.now()
      dockerImageCache = await preloadDockerImages(imageNames)
      const preloadTime = Math.round(performance.now() - preloadStart)
      console.log(`    [docker-build] preloaded ${imageNames.length} image states in ${preloadTime}ms`)
    }
  }

  if (packagesToBundle.length > 0) {
    taskQueue.addTasks(TaskType.BUNDLE, packagesToBundle)
  }
  if (packagesToPackage.length > 0) {
    taskQueue.addTasks(TaskType.PACKAGE, packagesToPackage)
  }
  if (packagesToDockerBuild.length > 0) {
    taskQueue.addTasks(TaskType.DOCKER_BUILD, packagesToDockerBuild)
  }

  const phases: string[] = []
  if (packagesToBundle.length > 0) phases.push(`bundle(${packagesToBundle.length})`)
  if (packagesToPackage.length > 0) phases.push(`package(${packagesToPackage.length})`)
  if (packagesToDockerBuild.length > 0) phases.push(`docker-build(${packagesToDockerBuild.length})`)
  console.log(`\n=== Phase: Running pipeline [${phases.join(' -> ')}] ===`)

  const results: PipelineResults = {
    bundle: { successCount: 0, total: packagesToBundle.length, cacheHits: 0, errors: [] },
    package: { successCount: 0, total: packagesToPackage.length, cacheHits: 0, errors: [] },
    dockerBuild: { successCount: 0, total: packagesToDockerBuild.length, cacheHits: 0, errors: [] }
  }

  const completedCount = { bundle: 0, package: 0, dockerBuild: 0 }

  async function worker (): Promise<void> {
    while (true) {
      const task = taskQueue.getNextTask()

      if (task === null) {
        if (taskQueue.isAllComplete()) {
          break
        }
        await new Promise((resolve) => setTimeout(resolve, 10))
        continue
      }

      const { taskType, packageName } = task
      const pkgStart = performance.now()
      // Always include dependency hashes to ensure rebuilds when any dependency changes
      const packageHash = calculatePackageHashWithDeps(packageName, graph, packageHashes)

      try {
        let result: PhaseRunResults

        switch (taskType) {
          case TaskType.BUNDLE: {
            result = await runBundlePhase(graph, [packageName], 1, { force, packageHash })
            completedCount.bundle++
            if (result.successCount > 0) {
              results.bundle.successCount++
              if (result.cacheHits > 0) results.bundle.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('B')} ${dim(String(completedCount.bundle))}/${packagesToBundle.length} ${packageName} ${success('bundled')}${cacheInfo} ${dim(time + 'ms')}`)
            } else {
              results.bundle.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              logPhaseFailure('B', completedCount.bundle, packagesToBundle.length, packageName, time + 'ms', result.errors)
            }
            break
          }

          case TaskType.PACKAGE: {
            result = await runPackagePhase(graph, [packageName], 1, { force, packageHash })
            completedCount.package++
            if (result.successCount > 0) {
              results.package.successCount++
              if (result.cacheHits > 0) results.package.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('P')} ${dim(String(completedCount.package))}/${packagesToPackage.length} ${packageName} ${success('packaged')}${cacheInfo} ${dim(time + 'ms')}`)
            } else {
              results.package.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              logPhaseFailure('P', completedCount.package, packagesToPackage.length, packageName, time + 'ms', result.errors)
            }
            break
          }

          case TaskType.DOCKER_BUILD: {
            result = await runDockerBuildPhase(graph, [packageName], 1, { force, packageHash, imageCache: dockerImageCache })
            completedCount.dockerBuild++
            if (result.successCount > 0) {
              results.dockerBuild.successCount++
              if (result.cacheHits > 0) results.dockerBuild.cacheHits++
              const time = Math.round(performance.now() - pkgStart)
              const cacheInfo = result.cacheHits > 0 ? ' (cached)' : ''
              console.log(`    ${success('D')} ${dim(String(completedCount.dockerBuild))}/${packagesToDockerBuild.length} ${packageName} ${success('docker built')}${cacheInfo} ${dim(Math.round(time / 1000) + 's')}`)
            } else {
              results.dockerBuild.errors.push(...result.errors)
              const time = Math.round(performance.now() - pkgStart)
              logPhaseFailure('D', completedCount.dockerBuild, packagesToDockerBuild.length, packageName, Math.round(time / 1000) + 's', result.errors)
            }
            break
          }

          default:
            continue
        }

        taskQueue.completeTask(taskType, packageName, result)
      } catch (err) {
        console.error(`    ${packageName} ${taskType} failed: ${err instanceof Error ? err.message : String(err)}`)
        // A thrown task was only logged before, so it never affected the exit code.
        const bucket = taskType === TaskType.BUNDLE ? 'bundle' : taskType === TaskType.PACKAGE ? 'package' : 'dockerBuild'
        results[bucket].errors.push({ package: packageName, error: err })
        taskQueue.completeTask(taskType, packageName, { success: false, error: err })
      }
    }
  }

  // Start workers
  const workers: Array<Promise<void>> = []
  for (let i = 0; i < buildWorkers; i++) {
    workers.push(worker())
  }
  await Promise.all(workers)

  const printBucket = (bucket: PipelineBucket, label: string, errorLabel: string, lead: string): void => {
    console.log(`${lead}${label}: ${bucket.successCount}/${bucket.total} packages`)
    if (bucket.cacheHits > 0) console.log(`  (${bucket.cacheHits} from cache)`)
    if (bucket.errors.length > 0) {
      console.error(`\n  ${bucket.errors.length} ${errorLabel} error(s):`)
      for (const err of bucket.errors) {
        console.error(`    - ${err.package}: ${String(asCommandError(err.error)?.message ?? err.error)}`)
      }
    }
  }

  // Print results
  if (packagesToBundle.length > 0) printBucket(results.bundle, 'Bundled', 'bundle', '\n')
  if (packagesToPackage.length > 0) printBucket(results.package, 'Packaged', 'package', '')
  if (packagesToDockerBuild.length > 0) printBucket(results.dockerBuild, 'Docker built', 'docker build', '')

  return results
}

// Per-phase timing plus what the run was allowed to use. Printed on every build so a CI
// log carries the numbers needed to tell "slow" from "starved" without a rerun.
function printResourceSummary (
  phaseStats: PhaseStat[],
  validationPlan: WorkerCountInfo,
  buildPlan: WorkerCountInfo,
  tscPlan: WorkerCountInfo
): void {
  const { peakMB, source }: PeakMemory = getPeakMemoryMB()

  console.log('\n=== Resources ===')
  console.log(`  CPUs usable        : ${validationPlan.cpuCount}`)
  console.log(`  Memory available   : ${validationPlan.availableMemoryMB} MB`)
  console.log(`  Memory budget (85%): ${validationPlan.budgetMB} MB`)
  console.log(`  tsc pool           : ${tscPlan.workers} processes`)
  console.log(`  Lint/format pool   : ${validationPlan.workers} workers x ${validationPlan.heapMB} MB heap ` +
    `= ${validationPlan.workers * validationPlan.heapMB} MB`)
  console.log(`  Bundle pool        : ${buildPlan.workers} workers`)
  if (peakMB != null) {
    const pct = validationPlan.budgetMB > 0 ? Math.round((peakMB / validationPlan.budgetMB) * 100) : 0
    console.log(`  Peak memory        : ${peakMB} MB (${pct}% of budget) — ${source}`)
  }
  if (validationPlan.belowSafeHeap) {
    console.log(`  ${warn('Heap per worker is below what the heaviest packages need — expect OOM failures')}`)
  }

  const rows = phaseStats.filter((p) => p.seconds != null && p.total > 0)
  if (rows.length === 0) return

  console.log('\n=== Phases ===')
  console.log(`  ${'phase'.padEnd(14)} ${'time'.padStart(8)} ${'pkgs'.padStart(6)} ${'cached'.padStart(7)} ${'errors'.padStart(7)}  workers`)
  for (const r of rows) {
    const workers = r.workers != null
      ? `${r.workers}${(r.heapMB ?? 0) > 0 ? ` x ${r.heapMB}MB` : ''}` +
        (r.peakChildRssMB > 0 ? ` (worst proc ${r.peakChildRssMB}MB)` : '')
      : ''
    console.log(
      `  ${r.name.padEnd(14)} ${((r.seconds as number).toFixed(1) + 's').padStart(8)} ${String(r.total).padStart(6)} ` +
      `${String(r.cacheHits).padStart(7)} ${String(r.errors).padStart(7)}  ${workers}`
    )
  }
}

// Reprint all errors at end of log so they're findable without scrolling.
function printErrorSummary (allErrors: CompileAllError[]): void {
  if (allErrors.length === 0) return
  console.error(`\n${'='.repeat(60)}`)
  console.error(`=== ERROR SUMMARY (${allErrors.length} error(s)) ===`)
  console.error(`${'='.repeat(60)}`)
  for (const err of allErrors) {
    // Both streams: webpack and friends report the actual failure on stdout while stderr only
    // carries the runner's own noise, so picking one hides the reason.
    const tail = (text: string, lines = 200): string => text.trim().split('\n').slice(-lines).join('\n')
    const parts: string[] = []
    const ce = asCommandError(err.error)
    if (ce?.stderr?.trim() !== undefined && ce.stderr.trim() !== '') parts.push(tail(ce.stderr))
    if (ce?.stdout?.trim() !== undefined && ce.stdout.trim() !== '') parts.push(tail(ce.stdout))
    if (parts.length === 0) {
      const msg = ce?.message
      parts.push(String(msg !== undefined && msg !== '' ? msg : (err.error ?? 'Unknown error')))
    }
    const errMsg = parts.join('\n')
    const output = err.output ?? ''
    console.error(`\n[${err.phase}] ${error(err.package)}:`)
    console.error(errMsg)
    if (output !== '' && !errMsg.includes(output.substring(0, 50))) {
      console.error(output)
    }
  }
  console.error(`${'='.repeat(60)}`)
}

export async function compileAll (rootDir: string, options: CompileAllOptions = {}): Promise<CompileAllResult> {
  const {
    parallel = 4,
    verbose = false,
    doTest = false,
    doLint = false,
    doFormat = false,
    force = false,
    doBundle = false,
    doPackage = false,
    doDockerBuild = false,
    doSvelteCheck = false,
    noTypeCheck = false,
    esbuildEmit = false,
    list = false,
    toPackage = null,
    forceWorkers = false
  } = options

  const startTime = performance.now()

  // Size every pool against the memory this process may actually use (cgroup limit in a
  // container, MemAvailable otherwise) rather than the host's total RAM.
  const validationPlan = getOptimalWorkerCount(parallel, 'typescript')
  const tscPlan = getOptimalWorkerCount(parallel, 'tsc')
  const buildPlan = getOptimalWorkerCount(parallel, 'bundle')
  const validationWorkers = forceWorkers ? parallel : validationPlan.workers
  const tscWorkers = forceWorkers ? parallel : tscPlan.workers
  const buildWorkers = forceWorkers ? parallel : buildPlan.workers

  // Start CPU tracking
  const cpuTracker = new CpuTracker(100)
  cpuTracker.start()

  console.log(`Building with ${tscWorkers} tsc workers, ${validationWorkers} lint/format workers, ${buildWorkers} bundle workers...`)
  console.log(`  Memory: ${validationPlan.availableMemoryMB}MB available, ${validationPlan.budgetMB}MB budget, ` +
    `${validationPlan.cpuCount} usable CPU(s); worker heap ${validationPlan.heapMB}MB/worker`)
  if (validationPlan.belowSafeHeap) {
    console.warn(warn(`  Warning: only ${validationPlan.heapMB}MB per validation worker; the heaviest ` +
      `packages need ~${validationPlan.minHeapMB}MB and may fail. Give the runner more memory ` +
      'or set FAST_BUILD_MEMORY_MB if this figure is wrong.'))
  }

  // Build dependency graph
  const { graph } = await buildDependencyGraph(rootDir, verbose)

  // Pre-calculate package hashes for all packages (once per run)
  console.log('Calculating package hashes...')
  const packageHashes = new Map<string, string>()
  for (const [name, node] of graph) {
    packageHashes.set(name, calculatePackageHash(node.project.fullPath))
  }
  console.log(`  Calculated ${packageHashes.size} package hashes`)

  // If --to is specified, collect target packages and all their dependencies
  let targetPackages: Set<string> | null = null
  if (toPackage !== null && toPackage !== '') {
    // Parse multiple --to packages (comma-separated)
    const targets = toPackage.split(',').map((t) => t.trim()).filter(Boolean)
    const collected = new Set<string>()
    targetPackages = collected

    // Helper to get all dependencies recursively
    const getAllDependencies = (packageName: string, visited: Set<string> = new Set()): void => {
      if (visited.has(packageName)) return
      visited.add(packageName)

      const node = graph.get(packageName)
      if (node === undefined) return

      collected.add(packageName)

      // Add all dependencies
      for (const dep of node.dependencies) {
        getAllDependencies(dep, visited)
      }
    }

    // Collect all targets and their dependencies
    for (const target of targets) {
      getAllDependencies(target)
    }

    console.log(`\nFiltering to ${collected.size} packages (targets: ${targets.join(', ')})`)
  }

  const selection = selectPackagesForPhases(graph, {
    doTest, doBundle, doPackage, doDockerBuild, doSvelteCheck, targetPackages
  })

  const packagesToBuild = selection.build
  const packagesToTest = selection.test
  const packagesToFormat = selection.format
  const packagesToBundle = selection.bundle
  const packagesToPackage = selection.package
  const packagesToDockerBuild = selection.dockerBuild
  const packagesToSvelteCheck = selection.svelteCheck

  // Packages whose phase script this tool cannot run used to disappear without a word.
  if (selection.unknown.length > 0) {
    console.warn(`\n${warn(`Warning: ${selection.unknown.length} unrecognised phase script(s), these packages are NOT built:`)}`)
    for (const u of selection.unknown) {
      console.warn(`  ${u.package} — _phase:${u.phase}: ${dim(u.script)}`)
    }
    console.warn(`  Run them with ${bold('pnpm run')} inside the package, or express them as a supported phase script.`)
  }

  if (list) {
    console.log('\nPackages to process:')
    console.log(`  Build: ${packagesToBuild.length}`)
    console.log(`  Test: ${packagesToTest.length}`)
    console.log(`  Format: ${packagesToFormat.length}`)
    console.log(`  Bundle: ${packagesToBundle.length}`)
    console.log(`  Package: ${packagesToPackage.length}`)
    console.log(`  Docker-build: ${packagesToDockerBuild.length}`)
    console.log(`  Svelte-check: ${packagesToSvelteCheck.length}`)
    return { success: true, listOnly: true }
  }

  // Fail before the build rather than after it: the docker phase comes last.
  if (packagesToDockerBuild.length > 0) {
    const docker = spawnSync('docker', ['info'], { stdio: 'ignore' })
    if (docker.status !== 0) {
      console.error(error(`\nDocker is not available (${docker.error?.message ?? '`docker info` failed'}), start Docker and retry`))
      return { success: false, errors: 1 }
    }
  }

  // When --force is used with a "leaf" phase (--test, --lint, --svelte-check, --format),
  // only force that specific phase — prerequisite phases (transpile, validate) use cache.
  const hasLeafPhase = doTest || doLint || doSvelteCheck || doFormat
  const forcePrerequisites = force && !hasLeafPhase

  // Collect all errors across phases for final summary
  const allErrors: CompileAllError[] = []
  const phaseStats: PhaseStat[] = []
  const recordPhase = (name: string, r: GraphPhaseResults, workers: number | null, heapMB: number | null): void => {
    phaseStats.push({
      name,
      seconds: r.time != null ? r.time / 1000 : null,
      total: r.total ?? 0,
      cacheHits: r.cacheHits ?? 0,
      errors: r.errors?.length ?? 0,
      workers: r.workers ?? workers,
      heapMB: r.heapMB ?? heapMB,
      peakChildRssMB: r.peakChildRssMB ?? 0
    })
  }

  // Single build phase: one tsc pass per package emits JS and .d.ts together.
  const buildPhaseResults = await runBuildPhase(graph, packagesToBuild, tscWorkers, {
    force: forcePrerequisites,
    packageHashes,
    noTypeCheck,
    esbuildEmit
  })

  if (buildPhaseResults.errors.length > 0) {
    for (const err of buildPhaseResults.errors) allErrors.push({ phase: 'build', ...err })
    console.error('\nBuild errors - stopping')
    printErrorSummary(allErrors)
    return { success: false, errors: buildPhaseResults.errors.length }
  }

  // Refresh hashes of rebuilt packages so later phases see correct hashes.
  for (const pkg of buildPhaseResults.changedPackages ?? []) {
    const node = graph.get(pkg)
    if (node?.project?.fullPath !== undefined) {
      packageHashes.set(pkg, calculatePackageHash(node.project.fullPath))
    }
  }

  // eslint --fix resolves types through dependencies' .d.ts, so format runs after the build.
  if (doFormat) {
    const formatTargets = packagesToFormat
    console.log(`\n=== Phase: Formatting ${formatTargets.length} packages ===`)
    const formatResults = await runFormatPhase(graph, formatTargets, validationWorkers, { force, packageHashes })
    console.log(`Formatted: ${formatResults.successCount}/${formatResults.total} packages in ${Math.round(formatResults.time)}ms`)
    if (formatResults.cacheHits > 0) console.log(`  (${formatResults.cacheHits} from cache)`)

    cpuTracker.stop()
    const cpuStats = cpuTracker.getStats()
    const totalTime = performance.now() - startTime
    console.log('\n=== Summary ===')
    console.log(`Total time: ${Math.round(totalTime)}ms`)
    console.log(`CPU usage: avg ${cpuStats.avg}%, peak ${cpuStats.peak}%`)

    if (formatResults.errors.length > 0) {
      console.error('\nFormat errors:')
      for (const err of formatResults.errors) {
        const msg = asCommandError(err.error)?.message
        const errMsg = String(msg !== undefined && msg !== '' ? msg : (err.error ?? 'Unknown error'))
        console.error(`  ${error(err.package)}: ${errMsg.split('\n')[0]}`)
      }
      return { success: false, errors: formatResults.errors.length }
    }

    return { success: true, time: totalTime, cpuStats }
  }

  if (doLint) {
    const packagesToLint = packagesToBuild.filter((name) => graph.get(name)?.phaseFormat)
    if (packagesToLint.length > 0) {
      console.log(`\n=== Phase: Linting ${packagesToLint.length} packages ===`)
      const lintResults = await runLintPhase(graph, packagesToLint, validationWorkers, { force, packageHashes, typesHashes: computeTypesHashes(graph), fix: options.lintFix })
      console.log(`Linted: ${lintResults.successCount}/${lintResults.total} packages in ${Math.round(lintResults.time)}ms`)
      recordPhase('lint', lintResults, null, null)
      if (lintResults.cacheHits > 0) console.log(`  (${lintResults.cacheHits} from cache)`)

      if (lintResults.errors.length > 0) {
        for (const err of lintResults.errors) allErrors.push({ phase: 'lint', ...err })
        console.error(`\n${lintResults.errors.length} lint error(s) - stopping build`)
        printErrorSummary(allErrors)
        return { success: false, errors: lintResults.errors.length }
      }
    }
  }

  // Phase: Svelte-check (runs after build)
  if (doSvelteCheck && packagesToSvelteCheck.length > 0) {
    console.log(`\n=== Phase: Svelte-checking ${packagesToSvelteCheck.length} packages ===`)
    const svelteCheckResults = await runSvelteCheckPhase(graph, packagesToSvelteCheck, validationWorkers, { force, packageHashes, typesHashes: computeTypesHashes(graph) })
    console.log(`Svelte-checked: ${svelteCheckResults.successCount}/${svelteCheckResults.total} packages in ${Math.round(svelteCheckResults.time)}ms`)
    recordPhase('svelte-check', svelteCheckResults, null, null)
    if (svelteCheckResults.cacheHits > 0) console.log(`  (${svelteCheckResults.cacheHits} from cache)`)

    if (svelteCheckResults.errors.length > 0) {
      for (const err of svelteCheckResults.errors) allErrors.push({ phase: 'svelte-check', ...err })
      console.error('\nSvelte-check errors - stopping build')
      printErrorSummary(allErrors)
      return { success: false, errors: svelteCheckResults.errors.length }
    }
  }

  // Phase: Test
  if (doTest && packagesToTest.length > 0) {
    console.log(`\n=== Phase: Testing ${packagesToTest.length} packages ===`)
    const testResults = await runTestPhase(graph, packagesToTest, validationWorkers, { force, packageHashes, verbose, group: options.groupTests })
    console.log(`Tested: ${testResults.successCount}/${testResults.total} packages in ${Math.round(testResults.time)}ms`)
    recordPhase('test', testResults, validationWorkers, null)
    if (testResults.cacheHits > 0) console.log(`  (${testResults.cacheHits} from cache)`)
    if ((testResults.skippedCount ?? 0) > 0) console.log(`  (${testResults.skippedCount} skipped — no test files)`)

    if (testResults.errors.length > 0) {
      for (const err of testResults.errors) allErrors.push({ phase: 'test', ...err })
      console.error('\nTest errors:')
      for (const err of testResults.errors) {
        const ce = asCommandError(err.error)
        const errMsg = ce?.stderr || ce?.stdout || ce?.message || err.error || 'Unknown error'
        console.error(`  ${error(err.package)}:`)
        console.error(errMsg)
      }
      printErrorSummary(allErrors)
      return { success: false, errors: testResults.errors.length }
    }
  }

  // Phase 3: Build pipeline (bundle -> package -> docker-build)
  if (doBundle || doPackage || doDockerBuild) {
    const buildResults = await runBuildPipeline(
      packagesToBundle,
      packagesToPackage,
      packagesToDockerBuild,
      graph,
      buildWorkers,
      force,
      packageHashes
    )
    // Pipeline failures never reached allErrors, so a failed bundle/package/docker build still exited 0.
    for (const phase of ['bundle', 'package', 'dockerBuild'] as const) {
      for (const err of buildResults[phase].errors) allErrors.push({ phase, ...err })
    }
  }

  // Stop CPU tracking
  cpuTracker.stop()
  const cpuStats = cpuTracker.getStats()

  const totalTime = performance.now() - startTime

  recordPhase('build', buildPhaseResults, tscWorkers, null)

  console.log('\n=== Summary ===')
  console.log(`Total time: ${Math.round(totalTime)}ms`)
  console.log(`CPU usage: avg ${cpuStats.avg}%, peak ${cpuStats.peak}%`)
  printResourceSummary(phaseStats, validationPlan, buildPlan, tscPlan)

  if (allErrors.length > 0) {
    printErrorSummary(allErrors)
  }

  return {
    success: allErrors.length === 0,
    time: totalTime,
    cpuStats
  }
}

export async function main (args: string[] = process.argv.slice(2)): Promise<void> {
  const options = parseArgs(args)

  if (options.help) {
    printUsage()
    process.exit(0)
  }

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

  try {
    const result = await compileAll(rootDir, options)

    // Terminate all worker pools so the process can exit cleanly
    try {
      await terminateWorkerPool()
    } catch { /* ignore */ }

    if (result.listOnly === true) {
      process.exit(0)
    }

    if (!result.success) {
      process.exit(1)
    }
    process.exit(0)
  } catch (err) {
    console.error('Error:', err instanceof Error ? err.message : err)
    try {
      await terminateWorkerPool()
    } catch { /* ignore */ }
    process.exit(1)
  }
}
