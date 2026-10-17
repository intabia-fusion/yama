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
import { BuildTaskQueue, TaskType } from '../libs/task-queue.js'
import type { DependencyGraph, PackageNode } from '../types.js'

function node (name: string): PackageNode {
  return {
    project: { name, path: name, fullPath: `/repo/${name}`, private: false },
    dependencies: new Set(),
    dependents: new Set(),
    phaseBuild: null,
    phaseTest: null,
    phaseBundle: null,
    phasePackage: null,
    phaseDockerBuild: null,
    phaseFormat: null,
    phaseSvelteCheck: null,
    bundleScript: null,
    packageScript: null,
    dockerBuildScript: null
  }
}

describe('BuildTaskQueue docker-build', () => {
  it('waits for bundle when the package has no package phase', () => {
    const graph: DependencyGraph = new Map([['pod', node('pod')]])
    const queue = new BuildTaskQueue(graph)
    queue.addTasks(TaskType.BUNDLE, ['pod'])
    queue.addTasks(TaskType.DOCKER_BUILD, ['pod'])

    expect(queue.isTaskReady(TaskType.DOCKER_BUILD, 'pod')).toBe(false)
    queue.completeTask(TaskType.BUNDLE, 'pod', { success: true })
    expect(queue.isTaskReady(TaskType.DOCKER_BUILD, 'pod')).toBe(true)
  })
})
