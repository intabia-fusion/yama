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
import { dirname, join } from 'path'
import type { TscRunOptions, TscRunResult, TypeScriptDriver } from '../types.js'

/**
 * Resolve the native TypeScript 7 `tsc` binary.
 */
export function resolveTsc7 (): string {
  if (process.env.TSC7_BIN != null && process.env.TSC7_BIN !== '') {
    return process.env.TSC7_BIN
  }
  // Skip the `bin/tsc` node shim: it costs ~90ms of node startup per package.
  const ts7 = dirname(require.resolve('typescript7/package.json'))
  const platformPkg = `@typescript/typescript-${process.platform}-${process.arch}`
  const exeDir = join(dirname(require.resolve(`${platformPkg}/package.json`, { paths: [ts7] })), 'lib')
  return join(exeDir, process.platform === 'win32' ? 'tsc.exe' : 'tsc')
}

function run (options: TscRunOptions): Promise<TscRunResult> {
  return new Promise((resolve) => {
    const args = ['-p', options.project, '--tsBuildInfoFile', options.tsBuildInfoFile]
    if (options.emitDeclarationOnly) args.push('--emitDeclarationOnly')
    if (options.noCheck) args.push('--noCheck')
    let out = ''
    const append = (d: Buffer): void => {
      out += d
    }
    const child = spawn(resolveTsc7(), args, { cwd: options.cwd })
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    child.on('error', (err) => {
      resolve({ success: false, out: '', error: err.message })
    })
    child.on('close', (code) => {
      if (code === 0) resolve({ success: true, out, exitCode: 0 })
      else resolve({ success: false, out, exitCode: code ?? 1, error: out.trim() !== '' ? out.trim() : `tsc exited with ${code}` })
    })
  })
}

const tsc7Driver: TypeScriptDriver = { name: 'tsc7', run }

export function getTypeScriptDriver (): TypeScriptDriver {
  return tsc7Driver
}
