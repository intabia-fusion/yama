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

import { readFileSync, writeFileSync } from 'fs'

// Blink and V8 store a script source as UTF-16 if it has a single non-Latin-1 char, else as 8-bit.
// esbuild `charset: 'ascii'` leaves such chars in regex literals; this escapes the rest.
// eslint-disable-next-line no-control-regex
const nonLatin1 = /[^\x00-\xff]/g
const escapeChar = (c: string): string => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')

// Shifts sourcemap columns on the few lines it touches.
export function escapeNonLatin1File (file: string): void {
  const text = readFileSync(file, 'utf8')
  // eslint-disable-next-line no-control-regex
  if (!/[^\x00-\xff]/.test(text)) return
  writeFileSync(file, text.replace(nonLatin1, escapeChar))
}
