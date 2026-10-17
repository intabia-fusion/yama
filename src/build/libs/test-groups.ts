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

// Most packages can run as projects of a single jest invocation, which pays the ~2s jest bootstrap
// once instead of once per package. A few cannot, and say so themselves.

import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { createRequire } from 'module'
import { listWorkspaceProjects, findWorkspaceRoot } from './workspace.js'
import type {
  IsolatedTestPackage,
  JestProjectConfig,
  SharedJestConfig,
  TestEntry,
  TestGroupSpec,
  TestRunPlan,
  TestVerdict
} from '../types.js'

// Three groups, told apart by file name so no config or package.json field has to list them:
//   unit         *.test.ts / *.spec.ts   - no docker, runs in the build phase
//   integration  *.itest.ts              - needs the stand from tests/prepare-tests.sh
//   bench        *.bench.ts              - run by hand
// `*.itest.ts` and `*.bench.ts` deliberately do not match a package's default testMatch
// (`+(spec|test)` cannot decompose `itest`), so a rename alone takes a file out of the unit run.
export const GROUPS: Record<string, TestGroupSpec> = {
  unit: { file: /\.(test|spec)\.(ts|js|tsx|jsx)$/ },
  integration: { file: /\.itest\.(ts|js|tsx|jsx)$/, testMatch: ['**/?(*.)itest.[jt]s?(x)'], testTimeout: 300000 },
  bench: { file: /\.bench\.(ts|js|tsx|jsx)$/, testMatch: ['**/?(*.)bench.[jt]s?(x)'], testTimeout: 600000 }
}

// Either spelling of the config; love-agent is CommonJS in an ESM-typed package.
export function jestConfigPath (dir: string): string | null {
  for (const name of ['jest.config.js', 'jest.config.cjs']) {
    const path = join(dir, name)
    if (existsSync(path)) return path
  }
  return null
}

// A package with no test file at all is not worth a jest project, nor a jest process.
export function hasTestFiles (dir: string, group = 'unit'): boolean {
  const TEST_FILE = GROUPS[group].file
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name === '.svelte-check') continue
    if (e.isDirectory()) {
      if (hasTestFiles(join(dir, e.name), group)) return true
    } else if (TEST_FILE.test(e.name)) {
      return true
    }
  }
  return false
}

// Every workspace package that has tests, as planTestRun wants them.
export function collectTestEntries (
  rootDir: string | null = findWorkspaceRoot(),
  group = 'unit'
): TestEntry[] {
  return listWorkspaceProjects(rootDir)
    .filter((p) => hasTestFiles(p.fullPath, group))
    .map((p) => ({ name: p.name, cwd: p.fullPath }))
}

// Process-wide flags that are safe to apply to everyone in the shared run.
const SHARED_FLAGS = new Set(['--passWithNoTests', '--silent', '--forceExit'])
// Coverage is per-run, not per-project. No package sets a coverageThreshold and CI does not read
// the reports, so the shared run drops it; `pnpm test --no-test-group` still collects it.
const DROPPED_FLAGS = new Set(['--coverage'])

function classify (entry: TestEntry): TestVerdict {
  const pkgJsonPath = join(entry.cwd, 'package.json')
  if (!existsSync(pkgJsonPath)) return { isolated: 'no package.json' }
  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8')) as { testIsolated?: boolean, scripts?: { test?: string } }

  if (pkg.testIsolated === true) return { isolated: 'testIsolated in package.json', exclusive: true }

  const script = pkg.scripts?.test
  if (script == null) return { isolated: 'no test script' }
  const parts = script.trim().split(/\s+/)
  if (parts[0] !== 'jest') return { isolated: 'test script is not jest' }

  const flags: string[] = []
  for (const p of parts.slice(1)) {
    if (SHARED_FLAGS.has(p)) flags.push(p)
    else if (DROPPED_FLAGS.has(p)) continue
    else return { isolated: `unsupported flag ${p}` }
  }

  const configPath = jestConfigPath(entry.cwd)
  if (configPath === null) return { isolated: 'no jest.config.js' }
  // jest does not nest: a config that is itself a multi-project cannot become one of our projects.
  if (/\bprojects\s*:/.test(readFileSync(configPath, 'utf-8'))) return { isolated: 'config uses projects' }

  return { flags }
}

// jest validates a project config against the project schema, where these are not allowed: they
// belong to the run as a whole. Left in place they only produce "Unknown option" warnings and are
// ignored, so the shared run strips them and lifts what it can to the top level.
const GLOBAL_ONLY_KEYS = [
  'collectCoverage',
  'coverageDirectory',
  'coverageReporters',
  'coveragePathIgnorePatterns',
  'coverageProvider',
  'forceExit',
  'testTimeout',
  'bail',
  'verbose',
  'silent',
  'maxWorkers',
  'notify',
  'notifyMode',
  'reporters',
  'watchman'
]

/**
 * Turns the planned packages into an inline `projects` array: each package's own config with the
 * run-wide keys removed, an explicit rootDir, and its name as displayName so jest's output says
 * which package a test came from.
 */
export function buildSharedConfig (shared: { packages: TestEntry[] }, group = 'unit'): SharedJestConfig {
  const projects: JestProjectConfig[] = []
  let testTimeout: number | undefined
  for (const pkg of shared.packages) {
    const raw = createRequire(__filename)(jestConfigPath(pkg.cwd) as string) as JestProjectConfig | (() => JestProjectConfig)
    const config: JestProjectConfig = { ...(typeof raw === 'function' ? raw() : raw) }
    // A per-project timeout cannot survive, but the longest one can stand for the whole run.
    if (typeof config.testTimeout === 'number') {
      testTimeout = Math.max(testTimeout ?? 0, config.testTimeout)
    }
    for (const key of GLOBAL_ONLY_KEYS) delete config[key]
    // ts-jest looks for tsconfig.json on its own and silently falls back to its defaults
    // (moduleResolution node10, which TS 6 rejects) when it misses. Point it at the package's own.
    const tsconfig = join(pkg.cwd, 'tsconfig.json')
    if (config.preset === 'ts-jest' && config.transform === undefined && existsSync(tsconfig)) {
      config.transform = { '^.+\\.[cm]?[jt]sx?$': ['ts-jest', { tsconfig }] }
    }
    // A group other than unit picks its files by name, so the package's own matcher is replaced.
    const match = GROUPS[group].testMatch
    if (match !== undefined) {
      delete config.testRegex
      config.testMatch = match
      testTimeout = Math.max(testTimeout ?? 0, GROUPS[group].testTimeout ?? 0)
    }
    projects.push({ ...config, rootDir: pkg.cwd, displayName: pkg.name })
  }
  return { projects, testTimeout }
}

export function planTestRun (entries: TestEntry[]): TestRunPlan {
  const packages: TestEntry[] = []
  const flags = new Set<string>()
  const isolated: IsolatedTestPackage[] = []
  for (const entry of entries) {
    const verdict = classify(entry)
    if ('isolated' in verdict) {
      isolated.push({ name: entry.name, reason: verdict.isolated, exclusive: verdict.exclusive === true })
      continue
    }
    packages.push(entry)
    for (const f of verdict.flags) flags.add(f)
  }
  // A shared run of one buys nothing over running that package directly.
  if (packages.length < 2) {
    return {
      shared: null,
      isolated: isolated.concat(packages.map((p) => ({ name: p.name, reason: 'nothing to share with', exclusive: false })))
    }
  }
  return { shared: { packages, flags: [...flags] }, isolated }
}

// jest lives in each package's own node_modules; the shared run uses the first one that has it.
export function findJestBin (packages: TestEntry[]): string | null {
  for (const p of packages) {
    const bin = join(p.cwd, 'node_modules', '.bin', 'jest')
    if (existsSync(bin)) return bin
  }
  return null
}
