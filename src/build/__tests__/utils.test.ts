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

import { describe, it, expect } from 'vitest'

import os from 'node:os'

import * as utils from '../libs/utils.js'
import type { WorkerCountInfo } from '../types.js'

// Real `vm_stat` output on Apple Silicon: the page size is 16384, not the 4096 the
// parser used to assume, so available memory was under-reported by a factor of four.
const VM_STAT_ARM64 = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages free:                               42000.
Pages active:                            900000.
Pages inactive:                           58000.
Pages speculative:                         3000.
Pages wired down:                        300000.
`

const VM_STAT_X86 = `Mach Virtual Memory Statistics: (page size of 4096 bytes)
Pages free:                              168000.
Pages active:                            900000.
Pages inactive:                          232000.
`

const MEMINFO = `MemTotal:       65805864 kB
MemFree:         2033120 kB
MemAvailable:   41943040 kB
Buffers:          123456 kB
`

describe('memory probes', () => {
  it('vm_stat page size is read from the header, not assumed', () => {
    // (42000 + 58000) pages * 16384 B = 1562.5 MiB
    expect(utils.parseDarwinVmStat(VM_STAT_ARM64)).toBe(1563)
  })

  it('vm_stat still parses the 4 KiB page size', () => {
    // (168000 + 232000) pages * 4096 B = 1562.5 MiB
    expect(utils.parseDarwinVmStat(VM_STAT_X86)).toBe(1563)
  })

  it('unparseable vm_stat output yields null rather than a wrong number', () => {
    expect(utils.parseDarwinVmStat('nonsense')).toBe(null)
  })

  // Regression: utils.js destructured readFileSync from child_process, so this branch
  // always threw and silently fell back to os.freemem().
  it('MemAvailable is read from /proc/meminfo', () => {
    expect(utils.parseLinuxMemInfo(MEMINFO)).toBe(40960)
  })

  it('meminfo without MemAvailable yields null', () => {
    expect(utils.parseLinuxMemInfo('MemTotal: 100 kB\n')).toBe(null)
  })

  it('getAvailableMemoryMB reports a plausible figure', () => {
    const mb = utils.getAvailableMemoryMB()
    expect(mb > 0, 'must be positive').toBeTruthy()
    expect(mb <= os.totalmem() / 1024 / 1024, 'must not exceed total RAM').toBeTruthy()
  })
})

describe('getOptimalWorkerCount', () => {
  const probe = (requested: number, taskType: string, availableMemoryMB: number, cpuCount = 16): WorkerCountInfo =>
    utils.getOptimalWorkerCount(requested, taskType, { availableMemoryMB, cpuCount })

  // Regression: a minWorkers floor of max(2, cpu/2) overrode the memory cap, so a machine
  // with 2 GB free still got 6 TypeScript workers and went OOM.
  it('never exceeds what available memory allows', () => {
    const r = probe(16, 'typescript', 2000)
    expect(r.workers <= 2, `expected <= 2 workers for 2000MB, got ${r.workers}`).toBeTruthy()
  })

  it('reports limitedByMemory only when memory actually capped the count', () => {
    const tight = probe(16, 'typescript', 2000)
    expect(tight.limitedByMemory).toBe(true)

    const roomy = probe(4, 'typescript', 64000)
    expect(roomy.workers).toBe(4)
    expect(roomy.limitedByMemory).toBe(false)
  })

  it('never returns fewer than one worker', () => {
    expect(probe(8, 'typescript', 10).workers).toBe(1)
  })

  it('honours an explicitly lower request', () => {
    expect(probe(1, 'typescript', 64000).workers).toBe(1)
  })

  it('caps TypeScript workers even on a large machine', () => {
    expect(probe(64, 'typescript', 512000, 64).workers <= 6).toBeTruthy()
  })

  it('never exceeds the CPU count', () => {
    expect(probe(64, 'bundle', 512000, 8).workers <= 8).toBeTruthy()
  })
})
