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

import { join } from 'path'
import {
  collectFiles,
  emitLib,
  emitSvelteDts,
  generateSvelteTypes,
  performESBuildWithSvelte,
  tscCompile
} from '../build/compile.js'

const args = process.argv.slice(2)

async function main (): Promise<void> {
  switch (args[0]) {
    case 'ui-esbuild': {
      console.log('Building UI package with Svelte support...')
      const st = performance.now()
      const filesToTranspile = collectFiles(join(process.cwd(), 'src'))

      try {
        await performESBuildWithSvelte(filesToTranspile, { cwd: process.cwd() })
        await generateSvelteTypes({ cwd: process.cwd() })
        console.log('UI build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
      } catch (err) {
        console.error('UI build failed:', err)
        process.exit(1)
      }
      break
    }

    // `ui` kept as an alias: UI packages ship sources, only declarations are emitted.
    case 'build-ui':
    case 'ui': {
      const st = performance.now()
      await tscCompile({ cwd: process.cwd(), emitDeclarationOnly: true })
      try {
        await emitSvelteDts(process.cwd())
        console.log('Build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
      } catch (err) {
        console.error('Svelte declarations failed:', err)
        process.exit(1)
      }
      break
    }

    case 'svelte-dts': {
      try {
        await emitSvelteDts(process.cwd())
      } catch (err) {
        console.error('Svelte declarations failed:', err)
        process.exit(1)
      }
      break
    }

    case 'build':
    default: {
      const st = performance.now()
      await tscCompile({ cwd: process.cwd(), emitDeclarationOnly: true })
      try {
        await emitLib(process.cwd())
        console.log('Build time:', Math.round((performance.now() - st) * 100) / 100, 'ms')
      } catch (err) {
        console.error('Build failed:', err)
        process.exit(1)
      }
      break
    }
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
