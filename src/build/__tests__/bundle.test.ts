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

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { runBundlePhase } from '../phases/bundle.js'
import { hashBundleDir } from '../phases/docker-build.js'
import type { DependencyGraph } from '../types.js'

describe('bundle environment', () => {
  it('embeds only configured values and invalidates bundle and image hashes when they change', async () => {
    const root = mkdtempSync(join(tmpdir(), 'yama-bundle-env-'))
    const cwd = join(root, 'pkg')
    mkdirSync(join(cwd, 'src'), { recursive: true })
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - pkg\n')
    writeFileSync(join(root, 'yama.config.json'), JSON.stringify({
      bundle: { standardScript: 'common/scripts/esbuild.js', defineEnv: ['YAMA_TEST_PUBLIC_KEY'] }
    }))
    writeFileSync(join(cwd, 'package.json'), JSON.stringify({ name: 'test-account', version: '1.0.0' }))
    writeFileSync(join(cwd, 'src/index.ts'), 'console.log(process.env.YAMA_TEST_PUBLIC_KEY, process.env.YAMA_TEST_SECRET)')
    const graph = new Map([['test-account', {
      project: { fullPath: cwd }, bundleScript: 'node ../../common/scripts/esbuild.js --entry=src/index.ts'
    }]]) as unknown as DependencyGraph
    process.env.YAMA_TEST_SECRET = 'private-value'
    try {
      process.env.YAMA_TEST_PUBLIC_KEY = 'first-key'
      const first = await runBundlePhase(graph, ['test-account'], 1, { packageHash: 'same-source' })
      const code = readFileSync(join(cwd, 'bundle/bundle.js'), 'utf8')
      const imageHash = hashBundleDir(cwd)
      expect(first.errors).toEqual([])
      expect(code).toContain('first-key')
      expect(code).not.toContain('private-value')
      expect((await runBundlePhase(graph, ['test-account'], 1, { packageHash: 'same-source' })).cacheHits).toBe(1)
      process.env.YAMA_TEST_PUBLIC_KEY = 'second-key'
      const second = await runBundlePhase(graph, ['test-account'], 1, { packageHash: 'same-source' })
      expect(second.errors).toEqual([])
      expect(second.cacheHits).toBe(0)
      expect(readFileSync(join(cwd, 'bundle/bundle.js'), 'utf8')).toContain('second-key')
      expect(hashBundleDir(cwd)).not.toBe(imageHash)
      delete process.env.YAMA_TEST_PUBLIC_KEY
      const unset = await runBundlePhase(graph, ['test-account'], 1, { packageHash: 'same-source' })
      expect(unset.errors).toEqual([])
      expect(unset.cacheHits).toBe(0)
      expect(readFileSync(join(cwd, 'bundle/bundle.js'), 'utf8')).toContain('process.env.YAMA_TEST_PUBLIC_KEY')
    } finally {
      delete process.env.YAMA_TEST_PUBLIC_KEY
      delete process.env.YAMA_TEST_SECRET
      rmSync(root, { recursive: true, force: true })
    }
  })
})
