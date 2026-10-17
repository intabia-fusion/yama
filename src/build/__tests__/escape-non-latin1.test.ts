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

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { escapeNonLatin1File } from '../libs/escape-non-latin1.js'

describe('escapeNonLatin1File', () => {
  it('escapes chars above U+00FF and keeps Latin-1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'escape-'))
    const file = join(dir, 'bundle.js')
    writeFileSync(file, 'const a = /я/; const b = "é"')
    escapeNonLatin1File(file)
    expect(readFileSync(file, 'utf8')).toBe('const a = /\\u044f/; const b = "é"')
    rmSync(dir, { recursive: true })
  })

  it('leaves a Latin-1 file untouched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'escape-'))
    const file = join(dir, 'bundle.js')
    writeFileSync(file, 'const b = "é"')
    escapeNonLatin1File(file)
    expect(readFileSync(file, 'utf8')).toBe('const b = "é"')
    rmSync(dir, { recursive: true })
  })
})
