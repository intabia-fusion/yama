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

import type { ColorizedError } from '../types.js'

export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  gray: '\x1b[90m'
}

export function color (text: string, colorCode: string): string {
  return `${colorCode}${text}${COLORS.reset}`
}

export function success (text: string): string {
  return color(text, COLORS.green)
}
export function error (text: string): string {
  return color(text, COLORS.red)
}
export function warn (text: string): string {
  return color(text, COLORS.yellow)
}
export function info (text: string): string {
  return color(text, COLORS.cyan)
}
export function dim (text: string): string {
  return color(text, COLORS.dim)
}
export function bold (text: string): string {
  return color(text, COLORS.bold)
}

// Highlights ERROR/FAILED keywords; the file path stays free of ANSI codes so terminals can link it.
export function colorizeErrorMessage (msg: string): ColorizedError {
  if (!msg) return { plain: msg, colored: msg }

  let plainPath = ''
  let coloredMsg = msg

  // Path with location info: /path/to/file.ts(17,3)
  const pathWithLocationRegex = /([/\w.~-]*\/[\w.~-]+\.\w+)\((\d+,\d+)\)/g
  const match = pathWithLocationRegex.exec(msg)

  if (match !== null) {
    plainPath = match[1] + '(' + match[2] + ')'
    coloredMsg = msg.replace(pathWithLocationRegex, (_m, path: string, location: string) => {
      return `${path}(${location})`
    })
  } else {
    const pathOnlyRegex = /([/\w.~-]+\/[\w.~-]+\.\w+)/g
    const pathMatch = pathOnlyRegex.exec(msg)
    if (pathMatch !== null) {
      plainPath = pathMatch[1]
    }
  }

  coloredMsg = coloredMsg.replace(/\b(ERROR|FAILED|failure)\b/gi, (m) => {
    return `\x1b[31m${m}\x1b[0m`
  })

  return { plain: plainPath, colored: coloredMsg }
}
