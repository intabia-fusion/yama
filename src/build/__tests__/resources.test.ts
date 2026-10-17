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

import * as utils from '../libs/utils.js'

describe('cgroup memory limit parsing', () => {
  // In a container os.totalmem() reports the HOST's RAM. Sizing pools from it is what
  // gets a CI job OOM-killed, so the cgroup limit has to win.
  it('reads a cgroup v2 byte limit', () => {
    expect(utils.parseCgroupBytes('4294967296\n')).toBe(4096)
  })

  it('treats "max" as no limit', () => {
    expect(utils.parseCgroupBytes('max\n')).toBe(null)
  })

  it('treats the v1 unlimited sentinel as no limit', () => {
    // cgroup v1 writes a huge number instead of "max".
    expect(utils.parseCgroupBytes('9223372036854771712')).toBe(null)
  })

  it('rejects junk and empty files', () => {
    expect(utils.parseCgroupBytes('')).toBe(null)
    expect(utils.parseCgroupBytes('not-a-number')).toBe(null)
    expect(utils.parseCgroupBytes('0')).toBe(null)
    expect(utils.parseCgroupBytes(null)).toBe(null)
  })
})

describe('cgroup cpu quota parsing', () => {
  it('reads a v2 quota/period pair', () => {
    expect(utils.parseCgroupCpuMax('200000 100000')).toBe(2)
  })

  it('rounds a fractional quota up to a whole core', () => {
    expect(utils.parseCgroupCpuMax('150000 100000')).toBe(2)
    expect(utils.parseCgroupCpuMax('50000 100000')).toBe(1)
  })

  it('treats "max" as unlimited', () => {
    expect(utils.parseCgroupCpuMax('max 100000')).toBe(null)
  })

  it('falls back to the default period when only a quota is given', () => {
    expect(utils.parseCgroupCpuMax('400000')).toBe(4)
  })

  it('rejects junk', () => {
    expect(utils.parseCgroupCpuMax('-1 100000')).toBe(null)
    expect(utils.parseCgroupCpuMax('abc def')).toBe(null)
    expect(utils.parseCgroupCpuMax(null)).toBe(null)
  })

  it('getUsableCpuCount returns at least one CPU', () => {
    expect(utils.getUsableCpuCount() >= 1).toBeTruthy()
  })
})

describe('worker sizing stays inside the memory budget', () => {
  const PHASES = ['typescript', 'svelte-check', 'format', 'lint', 'bundle', 'default']
  const BOXES = [
    { name: 'GH ubuntu-latest', availableMemoryMB: 14000, cpuCount: 4 },
    { name: 'GH large runner', availableMemoryMB: 28000, cpuCount: 8 },
    { name: '4GB container', availableMemoryMB: 4000, cpuCount: 2 },
    { name: '2GB container', availableMemoryMB: 2000, cpuCount: 2 },
    { name: '1GB container', availableMemoryMB: 1000, cpuCount: 1 },
    { name: '512MB container', availableMemoryMB: 512, cpuCount: 1 }
  ]

  for (const box of BOXES) {
    for (const phase of PHASES) {
      it(`${phase} on ${box.name} never exceeds its budget`, () => {
        const r = utils.getOptimalWorkerCount(16, phase, box)
        expect(r.workers >= 1, 'at least one worker').toBeTruthy()
        expect(r.workers <= box.cpuCount, `workers ${r.workers} must not exceed ${box.cpuCount} CPUs`).toBeTruthy()
        expect(r.workers * r.heapMB <= r.budgetMB, `${r.workers} x ${r.heapMB}MB = ${r.workers * r.heapMB}MB exceeds budget ${r.budgetMB}MB`).toBeTruthy()
      })
    }
  }

  it('budget leaves headroom below what is available', () => {
    const r = utils.getOptimalWorkerCount(4, 'typescript', { availableMemoryMB: 10000, cpuCount: 8 })
    expect(r.budgetMB < 10000, 'must not claim every free megabyte').toBeTruthy()
    expect(r.budgetMB > 7000, 'but must not be needlessly timid').toBeTruthy()
  })

  it('flags when a worker gets less heap than the heaviest package needs', () => {
    const tight = utils.getOptimalWorkerCount(4, 'svelte-check', { availableMemoryMB: 1500, cpuCount: 4 })
    expect(tight.belowSafeHeap).toBe(true)
    expect(tight.minHeapMB > tight.heapMB).toBeTruthy()

    const roomy = utils.getOptimalWorkerCount(4, 'svelte-check', { availableMemoryMB: 28000, cpuCount: 8 })
    expect(roomy.belowSafeHeap).toBe(false)
  })

  it('a tighter cgroup limit wins over the OS view', () => {
    const big = utils.getOptimalWorkerCount(16, 'typescript', { availableMemoryMB: 64000, cpuCount: 16 })
    const small = utils.getOptimalWorkerCount(16, 'typescript', { availableMemoryMB: 3000, cpuCount: 16 })
    expect(small.workers < big.workers, 'a memory-capped box must run fewer workers').toBeTruthy()
  })

  it('CPU quota caps workers even with plenty of memory', () => {
    const r = utils.getOptimalWorkerCount(16, 'bundle', { availableMemoryMB: 64000, cpuCount: 2 })
    expect(r.workers).toBe(2)
  })
})
