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

import { Worker } from 'worker_threads'

import type {
  PendingPoolTask,
  PoolWorker,
  WorkerInbound,
  WorkerPoolOptions,
  WorkerPoolResult,
  WorkerResultBase,
  WorkerStats,
  WorkerTaskBase,
  WorkerTaskMessage
} from '../types.js'

const namedPools = new Map<string, GenericWorkerPool<WorkerTaskBase, WorkerResultBase>>()

export class GenericWorkerPool<TTask extends WorkerTaskBase = WorkerTaskMessage, TResult extends WorkerResultBase = WorkerResultBase> {
  size: number
  workers: Array<PoolWorker | null> = []
  available: PoolWorker[] = []
  pending: Array<PendingPoolTask<TTask, TResult>> = []
  taskId = 0
  callbacks = new Map<number, (result: TResult) => void>()
  workerPath: string
  workerMemory = new Map<number, unknown>()
  workerStats = new Map<number, WorkerStats>()
  taskTimings = new Map<number, { startedAt: number, workerId: number }>()
  workerOptions: WorkerPoolOptions['workerOptions']
  workerCurrentTask = new Map<number, number>()
  terminated = false
  recycleAfter: number // 0 = never recycle by count
  recycleMemoryMB: number // 0 = never recycle by memory
  workerTaskCount = new Map<number, number>()
  // A slot's generation increases on every (re)spawn. Events from a replaced worker
  // carry a stale generation and are ignored, so a dying worker cannot evict its successor.
  workerGeneration = new Map<number, number>()
  respawnCount = new Map<number, number>()
  maxRespawns: number

  constructor (size: number, workerPath: string, poolOptions: WorkerPoolOptions = {}) {
    this.size = size
    this.workerPath = workerPath
    this.workerOptions = poolOptions.workerOptions || {}
    this.recycleAfter = poolOptions.recycleAfter || 0
    this.recycleMemoryMB = poolOptions.recycleMemoryMB || 0
    this.maxRespawns = poolOptions.maxRespawns ?? 5
  }

  _spawnWorker (i: number): Promise<void> {
    const worker = new Worker(this.workerPath, this.workerOptions) as PoolWorker
    const generation = (this.workerGeneration.get(i) ?? 0) + 1
    this.workerGeneration.set(i, generation)
    const isCurrent = (): boolean => this.workerGeneration.get(i) === generation

    worker._workerId = i
    this.workerStats.set(i, { totalIdleTime: 0, totalWorkTime: 0, taskCount: 0, lastTaskCompletedAt: null })
    this.workerTaskCount.set(i, 0)

    const readyPromise = new Promise<void>((resolve) => {
      const onMessage = (msg: WorkerInbound): void => {
        if (msg.type === 'ready') {
          worker.off('message', onMessage)
          if (msg.memory) {
            this.workerMemory.set(i, msg.memory)
          }
          resolve()
        }
      }
      worker.on('message', onMessage)
      worker.on('error', () => resolve())
      worker.on('exit', () => resolve())
    })

    worker.on('message', (msg: WorkerInbound) => {
      if (msg.id !== undefined && isCurrent()) {
        const callback = this.callbacks.get(msg.id)
        if (callback !== undefined) {
          this.callbacks.delete(msg.id)
          callback(msg as unknown as TResult)
        }

        const timing = this.taskTimings.get(msg.id)
        if (timing !== undefined) {
          const completedAt = performance.now()
          const workTime = completedAt - timing.startedAt
          const stats = this.workerStats.get(timing.workerId)
          if (stats !== undefined) {
            stats.totalWorkTime += workTime
            stats.taskCount++
            stats.lastTaskCompletedAt = completedAt
          }
          this.taskTimings.delete(msg.id)
        }

        if (msg.memory && msg.threadId !== undefined) {
          this.workerMemory.set(msg.threadId, msg.memory.after || msg.memory)
        }

        const count = (this.workerTaskCount.get(i) || 0) + 1
        this.workerTaskCount.set(i, count)

        const memMB = msg.memoryMB || 0
        const needRecycle =
          (this.recycleAfter > 0 && count >= this.recycleAfter) ||
          (this.recycleMemoryMB > 0 && memMB >= this.recycleMemoryMB)

        if (needRecycle && !this.terminated) {
          this._recycleWorker(i).catch((err: unknown) => {
            console.error(err)
            process.exitCode = 1
          })
        } else {
          this.available.push(worker)
          this._processNext()
        }
      }
    })

    worker.on('error', (err: Error) => {
      if (!isCurrent()) return
      this._failWorkerTask(i, err)
    })

    worker.on('exit', (code: number) => {
      if (this.terminated || !isCurrent()) return
      if (code !== 0) {
        this._failWorkerTask(i, new Error(`Worker ${i} exited with code ${code}`))
      }
    })

    this.workers[i] = worker
    return readyPromise
  }

  async _recycleWorker (i: number): Promise<void> {
    const oldWorker = this.workers[i]
    if (!oldWorker) return
    // Spawning bumps the generation, so the old worker's exit event is ignored.
    this.workerTaskCount.set(i, 0)
    const ready = this._spawnWorker(i)
    try {
      oldWorker.postMessage({ type: 'exit' })
    } catch {}
    try {
      await oldWorker.terminate()
    } catch {}
    await ready
    if (this.terminated) return
    const fresh = this.workers[i]
    if (fresh) this.available.push(fresh)
    this._processNext()
  }

  async init (): Promise<void> {
    const readyPromises: Array<Promise<void>> = []
    for (let i = 0; i < this.size; i++) {
      readyPromises.push(this._spawnWorker(i))
    }
    await Promise.all(readyPromises)
    this.available = this.workers.filter((w): w is PoolWorker => w !== null).slice()
  }

  _failWorkerTask (workerId: number, err: Error): void {
    const taskId = this.workerCurrentTask.get(workerId)
    if (taskId !== undefined) {
      const callback = this.callbacks.get(taskId)
      this.callbacks.delete(taskId)
      this.taskTimings.delete(taskId)
      this.workerCurrentTask.delete(workerId)
      if (callback !== undefined) {
        callback({ success: false, error: err.message || String(err) } as unknown as TResult)
      }
    }

    const worker = this.workers[workerId]
    if (worker) {
      const idx = this.available.indexOf(worker)
      if (idx >= 0) this.available.splice(idx, 1)
      this.workers[workerId] = null
      try {
        worker.terminate().catch(() => {})
      } catch {}
    }
    if (this.terminated) return

    // A dead slot used to stay dead forever, so tasks queued afterwards never settled
    // and the build hung silently. Replace the worker instead, up to a sane cap.
    const respawns = this.respawnCount.get(workerId) ?? 0
    if (respawns < this.maxRespawns) {
      this.respawnCount.set(workerId, respawns + 1)
      this._spawnWorker(workerId)
        .then(() => {
          if (this.terminated) return
          const fresh = this.workers[workerId]
          if (fresh) {
            this.available.push(fresh)
            this._processNext()
          }
        })
        .catch(() => this._drainPendingIfDead())
      return
    }

    this._drainPendingIfDead()
  }

  // With no worker left alive, waiting tasks can only be failed - never left unsettled.
  _drainPendingIfDead (): void {
    if (this.workers.some((w) => w !== null)) return
    const pendingErr = 'All workers died, cannot process remaining tasks'
    while (this.pending.length > 0) {
      const { resolve } = this.pending.shift() as PendingPoolTask<TTask, TResult>
      resolve({ success: false, error: pendingErr } as unknown as WorkerPoolResult<TResult>)
    }
  }

  _processNext (): void {
    if (this.pending.length > 0 && this.available.length > 0) {
      const { task, resolve } = this.pending.shift() as PendingPoolTask<TTask, TResult>
      const worker = this.available.shift() as PoolWorker
      const workerId = worker._workerId
      const startedAt = performance.now()

      const stats = this.workerStats.get(workerId)
      if (stats !== undefined && stats.lastTaskCompletedAt !== null) {
        const idleTime = startedAt - stats.lastTaskCompletedAt
        stats.totalIdleTime += idleTime
      }

      this.taskTimings.set(task.id, { startedAt, workerId })
      this.workerCurrentTask.set(workerId, task.id)

      const wrappedResolve = (value: WorkerPoolResult<TResult>): void => {
        this.workerCurrentTask.delete(workerId)
        resolve(value)
      }

      this.callbacks.set(task.id, (result: TResult) => {
        if (result.success) {
          wrappedResolve(result as unknown as WorkerPoolResult<TResult>)
        } else {
          const error: unknown = result.error
          wrappedResolve({
            ...result,
            error: error instanceof Error ? error : new Error(result.error || 'Unknown error')
          } as unknown as WorkerPoolResult<TResult>)
        }
      })

      worker.postMessage(task)
    }
  }

  runTask (type: TTask['type'], cwd: string, options?: Omit<TTask, 'id' | 'type' | 'cwd'>): Promise<WorkerPoolResult<TResult>> {
    return new Promise((resolve, reject) => {
      // A terminated pool has no workers, so queueing here would never settle.
      if (this.terminated) {
        resolve({ success: false, error: new Error('Worker pool has been terminated') } as unknown as WorkerPoolResult<TResult>)
        return
      }
      const task = {
        id: ++this.taskId,
        type,
        cwd,
        ...options
      } as unknown as TTask
      this.pending.push({ task, resolve, reject })
      this._processNext()
    })
  }

  async terminate (): Promise<void> {
    this.terminated = true
    for (const worker of this.workers) {
      if (worker) {
        try {
          worker.postMessage({ type: 'exit' })
        } catch {}
      }
    }
    await Promise.all(
      this.workers.filter((w): w is PoolWorker => w !== null).map(async (w) => await w.terminate().catch(() => {}))
    )
    this.workers = []
    this.available = []
  }
}

export async function getNamedWorkerPool<
  TTask extends WorkerTaskBase = WorkerTaskMessage,
  TResult extends WorkerResultBase = WorkerResultBase
> (name: string, size: number, workerPath: string, poolOptions: WorkerPoolOptions = {}): Promise<GenericWorkerPool<TTask, TResult>> {
  let pool = namedPools.get(name)
  if (pool === undefined || pool.terminated) {
    pool = new GenericWorkerPool<WorkerTaskBase, WorkerResultBase>(size, workerPath, poolOptions)
    await pool.init()
    namedPools.set(name, pool)
  }
  return pool as unknown as GenericWorkerPool<TTask, TResult>
}

export async function terminateNamedWorkerPool (name: string): Promise<void> {
  const pool = namedPools.get(name)
  if (pool !== undefined) {
    await pool.terminate()
    namedPools.delete(name)
  }
}

export async function terminateWorkerPool (): Promise<void> {
  for (const [, pool] of namedPools) {
    await pool.terminate()
  }
  namedPools.clear()
}
