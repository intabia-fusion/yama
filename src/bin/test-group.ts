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

// Runs one test group across the workspace.
//
//   yama-test-group integration        every *.itest.ts  (needs tests/prepare-tests.sh)
//   yama-test-group bench              every *.bench.ts
//   yama-test-group integration -t X   jest flags pass through
//
// The unit group is not run here: it is the build phase (`pnpm test`).

import { spawnSync } from 'child_process'
import { join } from 'path'
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import {
  GROUPS,
  jestConfigPath,
  planTestRun,
  collectTestEntries,
  buildSharedConfig,
  findJestBin
} from '../build/libs/test-groups.js'
import { findWorkspaceRoot } from '../build/libs/workspace.js'
import type { TestEntry } from '../build/types.js'

const [group, ...jestArgs] = process.argv.slice(2)
if (GROUPS[group] === undefined || group === 'unit') {
  console.error(`usage: test-group.js <${Object.keys(GROUPS).filter((g) => g !== 'unit').join('|')}> [jest args]`)
  process.exit(2)
}

const foundRoot = findWorkspaceRoot()
if (foundRoot === null) {
  console.error('pnpm-workspace.yaml not found')
  process.exit(1)
}
const root: string = foundRoot
const entries = collectTestEntries(root, group)
if (entries.length === 0) {
  console.log(`No ${group} tests found`)
  process.exit(0)
}

// Only `testIsolated` matters here: the group's files are picked by name, so a package's own test
// script and its flags have no say. Everything else shares one jest.
const { shared, isolated } = planTestRun(entries)
const exclusive = entries.filter((e) => isolated.some((i) => i.exclusive && i.name === e.name))
// A package on another runner (packages/ui is vitest) has no jest.config.js to turn into a project;
// it runs its own script of the same name instead.
const ownScript = entries.filter((e) => jestConfigPath(e.cwd) === null)
const together = entries.filter((e) => !exclusive.includes(e) && !ownScript.includes(e))

const foundJest = findJestBin(entries)
if (foundJest == null) {
  console.error('jest not found in any workspace package; run pnpm install')
  process.exit(1)
}
const jestBin: string = foundJest

const dir = mkdtempSync(join(tmpdir(), `jest-${group}-`))
const flags = shared?.flags ?? ['--passWithNoTests', '--forceExit']

// One jest invocation over `packages`, as projects of a generated config.
function run (packages: TestEntry[], label: string): number {
  const { projects, testTimeout } = buildSharedConfig({ packages }, group)
  const configPath = join(dir, `${label}.config.js`)
  writeFileSync(configPath, `module.exports = ${JSON.stringify({ projects }, null, 2)}\n`)
  const args = ['-c', configPath, ...flags, ...jestArgs]
  if (testTimeout !== undefined) args.push(`--testTimeout=${testTimeout}`)
  // A single package runs on its own jest: pnpm keeps dependencies per package, so a jest resolved
  // from a sibling brings a ts-jest that cannot see this one's @types.
  const bin = (packages.length === 1 ? findJestBin(packages) : null) ?? jestBin
  return spawnSync(bin, args, { cwd: root, stdio: 'inherit' }).status ?? 1
}

let code = 0
if (together.length > 0) {
  console.log(`Running ${together.length} packages as one jest (${group})`)
  code = run(together, 'shared') || code
}
// These say they need the stand to themselves, so they get it: one at a time.
for (const pkg of exclusive) {
  console.log(`Running ${pkg.name} on its own (${group})`)
  code = run([pkg], pkg.name.replace(/[^\w.-]/g, '_')) || code
}
rmSync(dir, { recursive: true, force: true })

for (const pkg of ownScript) {
  const scripts = (JSON.parse(readFileSync(join(pkg.cwd, 'package.json'), 'utf-8')) as { scripts?: Record<string, string> })
    .scripts ?? {}
  if (scripts[group] === undefined) {
    console.log(`Skipping ${pkg.name}: no jest.config.js and no "${group}" script`)
    continue
  }
  console.log(`Running ${pkg.name} via its own "${group}" script`)
  code = (spawnSync('pnpm', ['run', group], { cwd: pkg.cwd, stdio: 'inherit' }).status ?? 1) || code
}
process.exit(code)
