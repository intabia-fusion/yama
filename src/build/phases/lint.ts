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

import { performance } from 'perf_hooks'
import { join } from 'path'
import { isPhaseCached, markPhaseCompleted } from '../libs/cache.js'
import { getNamedWorkerPool } from '../libs/workers.js'
import { getOptimalWorkerCount } from '../libs/utils.js'
import { computeTypesHashes, compositeHashFromTypes } from '../libs/composite-hash.js'
import { success, error, dim } from '../libs/colors.js'
import type {
  DependencyGraph,
  GraphPhaseOptions,
  GraphPhaseResults,
  LintResultMessage,
  LintTaskMessage
} from '../types.js'

/**
 * Run lint phase for all packages.
 * Hash is composite (package + deps) — lint errors can originate from changed dependency types.
 * Concurrency is capped at 2 to limit ESLint memory usage (~3GB per worker).
 */
export async function runLintPhase (
  graph: DependencyGraph,
  packageNames: string[],
  concurrency: number,
  options: GraphPhaseOptions = {}
): Promise<GraphPhaseResults> {
  const fix = options.fix === true
  const { force = false, packageHashes, typesHashes } = options

  // Lint sees dependencies through their emitted .d.ts, so key on those, not on their sources.
  const depTypes = typesHashes ?? computeTypesHashes(graph)

  // Lint workers consume significant memory — cap to 2 regardless of requested concurrency
  const plan = getOptimalWorkerCount(concurrency, 'lint')
  const lintConcurrency = plan.workers

  const results: GraphPhaseResults = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0,
    peakMemoryMB: 0,
    workers: lintConcurrency,
    heapMB: plan.heapMB
  }

  const startTime = performance.now()
  const pool = await getNamedWorkerPool<LintTaskMessage, LintResultMessage>('lint', lintConcurrency, join(__dirname, '..', 'workers', 'lint-worker.js'), {
    workerOptions: {
      resourceLimits: {
        maxOldGenerationSizeMb: plan.heapMB,
        maxYoungGenerationSizeMb: 512
      }
    },
    recycleAfter: 15,
    recycleMemoryMB: Math.floor(plan.heapMB * 0.8)
  })

  let completedCount = 0
  const timings: Array<{ package: string, time: number, failed: boolean }> = []

  const promises = packageNames.map(async (name) => {
    const node = graph.get(name)
    if (node === undefined) return

    if (!node.phaseFormat) {
      completedCount++
      results.successCount++
      results.cacheHits++
      return
    }

    const cwd = node.project.fullPath
    const hash =
      packageHashes != null
        ? compositeHashFromTypes(name, graph, packageHashes, depTypes, [
          '.eslintrc.js',
          '.eslintrc.json',
          'eslint.config.js'
        ])
        : undefined

    if (!force && hash && isPhaseCached(cwd, hash, 'lint', null, [])) {
      completedCount++
      results.successCount++
      results.cacheHits++
      console.log(`    [L] ${completedCount}/${packageNames.length} ${dim(name)} ${dim('(cached)')}`)
      return
    }

    const taskStart = performance.now()
    const result = await pool.runTask('lint', cwd, { srcDir: 'src', fix })
    const waitTime = Math.round(performance.now() - taskStart)
    const taskTime = result.durationMs !== undefined ? result.durationMs : waitTime
    completedCount++

    timings.push({ package: name, time: taskTime, failed: !result.success })

    if (result.memoryMB !== undefined && result.memoryMB > (results.peakMemoryMB ?? 0)) {
      results.peakMemoryMB = result.memoryMB
    }

    if (result.success) {
      if (hash) {
        markPhaseCompleted(cwd, hash, 'lint', null, [])
      }
      results.successCount++
      const warnInfo = result.warningCount > 0 ? ` (${result.warningCount} warnings)` : ''
      const memInfo = result.memoryMB !== undefined ? ` ${dim(result.memoryMB + 'MB')}` : ''
      console.log(
        `    [L] ${completedCount}/${packageNames.length} ${success(name)} linted ${dim(taskTime + 'ms')}${memInfo}${warnInfo}`
      )
    } else {
      results.errors.push({ package: name, error: result.error })
      console.error(`    [L] ${completedCount}/${packageNames.length} ${error(name)} FAILED ${dim(taskTime + 'ms')}`)
      if (result.output) process.stderr.write(result.output + '\n')
    }
  })

  await Promise.all(promises)
  results.time = performance.now() - startTime

  // Print timing summary
  if (timings.length > 0) {
    const sorted = timings.sort((a, b) => b.time - a.time)
    const slowCount = Math.min(5, sorted.length)
    console.log(`\n    Top ${slowCount} slowest lint packages:`)
    for (let i = 0; i < slowCount; i++) {
      const t = sorted[i]
      const failInfo = t.failed ? ' FAILED' : ''
      console.log(`      ${(t.time / 1000).toFixed(1)}s ${t.package}${failInfo}`)
    }
  }
  if ((results.peakMemoryMB ?? 0) > 0) {
    console.log(`    Peak worker memory: ${results.peakMemoryMB}MB`)
  }

  return results
}
