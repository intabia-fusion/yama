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

// Builds a throwaway pnpm workspace on disk: the tooling reads pnpm-workspace.yaml.

import * as fs from 'node:fs'
import * as os from 'node:os'
import { join, relative } from 'node:path'
import type { MiniPackageSpec, MiniRepo } from '../../types.js'

function write (root: string, rel: string, content: string): void {
  const full = join(root, rel)
  fs.mkdirSync(join(full, '..'), { recursive: true })
  fs.writeFileSync(full, content)
}

// Self-contained on purpose: the profiles of a real repo are not available here.
function tsconfig (extraCompilerOptions: Record<string, unknown> = {}): string {
  return JSON.stringify({
    compilerOptions: {
      target: 'ES2021',
      module: 'CommonJS',
      moduleResolution: 'bundler',
      strict: true,
      declaration: true,
      esModuleInterop: true,
      skipLibCheck: true,
      outDir: 'lib',
      declarationDir: 'types',
      rootDir: 'src',
      ...extraCompilerOptions
    },
    include: ['src/**/*.ts']
  }, null, 2)
}

export function createMiniRepo (packages: Record<string, MiniPackageSpec>): MiniRepo {
  const root = fs.mkdtempSync(join(os.tmpdir(), 'yama-mini-'))
  const projectFolders: string[] = []

  for (const [name, spec] of Object.entries(packages)) {
    const folder = name.replace(/^@[^/]+\//, '')
    const dir = join(root, 'packages', folder)
    fs.mkdirSync(dir, { recursive: true })

    const deps: Record<string, string> = {}
    for (const d of spec.deps ?? []) deps[d] = 'workspace:^1.0.0'

    write(root, join('packages', folder, 'package.json'), JSON.stringify({
      name,
      version: '1.0.0',
      main: 'lib/index.js',
      types: 'types/index.d.ts',
      dependencies: deps,
      scripts: spec.scripts ?? { '_phase:build': 'compile build' },
      ...spec.extraPkgJson
    }, null, 2))

    write(root, join('packages', folder, 'tsconfig.json'), tsconfig(spec.compilerOptions))

    for (const [rel, content] of Object.entries(spec.files ?? {})) {
      write(root, join('packages', folder, rel), content)
    }

    // Workspace dependencies resolve through node_modules symlinks, same as pnpm.
    for (const d of spec.deps ?? []) {
      const depFolder = d.replace(/^@[^/]+\//, '')
      const linkPath = join(dir, 'node_modules', d)
      fs.mkdirSync(join(linkPath, '..'), { recursive: true })
      fs.symlinkSync(join(root, 'packages', depFolder), linkPath, 'dir')
    }

    projectFolders.push(relative(root, dir))
  }

  write(root, 'pnpm-workspace.yaml', `packages:\n${projectFolders.map((p) => `  - '${p}'\n`).join('')}`)

  return {
    root,
    pkgDir: (name) => join(root, 'packages', name.replace(/^@[^/]+\//, '')),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true })
  }
}
