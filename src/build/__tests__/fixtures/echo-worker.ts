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

// Test double for GenericWorkerPool. Behaviour is driven by task.type.
import { parentPort, threadId } from 'worker_threads'

interface EchoTask {
  id: number
  type: string
  cwd?: string
  memoryMB?: number
}

parentPort?.on('message', (task: EchoTask) => {
  const { id, type } = task
  switch (type) {
    case 'exit':
      process.exit(0)
      break
    case 'ok':
      parentPort?.postMessage({ id, threadId, success: true, echo: task.cwd })
      break
    case 'fail':
      parentPort?.postMessage({ id, threadId, success: false, error: 'task refused' })
      break
    case 'heavy':
      // Report memory above the pool's recycle threshold to force a recycle.
      parentPort?.postMessage({ id, threadId, success: true, memoryMB: task.memoryMB ?? 9999 })
      break
    case 'crash':
      // Uncaught throw -> 'error' event on the parent side.
      setImmediate(() => {
        throw new Error('worker exploded')
      })
      break
    case 'die':
      // Non-zero exit -> 'exit' event on the parent side.
      process.exit(3)
      break
    default:
      parentPort?.postMessage({ id, threadId, success: true })
  }
})

parentPort?.postMessage({ type: 'ready', threadId })
