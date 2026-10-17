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

// Build phase - tsc checks and emits .d.ts only, esbuild alone writes lib/.
// Two emitters in one lib/ leave it mixed: tsc's incremental state skips files esbuild rewrote.

import { join } from 'path'
import { rmSync } from 'fs'
import { spawn } from 'child_process'
import { performance } from 'perf_hooks'

import { markPhaseCompleted, getPhaseMetadata, calculateOutputHashForDirs } from '../libs/cache.js'
import { computeTypesHashes, compositeHashFromTypes } from '../libs/composite-hash.js'
import { collectFiles, emitLib, generateSvelteTypes, performESBuildWithSvelte } from '../compile.js'
import { getTypeScriptDriver } from '../drivers/tsc.js'
import type {
  BuildPhaseOptions,
  BuildStepResult,
  DependencyGraph,
  GraphPhaseResults,
  TscRunResult
} from '../types.js'

const COLORS = { reset: '\x1b[0m', red: '\x1b[31m', green: '\x1b[32m', dim: '\x1b[2m' }
const success = (t: string): string => `${COLORS.green}${t}${COLORS.reset}`
const error = (t: string): string => `${COLORS.red}${t}${COLORS.reset}`
const dim = (t: string | number): string => `${COLORS.dim}${t}${COLORS.reset}`

// tsgo occasionally dies mid-compile on a flaky host: random fault address, random package.
// Only a Go-level crash is retried, a type error must still fail on the first pass.
const TSC_CRASH_RETRIES = Number(process.env.TSC_CRASH_RETRIES ?? 2)
export const GO_CRASH = /fatal error:|^panic:|SIGSEGV|unexpected fault address|signal SIG/m

// Esbuild is still needed for the one svelte package that compiles .svelte to JS.
async function runEsbuildPackage (packagePath: string): Promise<void> {
  const files = collectFiles(join(packagePath, 'src'))
  await performESBuildWithSvelte(files, { cwd: packagePath })
  await generateSvelteTypes({ cwd: packagePath })
}

// The only writer of lib/ for non-svelte packages.
async function runEsbuildEmit (packagePath: string): Promise<BuildStepResult> {
  await emitLib(packagePath)
  return { success: true }
}

const failed = (err: unknown): BuildStepResult => ({
  success: false,
  error: err instanceof Error ? err : new Error(String(err))
})

async function runTsc (packagePath: string, emitDeclarationOnly: boolean, noCheck: boolean): Promise<TscRunResult> {
  const driver = getTypeScriptDriver()
  for (let attempt = 0; ; attempt++) {
    const result = await driver.run({
      cwd: packagePath,
      project: 'tsconfig.json',
      tsBuildInfoFile: join('.build', 'build.tsbuildinfo'),
      emitDeclarationOnly,
      noCheck
    })
    if (result.success || attempt === TSC_CRASH_RETRIES || !GO_CRASH.test(result.out)) return result
    // The crash lands inside the incremental snapshot write, so the leftover state may be torn.
    try {
      rmSync(join(packagePath, '.build', 'build.tsbuildinfo'), { force: true })
    } catch {}
    console.error(`    ${error('B')} ${packagePath} tsc crashed, retry ${attempt + 1}/${TSC_CRASH_RETRIES}`)
  }
}

// A child process: emitDts builds a whole TS program synchronously and would stall the scheduler.
function runSvelteDts (packagePath: string): Promise<BuildStepResult> {
  return new Promise((resolve) => {
    let out = ''
    const child = spawn(process.execPath, [join(__dirname, '..', '..', 'bin', 'compile.js'), 'svelte-dts'], {
      cwd: packagePath
    })
    child.stdout.on('data', (d) => {
      out += d
    })
    child.stderr.on('data', (d) => {
      out += d
    })
    child.on('error', (err) => resolve({ success: false, error: err }))
    child.on('close', (code) => resolve(code === 0 ? { success: true } : { success: false, error: new Error(out) }))
  })
}

interface BuildState {
  name: string
  deps: string[]
  remaining: number
  dependents: string[]
}

/**
 * @param concurrency max tsc processes in flight
 */
export async function runBuildPhase (
  graph: DependencyGraph,
  packageNames: string[],
  concurrency: number,
  options: BuildPhaseOptions
): Promise<GraphPhaseResults> {
  const { force = false, packageHashes, noTypeCheck = false, esbuildEmit = false } = options
  // A skipped-check build must never satisfy a checked one, so it caches under its own key.
  // `-split` marks the esbuild-only lib/, so a lib/ left by the tsc emit is rebuilt once.
  const phaseKey = `build-split${noTypeCheck ? '-nocheck' : ''}${esbuildEmit ? '-esbuild' : ''}`
  const startTime = performance.now()
  const results: GraphPhaseResults = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    changedPackages: new Set<string>()
  }
  if (packageNames.length === 0) {
    results.time = 0
    return results
  }

  // Seeded from disk so packages outside this set still contribute a real hash.
  const typesHashes = computeTypesHashes(graph)
  const inSet = new Set(packageNames)
  const timings: Array<{ package: string, time: number, failed?: boolean }> = []
  let completedCount = 0

  const state = new Map<string, BuildState>()
  for (const name of packageNames) {
    const node = graph.get(name)
    if (node === undefined) throw new Error(`Package ${name} is not in the dependency graph`)
    const deps = [...node.dependencies].filter((d) => inSet.has(d))
    state.set(name, { name, deps, remaining: deps.length, dependents: [] })
  }
  for (const [name, s] of state) {
    for (const d of s.deps) state.get(d)?.dependents.push(name)
  }

  async function buildPackage (name: string): Promise<void> {
    const node = graph.get(name)
    if (node === undefined) return
    const packagePath = node.project.fullPath
    const isUi = node.phaseBuild === 'compile build-ui'
    const isEsbuild = node.phaseBuild === 'compile ui-esbuild'
    const outputDirs = esbuildEmit ? ['lib'] : isUi ? ['types'] : ['lib', 'types']
    const pkgStart = performance.now()

    // A dependency is visible only through its .d.ts, so that is the input, not its sources.
    const packageHash = compositeHashFromTypes(name, graph, packageHashes, typesHashes, ['tsconfig.json'])

    // Must hash the same dirs as markPhaseCompleted, or the cache never hits.
    const outputHash = calculateOutputHashForDirs(packagePath, outputDirs)
    const typesHash = isUi ? outputHash : calculateOutputHashForDirs(packagePath, ['types'])
    if (typesHash) typesHashes.set(name, typesHash)

    const cached = packageHash ? getPhaseMetadata(packagePath, packageHash, phaseKey) : null
    const outputsMatch = cached != null && (cached.outputHash == null || cached.outputHash === outputHash)
    if (!force && packageHash && outputsMatch) {
      results.successCount++
      results.cacheHits++
      return
    }

    // tsc's own incremental state does not notice that outputs were deleted, so --force
    // has to drop it too or nothing is re-emitted.
    if (force) {
      try {
        rmSync(join(packagePath, '.build', 'build.tsbuildinfo'), { force: true })
      } catch {}
    }

    let result: BuildStepResult
    if (isEsbuild) {
      result = await runEsbuildPackage(packagePath).then(() => ({ success: true }), failed)
    } else if (esbuildEmit) {
      // UI packages ship sources and only ever emitted declarations, so they have nothing to do here.
      result = isUi ? { success: true } : await runEsbuildEmit(packagePath).catch(failed)
    } else {
      const tsc = await runTsc(packagePath, true, noTypeCheck)
      result = tsc.success ? { success: true } : failed(tsc.error)
      if (result.success && isUi) {
        result = await runSvelteDts(packagePath)
      } else if (result.success && !isUi) {
        result = await runEsbuildEmit(packagePath).catch(failed)
      }
    }
    const pkgTime = Math.round(performance.now() - pkgStart)

    if (result.success) {
      results.successCount++
      results.changedPackages?.add(name)
      const fresh = calculateOutputHashForDirs(packagePath, ['types'])
      if (fresh) typesHashes.set(name, fresh)
      if (packageHash) markPhaseCompleted(packagePath, packageHash, phaseKey, null, outputDirs)
      console.log(
        `    ${success('B')} ${dim(completedCount + 1)}/${packageNames.length} ${name} ${success('built')} ${dim(pkgTime + 'ms')}`
      )
      timings.push({ package: name, time: pkgTime })
    } else {
      results.errors.push({ package: name, error: result.error })
      console.error(
        `    ${error('B')} ${dim(completedCount + 1)}/${packageNames.length} ${name} ${error('FAILED')} ${dim(pkgTime + 'ms')}`
      )
      console.error(
        String(result.error?.message ?? result.error)
          .split('\n')
          .slice(0, 8)
          .map((l) => '      ' + l)
          .join('\n')
      )
      timings.push({ package: name, time: pkgTime, failed: true })
    }
  }

  console.log(`\n=== Phase: Building ${packageNames.length} packages ===`)
  console.log(`    Using ${concurrency} workers`)

  // Ready-queue, not waves: a package starts as soon as its own dependencies are done.
  const ready = packageNames.filter((n) => state.get(n)?.remaining === 0)
  let running = 0
  let done = 0

  await new Promise<void>((resolve, reject) => {
    const pump = (): void => {
      if (done === packageNames.length) {
        resolve()
        return
      }
      if (running === 0 && ready.length === 0) {
        reject(new Error('Circular dependency detected in build phase'))
        return
      }
      while (running < concurrency && ready.length > 0) {
        const name = ready.shift() as string
        running++
        buildPackage(name).then(() => {
          running--
          done++
          completedCount++
          for (const dep of state.get(name)?.dependents ?? []) {
            const depState = state.get(dep)
            if (depState !== undefined && --depState.remaining === 0) ready.push(dep)
          }
          pump()
        }, reject)
      }
    }
    pump()
  })

  results.time = performance.now() - startTime

  console.log(`\nBuilt: ${results.successCount}/${results.total} packages in ${Math.round(results.time)}ms`)
  if (results.cacheHits > 0) console.log(`  (${results.cacheHits} from cache)`)

  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(10, sorted.length)
    console.log(`\n    Top ${slowCount} slowest packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${t.failed === true ? ' FAILED' : ''}`)
    }
  }

  return results
}
