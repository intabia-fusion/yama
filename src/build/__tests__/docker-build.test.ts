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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { hashBundleDir } from '../phases/docker-build.js'

describe('hashBundleDir', () => {
  // An image built from a truncated bundle.js carried the same label as a good one, so the cache never rebuilt it.
  it('follows bundle content, ignores source maps', () => {
    const cwd = mkdtempSync(join(tmpdir(), 'docker-build-'))
    expect(hashBundleDir(cwd)).toBe('')
    mkdirSync(join(cwd, 'bundle'))
    writeFileSync(join(cwd, 'bundle', 'bundle.js'), 'function parseIPv6Section(add')
    const truncated = hashBundleDir(cwd)
    writeFileSync(join(cwd, 'bundle', 'bundle.js.map'), '{}')
    expect(hashBundleDir(cwd)).toBe(truncated)
    writeFileSync(join(cwd, 'bundle', 'bundle.js'), 'function parseIPv6Section(address) {}')
    expect(hashBundleDir(cwd)).not.toBe(truncated)
    rmSync(cwd, { recursive: true })
  })
})
