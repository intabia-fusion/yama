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

import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import type { YamaConfig } from './types.js'

export const CONFIG_FILE = 'yama.config.json'

const loaded = new Map<string, YamaConfig>()

// A missing file is an empty config; a broken one throws instead of dropping repo settings.
export function loadYamaConfig (rootDir: string): YamaConfig {
  const cached = loaded.get(rootDir)
  if (cached !== undefined) return cached
  const file = join(rootDir, CONFIG_FILE)
  let config: YamaConfig = {}
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf-8')) as YamaConfig
    } catch (err) {
      throw new Error(`${file}: ${(err as Error).message}`)
    }
  }
  loaded.set(rootDir, config)
  return config
}
