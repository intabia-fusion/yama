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

import { execSync, spawn, spawnSync } from 'child_process'
import { createHash } from 'crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { performance } from 'perf_hooks'
import { loadYamaConfig } from '../config.js'
import { isPhaseCached, markPhaseCompleted } from '../libs/cache.js'
import { findWorkspaceRoot } from '../libs/workspace.js'
import type {
  CommandError,
  DependencyGraph,
  DockerImageInfo,
  DockerPhaseOptions,
  PhaseRunResults,
  PhaseStepResult
} from '../types.js'

const PNPM_CMD = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'

function isDockerAvailable (): boolean {
  try {
    execSync('docker --version', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

// Extract docker image name from package's docker:build script
export function getDockerImageName (cwd: string): string | null {
  try {
    const packageJsonPath = join(cwd, 'package.json')
    if (!existsSync(packageJsonPath)) return null

    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { scripts?: Record<string, string> }
    const dockerBuildScript = pkg.scripts?.['docker:build']
    if (!dockerBuildScript) return null

    // Extract image name from script like:
    // "../../common/scripts/docker_build.sh rating"
    const match = dockerBuildScript.match(/docker_build\.sh\s+([^\s]+)/)
    if (match) {
      // docker_build.sh prepends the namespace to a bare component name.
      const rootDir = findWorkspaceRoot(cwd)
      const configNamespace = rootDir != null ? loadYamaConfig(rootDir).docker?.namespace : undefined
      const namespace = process.env.DOCKER_NAMESPACE ?? configNamespace
      if (match[1].includes('/') || namespace === undefined) return match[1]
      return `${namespace}/${match[1]}`
    }

    return null
  } catch {
    return null
  }
}

// Preload image info for a batch of images in a single `docker inspect` call.
// Images not present in docker are returned as { exists: false, hash: null }.
export async function preloadDockerImages (imageNames: Array<string | null | undefined>): Promise<Map<string, DockerImageInfo>> {
  const cache = new Map<string, DockerImageInfo>()
  const unique = Array.from(new Set(imageNames.filter((n): n is string => Boolean(n))))
  for (const name of unique) {
    cache.set(name, { exists: false, hash: null })
  }
  if (unique.length === 0) return cache

  return await new Promise((resolve) => {
    const refs = unique.map((n) => n + ':latest')
    // Image may carry multiple tags; emit all tags joined by space, then hash.
    const fmt = '{{range .RepoTags}}{{.}} {{end}}\t{{index .Config.Labels "PACKAGE_HASH"}}'
    const child = spawn('docker', ['image', 'inspect', '--format', fmt, ...refs], {
      stdio: ['pipe', 'pipe', 'pipe']
    })

    let stdout = ''
    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', () => {}) // swallow "No such image" errors

    child.on('close', () => {
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const [repoTagsStr, hash] = trimmed.split('\t')
        if (!repoTagsStr) continue
        const cleanHash = hash && hash !== '<no value>' ? hash : null
        for (const tag of repoTagsStr.trim().split(/\s+/)) {
          const name = tag.replace(/:[^:]*$/, '')
          if (cache.has(name)) {
            cache.set(name, { exists: true, hash: cleanHash })
          }
        }
      }
      resolve(cache)
    })

    child.on('error', () => resolve(cache))
  })
}

interface DockerImageCheck {
  exists: boolean
  hashMatch: boolean
}

// Uses preloaded imageCache when available to avoid per-package docker calls.
async function checkDockerImage (
  imageName: string,
  packageHash: string,
  imageCache?: Map<string, DockerImageInfo>
): Promise<DockerImageCheck> {
  const entry = imageCache?.get(imageName)
  if (entry !== undefined) {
    return { exists: entry.exists, hashMatch: entry.exists && entry.hash === packageHash }
  }
  // Fallback: single inspect call
  return await new Promise((resolve) => {
    const fmt = '{{index .Config.Labels "PACKAGE_HASH"}}'
    const child = spawn('docker', ['image', 'inspect', '-f', fmt, imageName + ':latest'], {
      stdio: ['pipe', 'pipe', 'pipe']
    })
    let stdout = ''
    child.stdout?.on('data', (d: Buffer) => {
      stdout += d.toString()
    })
    child.stderr?.on('data', () => {})
    child.on('close', (code) => {
      if (code !== 0) {
        resolve({ exists: false, hashMatch: false })
        return
      }
      const imageHash = stdout.trim()
      resolve({ exists: true, hashMatch: imageHash === packageHash && !!imageHash })
    })
    child.on('error', () => resolve({ exists: false, hashMatch: false }))
  })
}

/**
 * Short hash of the bundle/ files the image is built from (source maps skipped: large and never run).
 * It goes into the PACKAGE_HASH label, so an image built from a broken or half-written bundle stops
 * matching once the bundle on disk is fixed. Sources alone hash the same in both cases.
 */
export function hashBundleDir (cwd: string): string {
  const dir = join(cwd, 'bundle')
  if (!existsSync(dir)) return ''
  const hash = createHash('md5')
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name)
    if (name.endsWith('.map') || !statSync(file).isFile()) continue
    hash.update(name).update(readFileSync(file))
  }
  return hash.digest('hex').slice(0, 12)
}

export async function runDockerBuildPhase (
  graph: DependencyGraph,
  packageNames: string[],
  concurrency: number,
  options: DockerPhaseOptions = {}
): Promise<PhaseRunResults> {
  const { force = false, packageHash, imageCache } = options

  if (!isDockerAvailable()) {
    console.error('[docker-build] Error: Docker is not available. Please install Docker or ensure it is running.')
    process.exit(1)
  }

  const results: PhaseRunResults = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  async function dockerBuildPackage (packageName: string): Promise<PhaseStepResult> {
    const node = graph.get(packageName)
    if (node === undefined) throw new Error(`Package not in graph: ${packageName}`)
    const cwd = node.project.fullPath

    const imageName = getDockerImageName(cwd)

    // A cached bundle phase does not prove the file is still intact: refuse to ship one that does not parse.
    const bundleFile = join(cwd, 'bundle', 'bundle.js')
    if (existsSync(bundleFile)) {
      const check = spawnSync(process.execPath, ['--check', bundleFile], { stdio: 'pipe' })
      if (check.status !== 0) {
        const size = statSync(bundleFile).size
        return {
          success: false,
          error: new Error(`bundle/bundle.js is not parseable (${size} bytes): ${String(check.stderr).trim()}`)
        }
      }
    }
    const bundleHash = hashBundleDir(cwd)
    const imageHash = packageHash && bundleHash ? `${packageHash}-${bundleHash}` : packageHash

    // Check cache: image must exist with matching hash and phase must be cached
    if (!force && imageHash && imageName) {
      const imageCheck = await checkDockerImage(imageName, imageHash, imageCache)
      if (imageCheck.exists && imageCheck.hashMatch && isPhaseCached(cwd, packageHash as string, 'docker-build')) {
        return { success: true, fromCache: true }
      }
      // Log why we're rebuilding
      if (imageCheck.exists && !imageCheck.hashMatch) {
        console.log(`    [docker-build] ${packageName} - image hash mismatch, rebuilding...`)
      } else if (imageCheck.exists && !isPhaseCached(cwd, packageHash as string, 'docker-build')) {
        console.log(`    [docker-build] ${packageName} - phase cache miss, rebuilding...`)
      } else if (!imageCheck.exists) {
        console.log(`    [docker-build] ${packageName} - image '${imageName}' not found, building...`)
      }
    }

    return await new Promise((resolve) => {
      const startTime = performance.now()
      console.log(`    [docker-build] Starting ${packageName}...`)

      // Pass packageHash to docker build for labeling
      const child = spawn(PNPM_CMD, ['run', 'docker:build'], {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: true,
        env: { ...process.env, PACKAGE_HASH: imageHash || '' }
      })

      let stdout = ''
      let stderr = ''
      let progressInterval: ReturnType<typeof setTimeout> | null = null
      let progressTimeout: ReturnType<typeof setTimeout> | null = null
      let hasOutput = false
      let isCompleted = false

      const getLastLogLine = (output: string): string => {
        const lines = output.split('\n').filter((line) => line.trim())
        return lines[lines.length - 1] || ''
      }

      // Setup progress logging for long-running docker builds (>15s)
      const setupProgressLogging = (): void => {
        const checkProgress = (): void => {
          if (isCompleted) return
          const elapsed = Math.round((performance.now() - startTime) / 1000)
          if (elapsed >= 15) {
            const lastLine = getLastLogLine(stdout + stderr)
            console.log(
              `    [docker-build] ${packageName} still building... (${elapsed}s elapsed, hasOutput: ${hasOutput})`
            )
            if (lastLine) {
              console.log(`      Last log: ${lastLine.substring(0, 200)}`)
            } else if (!hasOutput) {
              console.log('      No output received yet')
            }
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
        hasOutput = true
      })
      child.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString()
        hasOutput = true
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

        // Another build rewrote bundle/ while docker was copying it: the image may hold a half-written file.
        // A missing bundle/ is DOCKER_BUILD_CLEANUP (docker_build.sh removes it after a successful build).
        const bundleAfter = hashBundleDir(cwd)
        if (code === 0 && bundleAfter !== '' && bundleAfter !== bundleHash) {
          resolve({
            success: false,
            error: new Error('bundle/ changed during docker build (another build running?), image may be broken: re-run'),
            time
          })
        } else if (code === 0) {
          if (packageHash) {
            markPhaseCompleted(cwd, packageHash, 'docker-build', null, [])
          }
          resolve({ success: true, time })
        } else {
          const error: CommandError = new Error(`Docker build failed with exit code ${code}`)
          error.stdout = stdout
          error.stderr = stderr
          // Log error details to console
          console.error(`[docker-build] ${packageName} failed:`)
          console.error(`  Exit code: ${code}`)
          if (stderr) console.error(`  stderr: ${stderr}`)
          if (stdout) console.error(`  stdout: ${stdout}`)
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
    const result = await dockerBuildPackage(name)
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
