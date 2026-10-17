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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import { join } from 'node:path'

import * as cache from '../libs/cache.js'

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'rig-cache-'))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function writePkg (files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel)
    fs.mkdirSync(join(full, '..'), { recursive: true })
    fs.writeFileSync(full, content)
  }
}

describe('calculatePackageHash', () => {
  it('changes when a src file changes', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1' })
    const h1 = cache.calculatePackageHash(dir)
    writePkg({ 'src/a.ts': 'export const a = 2' })
    expect(cache.calculatePackageHash(dir)).not.toBe(h1)
  })

  it('is stable when only mtime changes', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'export const a = 1' })
    const h1 = cache.calculatePackageHash(dir)
    const later = new Date(Date.now() + 60_000)
    fs.utimesSync(join(dir, 'src/a.ts'), later, later)
    expect(cache.calculatePackageHash(dir)).toBe(h1)
  })

  it('ignores files with non-source extensions', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'x' })
    const h1 = cache.calculatePackageHash(dir)
    writePkg({ 'src/notes.md': 'irrelevant' })
    expect(cache.calculatePackageHash(dir)).toBe(h1)
  })
})

describe('phase cache isolation', () => {
  it('marking one phase does not invalidate another', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'src/a.ts': 'x' })
    cache.markPhaseCompleted(dir, 'hash-transpile', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'hash-bundle', 'bundle', null, [])

    expect(cache.isPhaseCached(dir, 'hash-transpile', 'transpile', null, [])).toBe(true)
    expect(cache.isPhaseCached(dir, 'hash-bundle', 'bundle', null, [])).toBe(true)
  })

  it('a different hash for the same phase misses', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, [])
    expect(cache.isPhaseCached(dir, 'h2', 'validate', null, [])).toBe(false)
  })

  it('missing output directory invalidates the phase', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'types/index.d.ts': 'export {}' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, ['types'])
    expect(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types'])).toBe(true)

    fs.rmSync(join(dir, 'types'), { recursive: true })
    expect(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types'])).toBe(false)
  })

  it('modified output content invalidates the phase', () => {
    writePkg({ 'package.json': '{"name":"x"}', 'types/index.d.ts': 'export const a: 1' })
    cache.markPhaseCompleted(dir, 'h1', 'validate', null, ['types'])
    fs.writeFileSync(join(dir, 'types/index.d.ts'), 'export const a: 2')
    expect(cache.isPhaseCached(dir, 'h1', 'validate', null, ['types'])).toBe(false)
  })
})

describe('v1 -> v2 migration', () => {
  it('a v1 cache file is migrated and its phases stay valid', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    fs.writeFileSync(join(dir, '.fast-build-cache.json'), JSON.stringify({
      hash: 'shared',
      timestamp: 1,
      phases: { transpile: { completedAt: 1 }, bundle: { completedAt: 2 } }
    }))

    const loaded = cache.loadPackageCache(dir)
    expect(loaded?.version).toBe(2)
    expect(loaded?.phases.transpile.hash).toBe('shared')
    expect(loaded?.phases.bundle.hash).toBe('shared')
    expect(cache.isPhaseCached(dir, 'shared', 'transpile', null, [])).toBe(true)
  })

  it('an unrecognised cache file is discarded, not thrown on', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    fs.writeFileSync(join(dir, '.fast-build-cache.json'), '{ this is not json')
    expect(cache.loadPackageCache(dir)).toBe(null)
    expect(cache.isPhaseCached(dir, 'h', 'transpile', null, [])).toBe(false)
  })
})

describe('invalidatePhase', () => {
  // Regression: transpile used to call invalidateCache(), wiping the whole file and
  // destroying validate/lint/svelte-check/bundle/package/docker-build entries for the
  // entire downstream closure on any upstream change.
  it('drops only the named phase, leaving siblings intact', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h-t', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'h-v', 'validate', null, [])
    cache.markPhaseCompleted(dir, 'h-b', 'bundle', null, [])

    expect(typeof cache.invalidatePhase, 'invalidatePhase must be exported').toBe('function')
    cache.invalidatePhase(dir, 'transpile')

    expect(cache.isPhaseCached(dir, 'h-t', 'transpile', null, [])).toBe(false)
    expect(cache.isPhaseCached(dir, 'h-v', 'validate', null, [])).toBe(true)
    expect(cache.isPhaseCached(dir, 'h-b', 'bundle', null, [])).toBe(true)
  })

  it('invalidateCache still removes everything', () => {
    writePkg({ 'package.json': '{"name":"x"}' })
    cache.markPhaseCompleted(dir, 'h-t', 'transpile', null, [])
    cache.markPhaseCompleted(dir, 'h-v', 'validate', null, [])
    cache.invalidateCache(dir)
    expect(cache.isPhaseCached(dir, 'h-t', 'transpile', null, [])).toBe(false)
    expect(cache.isPhaseCached(dir, 'h-v', 'validate', null, [])).toBe(false)
  })
})

// Parity with the platform-rig implementation this port replaces; skipped when that checkout is absent.
const RIG_CACHE = '/Users/haiodo/Develop/private/foundation4/foundations/utils/packages/platform-rig/bin/libs/cache.js'

describe.skipIf(!fs.existsSync(RIG_CACHE))('hash parity with platform-rig', () => {
  const rig = fs.existsSync(RIG_CACHE)
    ? (createRequire(RIG_CACHE)(RIG_CACHE) as { calculatePackageHash: (path: string) => string })
    : null

  function makeWorkspace (withVersionFile: boolean): string {
    writePkg({
      'pnpm-workspace.yaml': 'packages:\n  - pkg\n',
      'yama.config.json': JSON.stringify({ hashFiles: ['common/scripts/version.txt'] }),
      'pkg/package.json': '{"name":"x"}',
      'pkg/tsconfig.json': '{}',
      'pkg/src/a.ts': 'export const a = 1',
      'pkg/tests/a.test.ts': 'export {}'
    })
    if (withVersionFile) writePkg({ 'common/scripts/version.txt': '1.2.3\n' })
    return join(dir, 'pkg')
  }

  it('matches RIG when version.txt exists', () => {
    const pkg = makeWorkspace(true)
    expect(cache.calculatePackageHash(pkg)).toBe(rig?.calculatePackageHash(pkg))
  })

  it('matches RIG when version.txt is missing', () => {
    const pkg = makeWorkspace(false)
    expect(cache.calculatePackageHash(pkg)).toBe(rig?.calculatePackageHash(pkg))
  })

  it('folds in the configured hash file', () => {
    const pkg = makeWorkspace(true)
    const before = cache.calculatePackageHash(pkg)
    writePkg({ 'common/scripts/version.txt': '1.2.4\n' })
    expect(cache.calculatePackageHash(pkg)).not.toBe(before)
  })
})
