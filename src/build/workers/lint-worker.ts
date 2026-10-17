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

import { parentPort, threadId } from 'worker_threads'
import { join, basename } from 'path'
import { createRequire } from 'module'
import { existsSync, readdirSync, lstatSync } from 'fs'
import type { ESLint as ESLintClass } from 'eslint'

import { loadYamaConfig } from '../config.js'
import { findWorkspaceRoot } from '../libs/workspace.js'
import type { LintPackageOptions, LintPackageResult, WorkerExitMessage, LintTaskMessage } from '../types.js'

// typescript-estree switches to its "single run" host when CI=true, and that path hands us a
// program containing only the current file: type-aware rules then see no types and the parser
// reports phantom syntax errors. The watch host is what works, so ask for it explicitly.
process.env.TSESTREE_SINGLE_RUN ??= 'false'

// eslint is a peer dependency: the processed package's copy wins, yama's own is the fallback.
function loadESLint (cwd: string): typeof ESLintClass {
  try {
    return (createRequire(join(cwd, 'package.json'))('eslint') as { ESLint: typeof ESLintClass }).ESLint
  } catch {
    return (createRequire(__filename)('eslint') as { ESLint: typeof ESLintClass }).ESLint
  }
}

function collectSourceFiles (dir: string, result: string[] = []): string[] {
  if (!existsSync(dir)) return result
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = lstatSync(full)
    if (stat.isDirectory()) {
      collectSourceFiles(full, result)
    } else {
      const name = basename(full)
      if (name.endsWith('.d.ts')) continue
      if (name.endsWith('.ts') || name.endsWith('.js') || name.endsWith('.svelte')) {
        result.push(full)
      }
    }
  }
  return result
}

// pnpm 12 does not reliably link plugins into every package, so plugin resolution is anchored to the
// configured plugins package, which declares them all and is a dependency of every package anyway.
function pluginsDir (cwd: string): string | undefined {
  const root = findWorkspaceRoot(cwd)
  const pluginsPackage = root == null ? undefined : loadYamaConfig(root).lint?.pluginsPackage
  if (pluginsPackage == null) return undefined
  // require.resolve cannot be used: the package.json may not be listed in its `exports`.
  const dir = join(cwd, 'node_modules', pluginsPackage)
  return existsSync(dir) ? dir : cwd
}

export async function lintPackage (cwd: string, options: LintPackageOptions = {}): Promise<LintPackageResult> {
  const { srcDir = 'src', chunkSize = 50, fix = false } = options
  const srcPath = join(cwd, srcDir)
  const startedAt = Date.now()

  const files = collectSourceFiles(srcPath)
  if (files.length === 0) {
    const memoryMB = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    return {
      success: true,
      errorCount: 0,
      warningCount: 0,
      total: 0,
      output: '',
      memoryMB,
      durationMs: Date.now() - startedAt
    }
  }

  const ESLint = loadESLint(cwd)
  const resolvePluginsRelativeTo = pluginsDir(cwd)

  // ESLint's own file cache skips unchanged files before parsing, so with everything
  // cached no TS Program gets built at all. Content strategy, because mtime changes on
  // every git checkout. The phase-level hash still covers dependency type changes,
  // which this cache cannot see.
  let eslint: ESLintClass | null = new ESLint({
    // Fixing rewrites files, so the file cache must not report them as already clean.
    fix,
    cache: !fix,
    cwd,
    ...(resolvePluginsRelativeTo !== undefined ? { resolvePluginsRelativeTo } : {}),
    cacheLocation: join(cwd, '.eslintcache'),
    cacheStrategy: 'content'
  })
  const formatter = await eslint.loadFormatter('stylish')

  let errorCount = 0
  let warningCount = 0
  let output = ''
  let peakMB = 0

  // Process files in chunks to cap memory: ESLint retains AST/messages for all lintFiles results.
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize)
    let results: ESLintClass.LintResult[] | null = await eslint.lintFiles(chunk)
    if (fix) await ESLint.outputFixes(results)
    for (const r of results) {
      errorCount += r.errorCount
      warningCount += r.warningCount
    }
    // Only keep formatted output for files with problems to avoid retaining massive strings
    const withProblems = results.filter((r) => r.errorCount > 0 || r.warningCount > 0)
    if (withProblems.length > 0) {
      output += await formatter.format(withProblems)
    }
    results = null
    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    if (mb > peakMB) peakMB = mb
  }

  eslint = null

  return {
    success: errorCount === 0,
    errorCount,
    warningCount,
    total: files.length,
    output,
    memoryMB: peakMB,
    durationMs: Date.now() - startedAt
  }
}

if (parentPort != null) {
  const port = parentPort
  port.on('message', async (task: LintTaskMessage | WorkerExitMessage) => {
    if (task.type === 'lint') {
      const { id, cwd } = task
      try {
        const result = await lintPackage(cwd, { srcDir: task.srcDir || 'src', fix: task.fix === true })
        port.postMessage({ id, threadId, ...result })
      } catch (err) {
        const e = err as Error
        port.postMessage({ id, threadId, success: false, error: e.stack || e.message || String(err) })
      }
    } else if (task.type === 'exit') {
      process.exit(0)
    }
  })

  port.postMessage({ type: 'ready', threadId })
}
