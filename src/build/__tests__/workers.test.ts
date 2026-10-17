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

import { describe, it, expect, afterEach } from 'vitest'
import { join } from 'node:path'

import { GenericWorkerPool, getNamedWorkerPool, terminateWorkerPool } from '../libs/workers.js'
import type { WorkerPoolOptions, WorkerResultBase, WorkerTaskBase } from '../types.js'

// worker_threads needs a JS file, so the compiled fixture is loaded (run `tsc` before the tests).
const WORKER = join(__dirname, '../../../lib/build/__tests__/fixtures/echo-worker.js')
const T = 10_000

interface EchoResult extends WorkerResultBase {
  echo?: string
}

type EchoPool = GenericWorkerPool<WorkerTaskBase, EchoResult>

let pool: EchoPool | null = null

function create (size: number, options?: WorkerPoolOptions): EchoPool {
  pool = new GenericWorkerPool<WorkerTaskBase, EchoResult>(size, WORKER, options)
  return pool
}

afterEach(async () => {
  if (pool) {
    await pool.terminate().catch(() => {})
    pool = null
  }
  await terminateWorkerPool().catch(() => {})
})

// Any hang in the pool shows up as this helper rejecting instead of the whole run stalling.
async function withDeadline<T> (promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms)
  })
  return await Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

describe('GenericWorkerPool', () => {
  it('runs queued tasks across workers', async () => {
    const p = create(2)
    await p.init()

    const results = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map(c => p.runTask('ok', c))
    )
    expect(results.map(r => r.echo).sort()).toEqual(['a', 'b', 'c', 'd', 'e'])
  }, T)

  it('a failing task resolves with an Error, it does not reject', async () => {
    const p = create(1)
    await p.init()

    const r = await p.runTask('fail', 'x')
    expect(r.success).toBe(false)
    expect(r.error instanceof Error).toBeTruthy()
  }, T)

  // Regression: _failWorkerTask set workers[i] = null forever. Tasks submitted after the
  // last worker died were pushed to `pending` and never settled — the build hung with no output.
  it('recovers after a worker crashes and keeps serving tasks', async () => {
    const p = create(1)
    await p.init()

    const crashed = await withDeadline(p.runTask('crash', 'boom'), T / 2, 'crash task to settle')
    expect(crashed.success).toBe(false)

    const after = await withDeadline(p.runTask('ok', 'still-alive'), T / 2, 'task after crash')
    expect(after.success).toBe(true)
    expect(after.echo).toBe('still-alive')
  }, T)

  it('recovers after a worker exits with a non-zero code', async () => {
    const p = create(1)
    await p.init()

    const died = await withDeadline(p.runTask('die', 'bye'), T / 2, 'die task to settle')
    expect(died.success).toBe(false)

    const after = await withDeadline(p.runTask('ok', 'respawned'), T / 2, 'task after exit')
    expect(after.success).toBe(true)
  }, T)

  // Regression: _recycleWorker put a fresh worker in slot i while the OLD worker's 'exit'
  // event (non-zero after terminate()) then ran _failWorkerTask(i) and nulled the NEW one.
  // With format.js's recycleAfter: 2 the pool silently shrank towards zero and then hung.
  it('recycling does not shrink the pool', async () => {
    const p = create(2, { recycleAfter: 1 })
    await p.init()

    for (let i = 0; i < 12; i++) {
      const r = await withDeadline(p.runTask('ok', `t${i}`), T / 2, `task ${i} after recycles`)
      expect(r.success, `task ${i} must complete`).toBe(true)
    }
    expect(p.workers.filter((w) => w !== null).length, 'pool must still hold 2 workers').toBe(2)
  }, T)

  it('recycling by memory threshold also keeps the pool intact', async () => {
    const p = create(2, { recycleMemoryMB: 100 })
    await p.init()

    for (let i = 0; i < 8; i++) {
      const r = await withDeadline(p.runTask('heavy', `m${i}`), T / 2, `heavy task ${i}`)
      expect(r.success).toBe(true)
    }
    expect(p.workers.filter((w) => w !== null).length).toBe(2)
  }, T)

  it('tasks submitted to a terminated pool settle instead of hanging', async () => {
    const p = create(1)
    await p.init()
    await p.terminate()

    const r = await withDeadline(p.runTask('ok', 'late'), T / 2, 'task on terminated pool')
    expect(r.success).toBe(false)
    pool = null
  }, T)
})

describe('shared named pool singleton', () => {
  // Regression: a terminated pool stayed in the registry, so the next lookup handed back
  // a pool with zero workers and every task hung.
  it('getNamedWorkerPool returns a live pool after terminateWorkerPool', async () => {
    const first = await getNamedWorkerPool<WorkerTaskBase, EchoResult>('probe', 1, WORKER)
    await terminateWorkerPool()

    const second = await getNamedWorkerPool<WorkerTaskBase, EchoResult>('probe', 1, WORKER)
    expect(second, 'a terminated pool must not be handed out again').not.toBe(first)
    expect(second.terminated).toBe(false)
    await terminateWorkerPool()
  }, T)
})
