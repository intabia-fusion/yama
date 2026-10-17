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
import { join, relative, basename } from 'path'
import { createRequire } from 'module'
import { readFileSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'fs'
import type { ESLint as ESLintClass } from 'eslint'
import type * as PrettierModule from 'prettier'
import type * as TypeScriptModule from 'typescript'

import { loadYamaConfig } from '../config.js'
import { findWorkspaceRoot } from '../libs/workspace.js'
import type {
  EslintParserModule,
  EslintResolvedConfig,
  FormatPackageOptions,
  FormatPackageResult,
  FormatTaskMessage,
  WorkerExitMessage
} from '../types.js'

// typescript-estree switches to its "single run" host when CI=true, and that path hands us a
// program containing only the current file: type-aware rules then see no types and the parser
// reports phantom syntax errors. The watch host is what works, so ask for it explicitly.
process.env.TSESTREE_SINGLE_RUN ??= 'false'

// eslint and prettier are peer dependencies: the processed package's copy wins, yama's own is the fallback.
function loadFromPackage<T> (cwd: string, id: string): T {
  try {
    return createRequire(join(cwd, 'package.json'))(id) as T
  } catch {
    return createRequire(__filename)(id) as T
  }
}

const nodeRequire = createRequire(__filename)

const pluginCache = new Map<string, unknown>()

function resolvePluginFromCwd (pluginName: string, cwd: string): unknown {
  const key = `${cwd}::${pluginName}`
  if (pluginCache.has(key)) return pluginCache.get(key)
  try {
    const req = createRequire(join(cwd, 'noop.js'))
    const mod = req(pluginName) as unknown
    pluginCache.set(key, mod)
    return mod
  } catch {
    pluginCache.set(key, null)
    return null
  }
}

function resolvePluginList (plugins: unknown, cwd: string): unknown[] {
  if (!Array.isArray(plugins)) return []
  const result: unknown[] = []
  for (const p of plugins) {
    if (typeof p === 'string') {
      const mod = resolvePluginFromCwd(p, cwd)
      if (mod) result.push(mod)
    } else if (p) {
      result.push(p)
    }
  }
  return result
}

function clearParserCaches (cwd: string): void {
  try {
    const parser = resolvePluginFromCwd('@typescript-eslint/parser', cwd) as { clearCaches?: () => void } | null
    if (parser && typeof parser.clearCaches === 'function') parser.clearCaches()
  } catch {
    /* parser layout differs across versions; recycling still bounds memory */
  }
}

function collectSourceFiles (dir: string, result: string[] = []): string[] {
  if (!existsSync(dir)) return result
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const stat = lstatSync(full)
    // node_modules is never ours to format, and a symlink (a junction on Windows) would walk into it.
    if (entry === 'node_modules' || stat.isSymbolicLink()) continue
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

// A parse error says nothing on its own: report which parser eslint actually resolved, once
// per package, so a config that failed to reach the files is visible in the log.
async function reportParseDiag (
  eslint: ESLintClass,
  cwd: string,
  file: string,
  original: string,
  content: string,
  r: ESLintClass.LintResult
): Promise<void> {
  try {
    const resolved = (await eslint.calculateConfigForFile(file)) as EslintResolvedConfig
    const first = r.messages.find((m) => m.ruleId == null)
    const lines = content.split('\n')
    // Does the unformatted source parse? Separates a prettier problem from a parser one.
    let originalParseErrors: number | string = 'threw'
    try {
      const orig = await eslint.lintText(original, { filePath: file })
      originalParseErrors = orig[0].messages.filter((m) => m.ruleId == null).length
    } catch (e) {
      originalParseErrors = 'threw: ' + (e as Error).message
    }
    // Same parser, no program: tells whether parserOptions.project is what breaks it.
    let bareParse = 'ok'
    try {
      const p = nodeRequire(resolved.parser as string) as EslintParserModule
      p.parseForESLint(content, { filePath: file, sourceType: 'module', ecmaVersion: 2022, range: true, loc: true })
    } catch (e) {
      bareParse = 'threw: ' + (e as Error).message.slice(0, 120)
    }
    // What does the program built from parserOptions.project actually contain?
    let program: unknown = 'n/a'
    try {
      const p = nodeRequire(resolved.parser as string) as EslintParserModule
      const res = p.parseForESLint(content, {
        filePath: file,
        project: resolved.parserOptions?.project,
        tsconfigRootDir: resolved.parserOptions?.tsconfigRootDir ?? cwd,
        sourceType: 'module',
        ecmaVersion: 2022,
        range: true,
        loc: true
      })
      const prog = res.services?.program
      const sf = prog?.getSourceFile(file)
      program = {
        files: prog?.getSourceFiles?.().length ?? null,
        hasFile: sf != null,
        scriptKind: sf?.scriptKind ?? null,
        languageVersion: sf?.languageVersion ?? null,
        syntactic: sf != null ? prog?.getSyntacticDiagnostics(sf).length : null
      }
    } catch (e) {
      program = 'threw: ' + (e as Error).message.slice(0, 160)
    }
    // Read the tsconfig the way typescript-estree would, to see what the program is missing.
    let tsconfig: unknown = 'n/a'
    try {
      const ts = nodeRequire(nodeRequire.resolve('typescript', { paths: [cwd] })) as typeof TypeScriptModule
      const cfgPath = join(cwd, 'tsconfig.json')
      const read = ts.readConfigFile(cfgPath, ts.sys.readFile)
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, cwd)
      const prog = ts.createProgram(parsed.fileNames, parsed.options)
      tsconfig = {
        tsPath: nodeRequire.resolve('typescript', { paths: [cwd] }),
        version: ts.version,
        readError: read.error != null ? ts.flattenDiagnosticMessageText(read.error.messageText, ' ') : null,
        fileNames: parsed.fileNames.length,
        configErrors: parsed.errors.map((e) => ts.flattenDiagnosticMessageText(e.messageText, ' ')).slice(0, 3),
        programFiles: prog.getSourceFiles().length,
        defaultLib: ts.getDefaultLibFilePath(parsed.options),
        defaultLibExists: existsSync(ts.getDefaultLibFilePath(parsed.options))
      }
    } catch (e) {
      tsconfig = 'threw: ' + (e as Error).message.slice(0, 200)
    }
    let tsVersion = 'unknown'
    try {
      tsVersion = (
        nodeRequire(nodeRequire.resolve('typescript/package.json', { paths: [cwd] })) as { version: string }
      ).version
    } catch (e) {
      tsVersion = 'unresolved: ' + (e as Error).message
    }
    console.error(
      'PARSE-DIAG ' +
        JSON.stringify({
          file: relative(cwd, file),
          at: `${first?.line}:${first?.column}`,
          message: first?.message,
          line: (lines[(first?.line ?? 1) - 1] ?? '').slice(0, 200),
          prev: (lines[(first?.line ?? 1) - 2] ?? '').slice(0, 200),
          head: content.slice(0, 120),
          bytes: content.length,
          prettierChanged: content !== original,
          originalParseErrors,
          bareParse,
          program,
          tsconfig,
          tsVersion,
          parser: resolved.parser ?? '(eslint default)',
          project: resolved.parserOptions?.project,
          tsconfigRootDir: resolved.parserOptions?.tsconfigRootDir,
          ecmaVersion: resolved.parserOptions?.ecmaVersion,
          sourceType: resolved.parserOptions?.sourceType
        })
    )
  } catch (e) {
    console.error(`PARSE-DIAG ${relative(cwd, file)}: could not resolve config: ${(e as Error).message}`)
  }
}

/**
 * Format a package in-memory: for each file run prettier → eslint --fix via lintText,
 * then write to disk ONLY if final content differs from original. No intermediate
 * writes — webpack watchers never see half-formatted files.
 */
export async function formatPackage (cwd: string, options: FormatPackageOptions = {}): Promise<FormatPackageResult> {
  const { srcDir = 'src' } = options
  const srcPath = join(cwd, srcDir)
  const startedAt = Date.now()

  const files = collectSourceFiles(srcPath)
  if (files.length === 0) {
    return { success: true, changed: 0, total: 0, errors: [], memoryMB: 0, durationMs: Date.now() - startedAt }
  }

  const prettier = loadFromPackage<typeof PrettierModule>(cwd, 'prettier')
  const { ESLint } = loadFromPackage<{ ESLint: typeof ESLintClass }>(cwd, 'eslint')
  const resolvePluginsRelativeTo = pluginsDir(cwd)

  let eslint: ESLintClass | null = new ESLint({
    fix: true,
    cwd,
    cache: false,
    ...(resolvePluginsRelativeTo !== undefined ? { resolvePluginsRelativeTo } : {})
  })
  let parseReports = 0
  let errorReports = 0

  const errors: string[] = []
  let changedCount = 0
  let errorCount = 0
  let warningCount = 0
  let peakMB = 0
  let failingResults: ESLintClass.LintResult[] | null = null

  for (const file of files) {
    let original: string
    try {
      original = readFileSync(file, 'utf8')
    } catch (err) {
      errors.push(`${relative(cwd, file)}: read: ${(err as Error).message}`)
      continue
    }

    let content = original

    // prettier in memory
    try {
      const cfg = await prettier.resolveConfig(file)
      const info = await prettier.getFileInfo(file, { resolveConfig: false })
      if (info.ignored) {
        continue
      }
      const resolvedPlugins = resolvePluginList(cfg?.plugins, cwd)
      content = await prettier.format(original, {
        ...(cfg ?? {}),
        filepath: file,
        plugins: resolvedPlugins as PrettierModule.Options['plugins']
      })
    } catch (err) {
      errors.push(`${relative(cwd, file)}: prettier: ${(err as Error).message}`)
      content = original
    }

    // eslint --fix in memory
    try {
      const lintResults = await eslint.lintText(content, { filePath: file })
      const r = lintResults[0]
      if (parseReports < 3 && r?.messages.some((m) => m.ruleId == null)) {
        parseReports++
        await reportParseDiag(eslint, cwd, file, original, content, r)
      }
      if (r) {
        errorCount += r.errorCount
        warningCount += r.warningCount
        if (r.errorCount > 0 || r.warningCount > 0) {
          if (!failingResults) failingResults = []
          failingResults.push(r)
        }
        if (r.errorCount > 0 && errorReports < 3) {
          errorReports++
          const lines = content.split('\n')
          const first = r.messages.find((m) => m.severity === 2)
          const at = first?.line ?? 1
          console.error(
            'LINT-DIAG ' +
              JSON.stringify({
                file: relative(cwd, file),
                onDisk: original.split('\n').length,
                linted: lines.length,
                prettierChanged: content !== original,
                at: `${at}:${first?.column}`,
                rule: first?.ruleId,
                around: lines.slice(Math.max(0, at - 3), at + 2)
              })
          )
        }
        if (r.output !== undefined) content = r.output
      }
    } catch (err) {
      errors.push(`${relative(cwd, file)}: eslint: ${(err as Error).message}`)
    }

    // Single atomic write only if final content differs
    if (content !== original) {
      try {
        writeFileSync(file, content, 'utf8')
        changedCount++
      } catch (err) {
        errors.push(`${relative(cwd, file)}: write: ${(err as Error).message}`)
      }
    }

    const mb = Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
    if (mb > peakMB) peakMB = mb
  }

  let lintOutput = ''
  if (failingResults) {
    try {
      const formatter = await eslint.loadFormatter('stylish')
      lintOutput = await formatter.format(failingResults)
    } catch {}
  }

  eslint = null
  failingResults = null

  if (typeof prettier.clearConfigCache === 'function') {
    await prettier.clearConfigCache()
  }

  // @typescript-eslint/parser keeps every Program it built in a module-level cache.
  // Dropping it here frees the same memory a worker respawn did, without paying for
  // a new thread plus a fresh require of eslint/prettier/typescript on every 2nd package.
  clearParserCaches(cwd)

  return {
    success: errorCount === 0 && errors.length === 0,
    changed: changedCount,
    total: files.length,
    errors,
    errorCount,
    warningCount,
    lintOutput,
    hasLintErrors: errorCount > 0,
    memoryMB: peakMB,
    durationMs: Date.now() - startedAt
  }
}

if (parentPort != null) {
  const port = parentPort
  port.on('message', async (task: FormatTaskMessage | WorkerExitMessage) => {
    if (task.type === 'format') {
      const { id, cwd } = task
      try {
        const result = await formatPackage(cwd, { srcDir: task.srcDir || 'src' })
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
