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

import os from 'os'
import crypto from 'crypto'
import { execSync } from 'child_process'
import { existsSync, readFileSync, readdirSync, mkdirSync, copyFileSync, rmSync } from 'fs'
import { join, relative, dirname } from 'path'

import type {
  CpuStats,
  CpuTimes,
  CpuUsage,
  PeakMemory,
  PhaseMemorySpec,
  SyncDirectoryOptions,
  SyncDirectoryResult,
  WorkerCountInfo,
  WorkerCountOverrides
} from '../types.js'

let lastCpuInfo: CpuTimes | null = null

function getCpuTimes (): CpuTimes {
  const cpus = os.cpus()
  let user = 0
  let nice = 0
  let sys = 0
  let idle = 0
  let irq = 0
  for (const cpu of cpus) {
    user += cpu.times.user
    nice += cpu.times.nice
    sys += cpu.times.sys
    idle += cpu.times.idle
    irq += cpu.times.irq
  }
  return { user, nice, sys, idle, irq, total: user + nice + sys + idle + irq }
}

function startCpuTracking (): CpuTimes {
  lastCpuInfo = getCpuTimes()
  return lastCpuInfo
}

function getCpuUsage (): CpuUsage {
  if (lastCpuInfo === null) {
    lastCpuInfo = getCpuTimes()
    return { percent: 0, user: 0, sys: 0 }
  }

  const current = getCpuTimes()
  const diff = {
    user: current.user - lastCpuInfo.user,
    nice: current.nice - lastCpuInfo.nice,
    sys: current.sys - lastCpuInfo.sys,
    idle: current.idle - lastCpuInfo.idle,
    total: current.total - lastCpuInfo.total
  }

  const percent = diff.total > 0 ? ((diff.user + diff.nice + diff.sys) / diff.total) * 100 : 0
  const userPercent = diff.total > 0 ? (diff.user / diff.total) * 100 : 0
  const sysPercent = diff.total > 0 ? (diff.sys / diff.total) * 100 : 0

  lastCpuInfo = current
  return { percent, user: userPercent, sys: sysPercent }
}

/**
 * Track CPU usage over time
 */
export class CpuTracker {
  intervalMs: number
  samples: CpuUsage[]
  interval: ReturnType<typeof setInterval> | null
  peakPercent: number

  constructor (intervalMs = 100) {
    this.intervalMs = intervalMs
    this.samples = []
    this.interval = null
    this.peakPercent = 0
  }

  start (): void {
    startCpuTracking()
    this.samples = []
    this.peakPercent = 0
    this.interval = setInterval(() => {
      const usage = getCpuUsage()
      this.samples.push(usage)
      if (usage.percent > this.peakPercent) {
        this.peakPercent = usage.percent
      }
    }, this.intervalMs)
  }

  stop (): void {
    if (this.interval !== null) {
      clearInterval(this.interval)
      this.interval = null
    }
    // Get final sample
    const usage = getCpuUsage()
    this.samples.push(usage)
    if (usage.percent > this.peakPercent) {
      this.peakPercent = usage.percent
    }
  }

  getStats (): CpuStats {
    if (this.samples.length === 0) {
      return { avg: 0, peak: 0, min: 0 }
    }

    const percents = this.samples.map((s) => s.percent)
    const avg = percents.reduce((a, b) => a + b, 0) / percents.length
    const peak = Math.max(...percents)
    const min = Math.min(...percents)

    return {
      avg: Math.round(avg * 10) / 10,
      peak: Math.round(peak * 10) / 10,
      min: Math.round(min * 10) / 10,
      samples: this.samples.length
    }
  }
}

// Page size is 4096 on Intel but 16384 on Apple Silicon, so it must be read
// from the vm_stat header rather than assumed.
export function parseDarwinVmStat (vmstat: string): number | null {
  const pageSizeMatch = vmstat.match(/page size of (\d+) bytes/)
  const freeMatch = vmstat.match(/Pages free:\s+(\d+)/)
  const inactiveMatch = vmstat.match(/Pages inactive:\s+(\d+)/)
  if (pageSizeMatch === null || freeMatch === null || inactiveMatch === null) return null

  const pageSize = parseInt(pageSizeMatch[1], 10)
  const pages = parseInt(freeMatch[1], 10) + parseInt(inactiveMatch[1], 10)
  return Math.round((pages * pageSize) / 1024 / 1024)
}

export function parseLinuxMemInfo (meminfo: string): number | null {
  const availableMatch = meminfo.match(/MemAvailable:\s+(\d+)/)
  if (availableMatch === null) return null
  return Math.round(parseInt(availableMatch[1], 10) / 1024)
}

// Anything at or above this is the kernel's "no limit" sentinel, not a real cap.
const CGROUP_UNLIMITED = 2 ** 53

/**
 * Parse a cgroup memory limit file (v2 `memory.max`, v1 `memory.limit_in_bytes`).
 * Inside a container os.totalmem() reports the HOST's memory, so without this a 4GB
 * container looks like a 64GB machine and the build gets OOM-killed.
 * Returns the limit in MB, or null when unlimited/unparseable.
 */
export function parseCgroupBytes (raw: string | null | undefined): number | null {
  if (raw == null) return null
  const text = String(raw).trim()
  if (text === '' || text === 'max') return null
  const bytes = Number(text)
  if (!Number.isFinite(bytes) || bytes <= 0 || bytes >= CGROUP_UNLIMITED) return null
  return Math.round(bytes / 1024 / 1024)
}

/**
 * Parse a cgroup CPU quota into a core count.
 * v2 `cpu.max` is "<quota> <period>" or "max <period>"; v1 passes quota and period separately.
 * Returns cores, or null when unlimited/unparseable.
 */
export function parseCgroupCpuMax (raw: string | null | undefined, periodFallback = 100000): number | null {
  if (raw == null) return null
  const parts = String(raw).trim().split(/\s+/)
  if (parts.length === 0 || parts[0] === 'max') return null
  const quota = Number(parts[0])
  const period = parts.length > 1 ? Number(parts[1]) : periodFallback
  if (!Number.isFinite(quota) || !Number.isFinite(period) || quota <= 0 || period <= 0) return null
  return Math.max(1, Math.round(quota / period))
}

function readFirst (paths: string[]): string | null {
  for (const p of paths) {
    try {
      return readFileSync(p, 'utf-8')
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * Memory the cgroup still allows us to use, in MB, or null when uncapped.
 */
export function getCgroupAvailableMemoryMB (): number | null {
  if (process.platform !== 'linux') return null

  const limit = parseCgroupBytes(
    readFirst([
      '/sys/fs/cgroup/memory.max', // cgroup v2
      '/sys/fs/cgroup/memory/memory.limit_in_bytes' // cgroup v1
    ])
  )
  if (limit == null) return null

  const used =
    parseCgroupBytes(readFirst(['/sys/fs/cgroup/memory.current', '/sys/fs/cgroup/memory/memory.usage_in_bytes'])) ?? 0

  return Math.max(1, limit - used)
}

/**
 * CPUs actually usable: cgroup quota if present, otherwise the scheduler's view.
 */
export function getUsableCpuCount (): number {
  const host = os.availableParallelism ? os.availableParallelism() : os.cpus().length

  if (process.platform !== 'linux') return host

  const v2 = parseCgroupCpuMax(readFirst(['/sys/fs/cgroup/cpu.max']))
  if (v2 != null) return Math.max(1, Math.min(host, v2))

  const quota = readFirst(['/sys/fs/cgroup/cpu/cpu.cfs_quota_us'])
  const period = readFirst(['/sys/fs/cgroup/cpu/cpu.cfs_period_us'])
  if (quota != null) {
    const v1 = parseCgroupCpuMax(`${String(quota).trim()} ${String(period ?? '100000').trim()}`)
    if (v1 != null) return Math.max(1, Math.min(host, v1))
  }

  return host
}

/**
 * Get available system memory in MB.
 * Honours an explicit override, then the cgroup limit, then the OS view - the smallest wins,
 * because exceeding any one of them is what gets the process killed.
 */
export function getAvailableMemoryMB (): number {
  const override = parseInt(process.env.FAST_BUILD_MEMORY_MB ?? '', 10)
  if (Number.isFinite(override) && override > 0) return override

  let osView = Math.round(os.freemem() / 1024 / 1024)
  try {
    if (process.platform === 'darwin') {
      const parsed = parseDarwinVmStat(execSync('vm_stat', { encoding: 'utf-8' }))
      if (parsed !== null) osView = parsed
    } else if (process.platform === 'linux') {
      const parsed = parseLinuxMemInfo(readFileSync('/proc/meminfo', 'utf-8'))
      if (parsed !== null) osView = parsed
    }
  } catch {
    // Fall back to os.freemem()
  }

  const cgroup = getCgroupAvailableMemoryMB()
  return cgroup == null ? osView : Math.min(osView, cgroup)
}

/**
 * Peak resident memory of this build, in MB.
 * On Linux the cgroup figure is preferred because it covers spawned children
 * (svelte-check, docker) too; VmHWM only covers this process.
 */
export function getPeakMemoryMB (): PeakMemory {
  if (process.platform === 'linux') {
    const cg = parseCgroupBytes(
      readFirst(['/sys/fs/cgroup/memory.peak', '/sys/fs/cgroup/memory/memory.max_usage_in_bytes'])
    )
    if (cg != null) return { peakMB: cg, source: 'cgroup peak (incl. child processes)' }

    const status = readFirst(['/proc/self/status'])
    const hwm = status?.match(/VmHWM:\s+(\d+)\s+kB/)
    if (hwm != null) return { peakMB: Math.round(parseInt(hwm[1], 10) / 1024), source: 'VmHWM (this process only)' }
  }

  // maxRSS is reported in kilobytes and covers worker_threads (same process) but not
  // spawned children such as svelte-check.
  const { maxRSS } = process.resourceUsage()
  if (maxRSS > 0) {
    return { peakMB: Math.round(maxRSS / 1024), source: 'maxRSS (excl. spawned processes)' }
  }
  return { peakMB: null, source: 'unavailable' }
}

/**
 * Get smart default worker count based on system resources
 * - Default: number of CPUs (for maximum parallelism during docker-build)
 * - Limited by available memory to prevent OOM
 */
export function getDefaultWorkerCount (): number {
  const cpuCount = os.cpus().length
  const totalMemMB = Math.round(os.totalmem() / 1024 / 1024)

  // Estimate memory per worker (docker builds use less memory than TS validation)
  const memoryPerWorker = 1000 // 1GB per docker build worker
  const maxWorkersByMemory = Math.max(1, Math.floor(totalMemMB / memoryPerWorker))

  return Math.min(cpuCount, maxWorkersByMemory)
}

/**
 * Per-phase memory profile, all figures measured on this repo (460 packages):
 *  - minHeapMB: below this the heaviest package OOMs. Verified by bisection -
 *    validate loses pod-gmail/pod-calendar at 1024, format loses 2 packages at 1024,
 *    svelte-check loses tracker/github/workflow-resources at 1536.
 *  - heapMB: the ceiling worth giving a worker when memory allows. Higher than this
 *    buys nothing: uncapped validate peaked at 9.2GB and ran no faster than a 2GB cap.
 */
const PHASE_MEMORY: Record<string, PhaseMemorySpec> = {
  // Native tsc is a Go process, not a V8 isolate: ~420MB peak, and wall time keeps improving
  // with more processes even when every core is busy. Measured 460 packages: on 16 cores
  // 4 -> 14.0s, 8 -> 14.0s, 16 -> 14.6s; on 4 cores 2 -> 42.5s, 4 -> 22.4s, 8 -> 19.2s.
  // Hence a fixed count capped only by memory, not by CPU count.
  tsc: { minHeapMB: 512, heapMB: 512, workers: 8 },
  typescript: { minHeapMB: 1536, heapMB: 2048, maxWorkers: 6 },
  'svelte-check': { minHeapMB: 3072, heapMB: 3072 },
  format: { minHeapMB: 1280, heapMB: 1536 },
  // @typescript-eslint 8 builds a bigger type graph than 6 did: pod-gmail OOMs below 2048.
  lint: { minHeapMB: 2048, heapMB: 2560 },
  bundle: { minHeapMB: 512, heapMB: 800 },
  docker: { minHeapMB: 256, heapMB: 500 },
  default: { minHeapMB: 512, heapMB: 1000 }
}

// Leave headroom: claiming every free megabyte evicts the page cache and pushes the
// machine towards swap or the OOM killer, which costs more than an extra worker gains.
const MEMORY_HEADROOM = 0.85

/**
 * Decide how many workers to run and how much heap to allow each, so that
 * workers * heapMB stays inside the memory this process is actually allowed to use.
 * `overrides` exists for tests.
 */
export function getOptimalWorkerCount (
  requestedWorkers: number,
  taskType = 'default',
  overrides: WorkerCountOverrides = {}
): WorkerCountInfo {
  const availableMem = overrides.availableMemoryMB ?? getAvailableMemoryMB()
  const cpuCount = overrides.cpuCount ?? getUsableCpuCount()
  const spec = PHASE_MEMORY[taskType] ?? PHASE_MEMORY.default

  const budgetMB = Math.floor(availableMem * MEMORY_HEADROOM)

  // An explicit worker override is for humans who know their box; still clamp to >= 1.
  const envWorkers = parseInt(process.env.FAST_BUILD_WORKERS ?? '', 10)
  const requested = Number.isFinite(envWorkers) && envWorkers > 0 ? envWorkers : requestedWorkers

  const byMemory = Math.max(1, Math.floor(budgetMB / spec.minHeapMB))
  // `spec.workers` is a ceiling for phases whose worker is itself multi-threaded (tsgo saturates
  // several cores on its own), so it is capped by the CPU count but never drops below 2 -
  // one process alone leaves the pipeline serial. --force-workers still wins.
  const byCpu =
    spec.workers != null
      ? Math.max(2, Math.min(spec.workers, cpuCount))
      : Math.min(requested, cpuCount, spec.maxWorkers ?? cpuCount)
  const workers = Math.max(1, Math.min(byCpu, byMemory))

  // Split the budget across the workers we settled on. Never hand out more than the
  // budget even when that lands under minHeapMB - a ceiling above the cgroup limit is
  // what turns a recoverable in-process OOM into the kernel killing the whole build.
  const heapMB = Math.max(1, Math.min(spec.heapMB, Math.floor(budgetMB / workers)))

  return {
    workers,
    heapMB,
    availableMemoryMB: availableMem,
    budgetMB,
    cpuCount,
    limitedByMemory: byMemory < byCpu,
    // The heaviest packages of this phase are known to need more than this.
    belowSafeHeap: heapMB < spec.minHeapMB,
    minHeapMB: spec.minHeapMB
  }
}

/**
 * Calculate file hash for content comparison
 */
export function getFileHash (filePath: string): string | null {
  try {
    const content = readFileSync(filePath)
    return crypto.createHash('md5').update(content).digest('hex')
  } catch {
    return null
  }
}

/**
 * Recursively collect all files in a directory
 */
export function collectAllFiles (dir: string, result: string[] = []): string[] {
  if (!existsSync(dir)) return result

  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      collectAllFiles(fullPath, result)
    } else {
      result.push(fullPath)
    }
  }
  return result
}

/**
 * Sync directory from source to destination, only copying changed files
 */
export function syncDirectory (
  srcDir: string,
  destDir: string,
  options: SyncDirectoryOptions = {}
): SyncDirectoryResult {
  const { removeExtra = false, verbose = false } = options

  let copied = 0
  let unchanged = 0
  let removed = 0

  if (!existsSync(srcDir)) {
    return { copied, unchanged, removed }
  }

  if (!existsSync(destDir)) {
    mkdirSync(destDir, { recursive: true })
  }

  const srcFiles = collectAllFiles(srcDir)
  const destFiles = new Set(collectAllFiles(destDir).map((f) => relative(destDir, f)))

  for (const srcFile of srcFiles) {
    const relPath = relative(srcDir, srcFile)
    const destFile = join(destDir, relPath)

    // Remove from set to track extra files
    destFiles.delete(relPath)

    const srcHash = getFileHash(srcFile)
    const destHash = getFileHash(destFile)

    if (srcHash !== destHash) {
      const destFileDir = dirname(destFile)
      if (!existsSync(destFileDir)) {
        mkdirSync(destFileDir, { recursive: true })
      }

      copyFileSync(srcFile, destFile)
      copied++

      if (verbose) {
        console.log(`  Copied: ${relPath}`)
      }
    } else {
      unchanged++
    }
  }

  // Remove extra files in destination that don't exist in source
  if (removeExtra) {
    for (const extraFile of destFiles) {
      const fullPath = join(destDir, extraFile)
      try {
        rmSync(fullPath)
        removed++
        if (verbose) {
          console.log(`  Removed: ${extraFile}`)
        }
      } catch {
        // Ignore removal errors
      }
    }
  }

  return { copied, unchanged, removed }
}

/**
 * Clean a directory (remove it completely)
 */
export function cleanDirectory (dir: string): void {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true })
  }
}
