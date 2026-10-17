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

import type {
  BuildTaskQueueOptions,
  BuildTaskType,
  DependencyGraph,
  QueuedTask,
  TaskResultEntry,
  TaskTypeStats
} from '../types.js'

/**
 * Task types for the build pipeline
 */
export const TaskType = {
  TRANSPILE: 'transpile',
  VALIDATE: 'validate',
  LINT: 'lint',
  SVELTE_CHECK: 'svelte-check-task',
  BUNDLE: 'bundle',
  PACKAGE: 'package',
  DOCKER_BUILD: 'docker-build'
} as const satisfies Record<string, BuildTaskType>

const TASK_TYPES = Object.values(TaskType)

/**
 * Task queue for managing build pipeline tasks
 * Supports task chains with phase dependencies:
 *   transpile -> validate -> lint + svelte-check
 *   transpile -> bundle -> package -> docker-build
 *
 * lint/svelte-check for package X starts as soon as validate for package X completes.
 */
export class BuildTaskQueue {
  graph: DependencyGraph
  concurrency: number
  verbose: boolean

  // Task queues by type
  pending = new Map<BuildTaskType, Set<string>>()
  inProgress = new Map<BuildTaskType, Set<string>>()
  completed = new Map<BuildTaskType, Set<string>>()
  results = new Map<string, TaskResultEntry>()

  // Callbacks of workers waiting for a ready task
  readyCallbacks: Array<() => void> = []

  constructor (graph: DependencyGraph, options: BuildTaskQueueOptions = {}) {
    this.graph = graph
    this.concurrency = options.concurrency || 4
    this.verbose = options.verbose || false

    TASK_TYPES.forEach((type) => {
      this.pending.set(type, new Set())
      this.inProgress.set(type, new Set())
      this.completed.set(type, new Set())
    })
  }

  // The per-type sets are created for every TaskType in the constructor.
  private bucket (map: Map<BuildTaskType, Set<string>>, taskType: BuildTaskType): Set<string> {
    return map.get(taskType) as Set<string>
  }

  addTasks (taskType: BuildTaskType, packageNames: Iterable<string>): void {
    const pending = this.bucket(this.pending, taskType)
    for (const name of packageNames) {
      pending.add(name)
    }
  }

  /**
   * Check if a task is ready to run (all dependencies completed)
   */
  isTaskReady (taskType: BuildTaskType, packageName: string): boolean {
    const node = this.graph.get(packageName)
    if (node === undefined) return false

    const deps = this.getTaskDependencies(taskType, packageName)
    if (deps === null) return false

    const completed = this.bucket(this.completed, taskType)
    return deps.every((dep) => completed.has(dep))
  }

  /**
   * Helper: check if packageName has a task of given type registered
   */
  _hasTask (taskType: BuildTaskType, packageName: string): boolean {
    return (
      this.bucket(this.pending, taskType).has(packageName) ||
      this.bucket(this.inProgress, taskType).has(packageName) ||
      this.bucket(this.completed, taskType).has(packageName)
    )
  }

  private _registeredDeps (taskType: BuildTaskType, dependencies: Set<string>): string[] {
    return [...dependencies].filter(
      (dep) =>
        this.bucket(this.pending, taskType).has(dep) ||
        this.bucket(this.inProgress, taskType).has(dep) ||
        this.bucket(this.completed, taskType).has(dep)
    )
  }

  /**
   * Get dependencies for a specific task type
   * Returns array of package names that must complete first, or null if prerequisite phase not done
   */
  getTaskDependencies (taskType: BuildTaskType, packageName: string): string[] | null {
    const node = this.graph.get(packageName)
    if (node === undefined) return []

    // For transpile/validate/bundle: dependencies are tasks of the same type
    if (taskType === TaskType.TRANSPILE || taskType === TaskType.VALIDATE || taskType === TaskType.BUNDLE) {
      return this._registeredDeps(taskType, node.dependencies)
    }

    // For lint and svelte-check: must wait for validate of SAME package to complete first.
    // No cross-package dependencies - these packages are independent.
    if (taskType === TaskType.LINT || taskType === TaskType.SVELTE_CHECK) {
      if (this._hasTask(TaskType.VALIDATE, packageName)) {
        if (!this.bucket(this.completed, TaskType.VALIDATE).has(packageName)) {
          return null // validate not done yet for this package
        }
      }
      return []
    }

    // For package: dependencies are package tasks + bundle must be complete for this package
    if (taskType === TaskType.PACKAGE) {
      const packageDeps = this._registeredDeps(TaskType.PACKAGE, node.dependencies)
      if (this._hasTask(TaskType.BUNDLE, packageName)) {
        if (!this.bucket(this.completed, TaskType.BUNDLE).has(packageName)) {
          return null // Not ready, bundle not complete
        }
      }
      return packageDeps
    }

    // For docker-build: dependencies are docker-build tasks + package must be complete
    if (taskType === TaskType.DOCKER_BUILD) {
      const dockerDeps = this._registeredDeps(TaskType.DOCKER_BUILD, node.dependencies)
      if (this._hasTask(TaskType.PACKAGE, packageName)) {
        if (!this.bucket(this.completed, TaskType.PACKAGE).has(packageName)) {
          return null // Not ready, package not complete
        }
      }
      return dockerDeps
    }

    return []
  }

  /**
   * Get next ready task for a worker, or null if no tasks ready.
   *
   * Checks ALL task types and returns any ready task, allowing parallel execution
   * of independent tasks across phases.
   */
  getNextTask (): QueuedTask | null {
    const priorityOrder: BuildTaskType[] = [
      TaskType.TRANSPILE,
      TaskType.VALIDATE,
      TaskType.LINT,
      TaskType.SVELTE_CHECK,
      TaskType.BUNDLE,
      TaskType.PACKAGE,
      TaskType.DOCKER_BUILD
    ]

    let totalInProgress = 0
    for (const taskType of priorityOrder) {
      totalInProgress += this.bucket(this.inProgress, taskType).size
    }

    if (totalInProgress >= this.concurrency) {
      return null
    }

    const readyTasks: Array<QueuedTask & { priority: number }> = []

    for (const taskType of priorityOrder) {
      const pending = this.bucket(this.pending, taskType)

      for (const packageName of pending) {
        const deps = this.getTaskDependencies(taskType, packageName)
        if (deps === null) continue // Not ready, prerequisite not complete

        const completed = this.bucket(this.completed, taskType)
        if (deps.every((dep) => completed.has(dep))) {
          readyTasks.push({ taskType, packageName, priority: priorityOrder.indexOf(taskType) })
        }
      }
    }

    if (readyTasks.length > 0) {
      // Lower index = higher priority
      readyTasks.sort((a, b) => a.priority - b.priority)

      const selected = readyTasks[0]

      this.bucket(this.pending, selected.taskType).delete(selected.packageName)
      this.bucket(this.inProgress, selected.taskType).add(selected.packageName)

      return { taskType: selected.taskType, packageName: selected.packageName }
    }

    return null
  }

  completeTask (taskType: BuildTaskType, packageName: string, result: unknown): void {
    const inProgress = this.bucket(this.inProgress, taskType)
    const completed = this.bucket(this.completed, taskType)

    inProgress.delete(packageName)
    completed.add(packageName)

    this.results.set(`${taskType}:${packageName}`, { taskType, packageName, result })

    // Notify waiting workers
    this.readyCallbacks.forEach((cb) => cb())
  }

  isTaskTypeComplete (taskType: BuildTaskType): boolean {
    return this.bucket(this.pending, taskType).size === 0 && this.bucket(this.inProgress, taskType).size === 0
  }

  isAllComplete (): boolean {
    return TASK_TYPES.every((type) => this.isTaskTypeComplete(type))
  }

  /**
   * Wait for a task to become available
   */
  async waitForTask (): Promise<QueuedTask> {
    return await new Promise((resolve) => {
      const callback = (): void => {
        const task = this.getNextTask()
        if (task !== null) {
          const index = this.readyCallbacks.indexOf(callback)
          if (index > -1) this.readyCallbacks.splice(index, 1)
          resolve(task)
        }
      }
      this.readyCallbacks.push(callback)

      // Check immediately in case task is already available
      const task = this.getNextTask()
      if (task !== null) {
        const index = this.readyCallbacks.indexOf(callback)
        if (index > -1) this.readyCallbacks.splice(index, 1)
        resolve(task)
      }
    })
  }

  getStats (): Record<string, TaskTypeStats> {
    const stats: Record<string, TaskTypeStats> = {}
    TASK_TYPES.forEach((type) => {
      stats[type] = {
        pending: this.bucket(this.pending, type).size,
        inProgress: this.bucket(this.inProgress, type).size,
        completed: this.bucket(this.completed, type).size
      }
    })
    return stats
  }
}
