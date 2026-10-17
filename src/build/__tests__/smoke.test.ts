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
import * as fs from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

import { createMiniRepo } from './fixtures/mini-repo.js'
import type { MiniRepo } from '../types.js'

// CLI only, no imports of yama internals: YAMA_BIN points the same scenarios at another implementation.
const COMPILE_ALL = process.env.YAMA_BIN ?? join(__dirname, '../../..', 'lib/bin/compile-all.js')
const T = 120_000

let repo: MiniRepo | null = null

afterEach(() => {
  repo?.cleanup()
  repo = null
})

// compile-all calls process.exit, so it is driven as a child process.
// Warnings go to stderr, so both streams are folded into `out`.
function compileAll (root: string, args: string[]): { code: number, out: string } {
  const r = COMPILE_ALL.endsWith('.js')
    ? spawnSync(process.execPath, [COMPILE_ALL, root, ...args], { encoding: 'utf8' })
    : spawnSync(COMPILE_ALL, [root, ...args], { encoding: 'utf8' })
  return { code: r.status ?? -1, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

function mini (packages: Parameters<typeof createMiniRepo>[0]): MiniRepo {
  repo = createMiniRepo(packages)
  return repo
}

const TWO_PACKAGES = {
  '@mini/core': { files: { 'src/index.ts': 'export const answer = 42\n' } },
  '@mini/app': {
    deps: ['@mini/core'],
    files: { 'src/index.ts': "import { answer } from '@mini/core'\nexport const shown = String(answer)\n" }
  }
}

describe('compile-all end to end', () => {
  it('emits JS and declarations in dependency order', () => {
    const r = mini(TWO_PACKAGES)
    const { code, out } = compileAll(r.root, ['--validate', '--parallel', '2'])

    expect(code, out).toBe(0)
    expect(fs.existsSync(join(r.pkgDir('@mini/core'), 'lib', 'index.js'))).toBe(true)
    expect(fs.existsSync(join(r.pkgDir('@mini/core'), 'types', 'index.d.ts'))).toBe(true)
    expect(fs.existsSync(join(r.pkgDir('@mini/app'), 'types', 'index.d.ts'))).toBe(true)
  }, T)

  it('a second run serves every package from cache', () => {
    const r = mini(TWO_PACKAGES)
    expect(compileAll(r.root, ['--validate', '--parallel', '2']).code).toBe(0)

    const second = compileAll(r.root, ['--validate', '--parallel', '2'])
    expect(second.code, second.out).toBe(0)
    expect(second.out).toMatch(/\(2 from cache\)/)
  }, T)

  it('a type error fails the run with a non-zero exit code', () => {
    const r = mini({
      '@mini/core': { files: { 'src/index.ts': 'export const answer: number = "not a number"\n' } }
    })
    const { code, out } = compileAll(r.root, ['--validate', '--parallel', '1'])
    expect(code).not.toBe(0)
    expect(out).toMatch(/TS2322/)
  }, T)

  // A package sees a dependency only through its emitted .d.ts. Keying on the dependency's
  // sources rebuilt the whole downstream closure for edits that changed no public API.
  it('a dependency edit that does not change its .d.ts leaves dependents cached', () => {
    const r = mini({
      '@mini/core': {
        files: { 'src/index.ts': 'function helper (): number {\n  return 42\n}\nexport function answer (): number {\n  return helper()\n}\n' }
      },
      '@mini/app': {
        deps: ['@mini/core'],
        files: { 'src/index.ts': "import { answer } from '@mini/core'\nexport const shown = String(answer())\n" }
      }
    })
    expect(compileAll(r.root, ['--validate', '--parallel', '2']).code).toBe(0)

    // Body-only change: the emitted declaration for `answer` is identical.
    fs.writeFileSync(
      join(r.pkgDir('@mini/core'), 'src', 'index.ts'),
      'function helper (): number {\n  return 43\n}\nexport function answer (): number {\n  return helper()\n}\n'
    )
    const second = compileAll(r.root, ['--validate', '--parallel', '2'])

    expect(second.code, second.out).toBe(0)
    expect(second.out, '@mini/app must come from cache').toMatch(/\(1 from cache\)/)
  }, T)

  it('changing a dependency rebuilds its dependents', () => {
    const r = mini(TWO_PACKAGES)
    expect(compileAll(r.root, ['--validate', '--parallel', '2']).code).toBe(0)

    fs.writeFileSync(join(r.pkgDir('@mini/core'), 'src', 'index.ts'), 'export const answer = 43\n')
    const second = compileAll(r.root, ['--validate', '--parallel', '2'])

    expect(second.code, second.out).toBe(0)
    expect(second.out).not.toMatch(/\(2 from cache\)/)
  }, T)

  // Regression: the build phase called invalidateCache() on any upstream change, deleting the whole
  // .fast-build-cache.json and with it every other phase's entry for the entire downstream closure.
  it('an upstream change keeps unrelated phase cache entries', () => {
    const r = mini(TWO_PACKAGES)
    expect(compileAll(r.root, ['--validate', '--parallel', '2']).code).toBe(0)

    // Cache file format v2: { version: 2, phases: { <phase>: { hash, completedAt, outputHash } } }
    const cacheFile = join(r.pkgDir('@mini/app'), '.fast-build-cache.json')
    const cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    cache.phases['docker-build'] = { hash: 'docker-hash', completedAt: Date.now(), outputHash: null }
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2))

    fs.writeFileSync(join(r.pkgDir('@mini/core'), 'src', 'index.ts'), 'export const answer = 44\n')
    expect(compileAll(r.root, ['--validate', '--parallel', '2']).code).toBe(0)

    const after = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
    expect(after.phases['docker-build']?.hash, 'build must invalidate only its own phase entry').toBe('docker-hash')
  }, T)

  // Regression: strict string equality on phase scripts dropped packages without a word.
  it('warns about a build script it cannot run instead of skipping it silently', () => {
    const r = mini({
      '@mini/core': { files: { 'src/index.ts': 'export const answer = 42\n' } },
      '@mini/wasm': {
        scripts: { '_phase:build': 'wasm && node esbuild.config.js' },
        files: { 'src/index.ts': 'export const w = 1\n' }
      }
    })
    const { out } = compileAll(r.root, ['--parallel', '1'])
    expect(out, 'the skipped package must be named in the output').toMatch(/@mini\/wasm/)
    expect(out).toMatch(/unrecognised|unknown|not recognized/i)
  }, T)

  // index <-> utils cycle with a default import.
  const CYCLE = {
    '@mini/cycle': {
      compilerOptions: { incremental: true, isolatedModules: true },
      files: {
        'src/index.ts': "export * from './utils'\nconst plugin = { name: 'mini' }\nexport default plugin\n",
        'src/utils.ts': "import plugin from './index'\nexport function pluginName (): string {\n  return plugin.name\n}\n"
      }
    }
  }

  // index.js first: utils.js then sees it half-loaded, which is where a mixed lib breaks.
  function loadPluginName (dir: string): string {
    const r = spawnSync(process.execPath, ['-e', "console.log(require('./lib/index.js').pluginName())"], { cwd: dir, encoding: 'utf8' })
    return (r.stdout ?? '').trim() + (r.stderr ?? '')
  }

  it('lib is written by esbuild only, tsc emits declarations', () => {
    const r = mini(CYCLE)
    const { code, out } = compileAll(r.root, ['--parallel', '1'])
    expect(code, out).toBe(0)

    const dir = r.pkgDir('@mini/cycle')
    for (const f of ['index.js', 'utils.js']) {
      expect(fs.readFileSync(join(dir, 'lib', f), 'utf8'), `${f} emitted by tsc`).not.toMatch(/__createBinding|__importDefault/)
    }
    expect(fs.existsSync(join(dir, 'types', 'utils.d.ts'))).toBe(true)
    expect(loadPluginName(dir)).toBe('mini')
  }, T)

  // Regression: tsc's incremental state re-emitted only index.js over an esbuild lib/, and the
  // esbuild utils.js snapshotted the half-loaded tsc index.js without `default`.
  it('a docker esbuild emit between builds does not leave a mixed lib', () => {
    const r = mini(CYCLE)
    const dir = r.pkgDir('@mini/cycle')
    expect(compileAll(r.root, ['--parallel', '1']).code).toBe(0)
    expect(compileAll(r.root, ['--parallel', '1', '--esbuild-emit']).code).toBe(0)

    fs.writeFileSync(join(dir, 'src', 'index.ts'), "export * from './utils'\nconst plugin = { name: 'mini' }\nexport const extra = 1\nexport default plugin\n")
    const { code, out } = compileAll(r.root, ['--parallel', '1'])
    expect(code, out).toBe(0)

    expect(loadPluginName(dir)).toBe('mini')
  }, T)

  // Regression: esbuild read ./src only, so the sanity packages (rootDir ./tests) got no lib/ at all.
  it('esbuild emits from the tsconfig rootDir', () => {
    const r = mini({
      '@mini/tests': {
        files: {
          'tsconfig.json': JSON.stringify({
            compilerOptions: { module: 'CommonJS', strict: true, declaration: true, skipLibCheck: true, rootDir: './tests', outDir: 'lib', declarationDir: 'types' },
            include: ['tests/**/*.ts']
          }),
          'tests/index.ts': "export * from './model/page'\n",
          'tests/model/page.ts': 'export const page = 1\n'
        }
      }
    })
    const { code, out } = compileAll(r.root, ['--parallel', '1'])
    expect(code, out).toBe(0)

    const dir = r.pkgDir('@mini/tests')
    expect(fs.existsSync(join(dir, 'lib', 'index.js'))).toBe(true)
    expect(fs.existsSync(join(dir, 'lib', 'model', 'page.js'))).toBe(true)
  }, T)

  it('--to restricts the run to a package and its dependencies', () => {
    const r = mini({
      ...TWO_PACKAGES,
      '@mini/other': { files: { 'src/index.ts': 'export const other = 1\n' } }
    })
    const { code, out } = compileAll(r.root, ['--validate', '--parallel', '2', '--to', '@mini/app'])

    expect(code, out).toBe(0)
    expect(fs.existsSync(join(r.pkgDir('@mini/other'), 'lib')), '@mini/other must not be built').toBe(false)
  }, T)

  it('--list reports counts without building', () => {
    const r = mini(TWO_PACKAGES)
    const { code, out } = compileAll(r.root, ['--validate', '--list'])

    expect(code, out).toBe(0)
    expect(out).toMatch(/Build: 2/)
    expect(fs.existsSync(join(r.pkgDir('@mini/core'), 'lib')), '--list must not produce output').toBe(false)
  }, T)
})
