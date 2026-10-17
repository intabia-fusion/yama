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

import { spawn } from 'child_process'
import { existsSync, statSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { isPhaseCached, markPhaseCompleted } from '../libs/cache.js'
import type { CommandError, DependencyGraph, PhaseRunOptions, PhaseRunResults, PhaseStepResult } from '../types.js'

const PNPM_CMD = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function hasPackageOutput (cwd: string): boolean {
  const distPath = join(cwd, 'dist')
  return existsSync(distPath) && statSync(distPath).isDirectory()
}

export async function runPackagePhase (
  graph: DependencyGraph,
  packageNames: string[],
  concurrency: number,
  options: PhaseRunOptions = {}
): Promise<PhaseRunResults> {
  const { force = false, packageHash } = options

  const results: PhaseRunResults = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  async function packagePackage (packageName: string): Promise<PhaseStepResult> {
    const node = graph.get(packageName)
    if (node === undefined) throw new Error(`Package not in graph: ${packageName}`)
    const cwd = node.project.fullPath

    if (!force && packageHash) {
      if (isPhaseCached(cwd, packageHash, 'package', hasPackageOutput, ['dist'])) {
        return { success: true, fromCache: true }
      }
    }

    return await new Promise((resolve) => {
      const startTime = performance.now()
      const child = spawn(PNPM_CMD, ['run', 'package'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true
      })

      let stdout = ''
      let stderr = ''
      let progressInterval: ReturnType<typeof setTimeout> | null = null
      let progressTimeout: ReturnType<typeof setTimeout> | null = null
      let isCompleted = false

      // Setup progress logging for long-running packages (>15s)
      const setupProgressLogging = (): void => {
        const checkProgress = (): void => {
          if (isCompleted) return
          const elapsed = Math.round((performance.now() - startTime) / 1000)
          if (elapsed >= 15) {
            console.log(`    [package] ${packageName} still packaging... (${elapsed}s elapsed)`)
          }
        }

        // First check after 15 seconds
        progressTimeout = setTimeout(() => {
          if (isCompleted) return
          checkProgress()
          // Then every 15 seconds
          if (!isCompleted) {
            progressInterval = setInterval(checkProgress, 15000)
          }
        }, 15000)
      }

      setupProgressLogging()

      child.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString()
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
      })

      child.on('close', (code) => {
        isCompleted = true
        const time = performance.now() - startTime

        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }

        if (code === 0) {
          if (packageHash) {
            markPhaseCompleted(cwd, packageHash, 'package', null, ['dist'])
          }
          resolve({ success: true, time })
        } else {
          const error: CommandError = new Error(`Package failed with exit code ${code}`)
          error.stdout = stdout
          error.stderr = stderr
          resolve({ success: false, error, time })
        }
      })

      child.on('error', (err) => {
        isCompleted = true
        if (progressTimeout) {
          clearTimeout(progressTimeout)
          progressTimeout = null
        }
        if (progressInterval) {
          clearInterval(progressInterval)
          progressInterval = null
        }
        resolve({ success: false, error: err })
      })
    })
  }

  const promises = packageNames.map(async (name) => {
    const result = await packagePackage(name)
    if (result.success) {
      results.successCount++
      if (result.fromCache) results.cacheHits++
    } else {
      results.errors.push({ package: name, error: result.error })
    }
    return result
  })

  await Promise.all(promises)
  return results
}
