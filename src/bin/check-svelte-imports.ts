#!/usr/bin/env node
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

// webpack only warns about unresolved imports and missing exports, and dev/prod silences all
// warnings, so they ship as `undefined`. This bundles every .svelte file to report them.

import { spawnSync } from 'child_process'
import { readFileSync } from 'fs'
import { join, resolve, relative } from 'path'
import * as esbuild from 'esbuild'
import sveltePreprocess from 'svelte-preprocess'
import { preprocess, compile } from 'svelte/compiler'
import type { PreprocessorGroup } from 'svelte/compiler'
import { listWorkspaceProjects } from '../build/libs/workspace.js'
import type { CompiledSvelte, SvelteNamedImport } from '../build/types.js'

const EMPTY = ['.css', '.scss', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot', '.avif', '.mp3', '.wav', '.mp4', '.webm', '.txt']

// Same script handling as dev/prod; styles are dropped, they cannot affect imports.
const preprocessors: PreprocessorGroup[] = [
  { style: () => ({ code: '' }) },
  sveltePreprocess({ typescript: { compilerOptions: { verbatimModuleSyntax: true } } })
]

// esbuild stops before linking on the first unresolved import, and linking is where missing
// exports are found, so a failed resolve is recorded and the import left external.
function tolerateUnresolved (unresolved: string[], resolved: Map<string, string>): esbuild.Plugin {
  return {
    name: 'tolerate-unresolved',
    setup (build) {
      build.onResolve({ filter: /.*/ }, async (args) => {
        if (args.pluginData === 'retry' || args.kind === 'entry-point') return undefined
        const r = await build.resolve(args.path, { kind: args.kind, importer: args.importer, resolveDir: args.resolveDir, namespace: args.namespace, pluginData: 'retry' })
        if (r.errors.length === 0) {
          resolved.set(`${args.importer}\0${args.path}`, r.path)
          return undefined
        }
        unresolved.push(`${args.importer}: Could not resolve "${args.path}"`)
        return { path: args.path, external: true }
      })
    }
  }
}

const MISSING = /^No matching export in "([^"]+)" for import "([^"]+)"$/

// Only workspace projects: anything else has no installed dependencies to resolve against.
function listSvelteFiles (rootDir: string, paths: string[]): string[] {
  const dirs = paths.length > 0 ? paths : listWorkspaceProjects(rootDir).map((p) => p.path)
  const res = spawnSync('git', ['ls-files', '--', ...dirs.map((d) => `${d}/*.svelte`)], { cwd: rootDir, encoding: 'utf8' })
  if (res.status !== 0) throw new Error(res.stderr)
  return res.stdout.split('\n').filter(Boolean).map((f) => join(rootDir, f))
}

// Compiles components itself (instead of esbuild-svelte) to keep the JS for usedAsValue.
function svelteLoader (compiled: Map<string, CompiledSvelte>): esbuild.Plugin {
  return {
    name: 'svelte',
    setup (build) {
      build.onLoad({ filter: /\.svelte$/ }, async (args) => {
        const source = readFileSync(args.path, 'utf8')
        try {
          const { code } = await preprocess(source, preprocessors, { filename: args.path })
          const js = compile(code, { filename: args.path, css: 'external' }).js.code
          compiled.set(args.path, { source, js })
          return { contents: js, loader: 'js' }
        } catch (err) {
          const e = err as Error & { start?: { line?: number } }
          return { errors: [{ text: e.message, location: { file: args.path, line: e.start?.line ?? 0 } }] }
        }
      })
    }
  }
}

// Every `import { a as b } from 'spec'` as {name: 'a', local: 'b', spec, line}; line is 1-based.
function namedImports (code: string): SvelteNamedImport[] {
  const result: SvelteNamedImport[] = []
  const re = /import\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code)) !== null) {
    const line = code.slice(0, m.index).split('\n').length
    for (const s of m[1].split(',')) {
      const [name, local = name] = s.trim().replace(/^type\s+/, '').split(/\s+as\s+/)
      if (name !== '') result.push({ name, local, spec: m[2], line })
    }
  }
  return result
}

// esbuild's TS loader drops imports never used as a value, so what survives is a runtime use.
function usedAsValue (js: string, spec: string, local: string): boolean {
  return namedImports(esbuild.transformSync(js, { loader: 'ts' }).code).some((i) => i.spec === spec && i.local === local)
}

async function main (): Promise<void> {
  const args = process.argv.slice(2)
  const showTypes = args.includes('--types')
  const positional = args.filter((a) => !a.startsWith('-'))
  const rootDir = resolve(positional[0] ?? '.')
  const files = listSvelteFiles(rootDir, positional.slice(1))
  const st = performance.now()

  const unresolved: string[] = []
  const compiled = new Map<string, CompiledSvelte>()
  const resolved = new Map<string, string>()
  let messages: esbuild.Message[] = []
  try {
    const r = await esbuild.build({
      stdin: { contents: files.map((f) => `import ${JSON.stringify(f)}`).join('\n'), resolveDir: rootDir, loader: 'js' },
      bundle: true,
      write: false,
      logLevel: 'silent',
      logLimit: 0,
      platform: 'browser',
      format: 'esm',
      mainFields: ['svelte', 'browser', 'module', 'main'],
      conditions: ['svelte', 'browser', 'import'],
      resolveExtensions: ['.mjs', '.js', '.svelte', '.ts', '.json'],
      loader: Object.fromEntries(EMPTY.map((e) => [e, 'empty'])),
      plugins: [tolerateUnresolved(unresolved, resolved), svelteLoader(compiled)]
    })
    messages = r.errors
  } catch (err) {
    const failure = err as { errors?: esbuild.Message[] }
    if (failure.errors == null) throw err
    messages = failure.errors
  }

  // The bundle reaches into dependencies; report only on the files asked for.
  const checked = new Set(files)
  const errors = unresolved.filter((u) => checked.has(u.slice(0, u.indexOf(':')))).map((u) => relative(rootDir, u))
  const typeOnly: string[] = []
  for (const m of messages) {
    const file = m.location?.file != null ? resolve(rootDir, m.location.file) : null
    const missing = MISSING.exec(m.text)
    if (file != null && !checked.has(file)) continue
    const unit = file != null ? compiled.get(file) : undefined
    if (missing == null || unit === undefined) {
      errors.push(`${file != null ? relative(rootDir, file) + ':' + m.location?.line : '?'}: ${m.text}`)
      continue
    }
    const [, target, name] = missing
    const targetPath = resolve(rootDir, target)
    const imp = namedImports(unit.js).find((i) => i.name === name && resolved.get(`${file}\0${i.spec}`) === targetPath)
    // esbuild locations point into compiled code, so the line is looked up in the source.
    const line = imp != null ? namedImports(unit.source).find((i) => i.name === name && i.spec === imp.spec)?.line : undefined
    const at = `${relative(rootDir, file as string)}:${line ?? '?'}`
    if (imp == null || usedAsValue(unit.js, imp.spec, imp.local)) {
      errors.push(`${at}: "${name}" is not exported by ${target}`)
    } else {
      typeOnly.push(`${at}: "${name}" from ${target} is a type, import it with \`type\``)
    }
  }

  for (const e of errors) console.error(e)
  if (showTypes) for (const t of typeOnly) console.log(t)
  const typeFiles = new Set(typeOnly.map((t) => t.slice(0, t.indexOf(':'))))
  console.log(`\nChecked ${files.length} .svelte files in ${Math.round(performance.now() - st)}ms: ` +
    `${errors.length} error(s), ${typeOnly.length} type import(s) without \`type\` in ${typeFiles.size} file(s)` +
    (showTypes || typeOnly.length === 0 ? '' : ' (--types lists them)'))
  process.exit(errors.length > 0 ? 1 : 0)
}

main().catch((err: unknown) => {
  console.error(err)
  process.exit(1)
})
