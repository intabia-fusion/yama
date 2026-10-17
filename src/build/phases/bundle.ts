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

// For packages whose bundle script is the configured standard esbuild script, runs esbuild in-process.
// For others, falls back to the package's own bundle script.

import { execSync, spawn, spawnSync } from 'child_process'
import { createRequire } from 'module'
import { createHash } from 'crypto'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync } from 'fs'
import { join, resolve } from 'path'
import { performance } from 'perf_hooks'
import { loadYamaConfig } from '../config.js'
import { calculatePackageHash, isPhaseCached, markPhaseCompleted } from '../libs/cache.js'
import { escapeNonLatin1File } from '../libs/escape-non-latin1.js'
import { findWorkspaceRoot } from '../libs/workspace.js'
import type {
  BundleConfig,
  CommandError,
  DependencyGraph,
  EsbuildArgs,
  PhaseRunOptions,
  PhaseRunResults,
  PhaseStepResult
} from '../types.js'

const PNPM_CMD = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const nodeRequire = createRequire(__filename)

// Cache for get-model to avoid running it multiple times for the same package
// Key: packageName, value: { modelHash, pkgHash }
const getModelCache = new Map<string, { modelHash: string | null, pkgHash: string }>()

let cachedVersion: string | null = null
let cachedGitRevision: string | null = null
const cachedModelVersions = new Map<string, string>()

interface BundleContext {
  rootDir: string | null
  bundle: BundleConfig
}

function bundleContext (cwd: string): BundleContext {
  const rootDir = findWorkspaceRoot(cwd)
  return { rootDir, bundle: rootDir != null ? (loadYamaConfig(rootDir).bundle ?? {}) : {} }
}

// Read on first use so importing the module has no side effects.
function getModelVersion (ctx: BundleContext): string {
  const file = ctx.bundle.modelVersionFile
  if (file === undefined || ctx.rootDir === null) {
    console.error('[bundle-phase] Error: bundle.modelVersionFile is not set in yama.config.json')
    throw new Error('bundle.modelVersionFile is not set in yama.config.json')
  }
  const versionFilePath = join(ctx.rootDir, file)
  const cached = cachedModelVersions.get(versionFilePath)
  if (cached !== undefined) return cached
  try {
    const version = readFileSync(versionFilePath, 'utf8').trim()
    cachedModelVersions.set(versionFilePath, version)
    return version
  } catch (error) {
    console.error(`[bundle-phase] Error: version.txt not found at ${versionFilePath}`)
    console.error(`[bundle-phase] Please ensure ${file} exists`)
    throw new Error(`version.txt not found at ${versionFilePath}`, { cause: error })
  }
}

// Get hash of the model package's model.json or cache file
function getModelHash (ctx: BundleContext): string | null {
  if (ctx.bundle.modelPackage === undefined || ctx.rootDir === null) return null
  const modelsAllPath = resolve(ctx.rootDir, ctx.bundle.modelPackage)
  const modelsAllBundlePath = join(modelsAllPath, 'bundle', 'model.json')
  const modelsAllCachePath = join(modelsAllPath, '.fast-build-cache.json')
  try {
    // Try cache file first (more reliable, updated after successful build)
    if (existsSync(modelsAllCachePath)) {
      const cache = JSON.parse(readFileSync(modelsAllCachePath, 'utf8')) as { phases?: { bundle?: { hash?: string } } }
      if (cache.phases?.bundle?.hash) {
        return cache.phases.bundle.hash
      }
    }
    // Fallback to model.json content hash
    if (existsSync(modelsAllBundlePath)) {
      const content = readFileSync(modelsAllBundlePath, 'utf8')
      return createHash('sha256').update(content).digest('hex')
    }
    return null
  } catch {
    return null
  }
}

function getVersion (): string {
  if (cachedVersion !== null) return cachedVersion
  try {
    const stdout = execSync('git describe --tags --abbrev=0 --match="v*"').toString().trim()
    const rawVersion = stdout.replace('v', '').replace('s', '').split('.')
    if (rawVersion.length === 3) {
      const version = {
        major: parseInt(rawVersion[0]),
        minor: parseInt(rawVersion[1]),
        patch: parseInt(rawVersion[2])
      }
      cachedVersion = `${version.major}.${version.minor}.${version.patch}`
    } else {
      cachedVersion = '0.7.0'
    }
  } catch {
    cachedVersion = '0.7.0'
  }
  return cachedVersion
}

function getGitRevisionCached (): string {
  if (cachedGitRevision !== null) return cachedGitRevision
  try {
    cachedGitRevision = execSync('git describe --all --long').toString().trim()
  } catch {
    cachedGitRevision = ''
  }
  return cachedGitRevision
}

// Check if bundle script uses the configured standard esbuild script
export function isStandardEsbuild (bundleScript: string | null | undefined, standardScript?: string): boolean {
  if (!bundleScript || !standardScript) return false
  const hasCommonEsbuild = bundleScript.includes(standardScript)
  const hasRunnerBundle = /\b(?:rushx|pnpm run)\s+bundle\b/.test(bundleScript) && !bundleScript.includes('get-model')
  return hasCommonEsbuild && !hasRunnerBundle
}

// Check if script needs a get-model step
export function needsGetModel (bundleScript: string | null | undefined): boolean {
  if (!bundleScript) return false
  return /\b(?:rushx|pnpm run)\s+get-model\b/.test(bundleScript) || bundleScript.includes('get-model &&')
}

// Check if script has post-processing (&& node ... after esbuild)
export function hasPostProcessing (bundleScript: string | null | undefined): boolean {
  if (!bundleScript) return false
  const esbuildIndex = bundleScript.indexOf('esbuild.js')
  if (esbuildIndex === -1) return false
  const afterEsbuild = bundleScript.slice(esbuildIndex + 10)
  return /\s*&&\s*node\s/.test(afterEsbuild)
}

// Parse esbuild arguments from bundle script
export function parseEsbuildArgs (bundleScript: string, packagePath?: string, defaultExternal: string[] = []): EsbuildArgs {
  const args: EsbuildArgs = {
    entryPoint: 'src/index.ts',
    outdir: 'bundle',
    platform: 'node',
    minify: false,
    keepNames: true,
    sourcemap: false,
    logLevel: 'error',
    external: [...defaultExternal],
    define: {}
  }

  const argMatches = bundleScript.match(/--([\w-]+)(?:[:=]([^\s]+))?/g)
  if (argMatches) {
    for (const match of argMatches) {
      const fullMatch = match.slice(2)
      const eqIndex = fullMatch.search(/[:=]/)
      let key: string
      let value: string
      if (eqIndex === -1) {
        key = fullMatch
        value = ''
      } else {
        key = fullMatch.slice(0, eqIndex)
        value = fullMatch.slice(eqIndex + 1)
      }
      switch (key) {
        case 'entry':
        case 'entryPoint':
          args.entryPoint = value
          break
        case 'minify':
          args.minify = value !== 'false'
          break
        case 'keep-names':
          args.keepNames = value !== 'false'
          break
        case 'sourcemap':
          args.sourcemap = value
          break
        case 'external':
          if (value && !args.external.includes(value)) {
            args.external.push(value)
          }
          break
        case 'define':
          if (value) {
            args.define[value] = true
          }
          break
      }
    }
  }

  return args
}

type EsbuildModule = typeof import('esbuild')

// Run get-model script if it exists
async function runGetModel (cwd: string, bundleScript: string, packageName: string): Promise<PhaseStepResult> {
  const ctx = bundleContext(cwd)
  // Check cache first based on model hash and package hash
  const currentModelHash = getModelHash(ctx)
  const currentPkgHash = calculatePackageHash(cwd)
  const cacheKey = packageName || cwd

  const cached = getModelCache.get(cacheKey)
  if (cached && cached.modelHash === currentModelHash && cached.pkgHash === currentPkgHash) {
    // Model and package haven't changed, skip get-model
    return { success: true, fromCache: true }
  }

  // Check if bundle script explicitly calls get-model
  if (bundleScript && /\b(?:rushx|pnpm run)\s+get-model\b/.test(bundleScript)) {
    console.log(`    [get-model] Running get-model for ${cwd}`)
    try {
      execSync('pnpm run get-model', { cwd, stdio: 'pipe' })
      console.log('    [get-model] Completed')
      getModelCache.set(cacheKey, { modelHash: currentModelHash, pkgHash: currentPkgHash })
      return { success: true }
    } catch (error) {
      console.error('    [get-model] Error:', (error as Error).message)
      return { success: false, error }
    }
  }

  // Check if package has get-model script in package.json
  const packageJsonPath = join(cwd, 'package.json')
  if (!existsSync(packageJsonPath)) {
    return { success: true }
  }

  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      name?: string
      scripts?: Record<string, string>
    }
    const scripts = packageJson.scripts || {}

    if (scripts['get-model'] && !/\b(?:rushx|pnpm run)\s+get-model\b/.test(bundleScript ?? '')) {
      console.log(`    [get-model] Running for ${packageJson.name}`)

      const script = scripts['get-model']
      const esbuildMatch = script.match(/node\s+.*?esbuild\.js\s+(.*?)\s*&&/)

      if (esbuildMatch) {
        const esbuild = nodeRequire('esbuild') as EsbuildModule

        const args = parseEsbuildArgs(script, cwd, ctx.bundle.external)

        mkdirSync(join(cwd, args.outdir), { recursive: true })

        const define: Record<string, string> = {}
        const version = getVersion()
        if (version) {
          define['process.env.VERSION'] = `"${version}"`
        }

        if (args.define.MODEL_VERSION) {
          const modelVersion = getModelVersion(ctx)
          if (modelVersion) {
            define['process.env.MODEL_VERSION'] = modelVersion
          }
        }
        if (args.define.GIT_REVISION) {
          const revision = getGitRevisionCached()
          if (revision) {
            define['process.env.GIT_REVISION'] = JSON.stringify(revision)
          }
        }

        await esbuild.build({
          absWorkingDir: cwd,
          entryPoints: [args.entryPoint],
          bundle: true,
          platform: args.platform,
          outfile: join(args.outdir, 'bundle.js'),
          logLevel: args.logLevel,
          minify: args.minify,
          keepNames: args.keepNames,
          sourcemap: args.sourcemap as EsbuildSourcemap,
          external: args.external,
          define
        })

        // Stream to the file: model.json is megabytes and execSync would hit maxBuffer.
        const modelOut = openSync(join(cwd, args.outdir, 'model.json'), 'w')
        try {
          const res = spawnSync(process.execPath, [join(args.outdir, 'bundle.js')], {
            cwd,
            stdio: ['ignore', modelOut, 'inherit']
          })
          if (res.error != null) throw res.error
          if (res.status !== 0) throw new Error(`get-model exited with ${res.status}`)
        } finally {
          closeSync(modelOut)
        }

        console.log('    [get-model] Generated model.json')
      }

      getModelCache.set(cacheKey, { modelHash: currentModelHash, pkgHash: currentPkgHash })
      return { success: true }
    }
  } catch (error) {
    console.error('    [get-model] Error:', (error as Error).message)
    return { success: false, error }
  }

  return { success: true }
}

type EsbuildSourcemap = NonNullable<Parameters<EsbuildModule['build']>[0]>['sourcemap']

// Run esbuild directly
async function runEsbuildDirect (
  cwd: string,
  config: EsbuildArgs,
  bundleScript: string,
  packageName: string
): Promise<PhaseStepResult> {
  const esbuild = nodeRequire('esbuild') as EsbuildModule
  const ctx = bundleContext(cwd)

  // Run get-model first if needed
  if (bundleScript && needsGetModel(bundleScript)) {
    const getModelResult = await runGetModel(cwd, bundleScript, packageName)
    if (!getModelResult.success) {
      return getModelResult
    }
  }

  mkdirSync(join(cwd, config.outdir), { recursive: true })

  const define: Record<string, string> = {}
  const version = getVersion()
  if (version) {
    define['process.env.VERSION'] = `"${version}"`
  }

  if (config.define.MODEL_VERSION) {
    let modelVersion: string
    try {
      modelVersion = getModelVersion(ctx)
    } catch (error) {
      return { success: false, error }
    }
    if (modelVersion) {
      define['process.env.MODEL_VERSION'] = modelVersion
    }
  }
  if (config.define.GIT_REVISION) {
    const revision = getGitRevisionCached()
    if (revision) {
      define['process.env.GIT_REVISION'] = JSON.stringify(revision)
    }
  }

  try {
    await esbuild.build({
      absWorkingDir: cwd,
      entryPoints: [config.entryPoint],
      bundle: true,
      platform: config.platform,
      plugins: [
        {
          name: 'ignore-apache-arrow',
          setup (build) {
            build.onResolve({ filter: /^apache-arrow\/Arrow\.node$/ }, (args) => {
              return { path: args.path, namespace: 'ignore-arrow' }
            })
            build.onLoad({ filter: /.*/, namespace: 'ignore-arrow' }, () => {
              return { contents: 'module.exports = {};' }
            })
          }
        }
      ],
      outfile: join(config.outdir, 'bundle.js'),
      logLevel: config.logLevel,
      minify: config.minify,
      keepNames: config.keepNames,
      sourcemap: config.sourcemap as EsbuildSourcemap,
      external: config.external,
      define,
      charset: 'ascii'
    })
    if (ctx.bundle.escapeNonLatin1 === true) {
      escapeNonLatin1File(join(cwd, config.outdir, 'bundle.js'))
    }

    // Handle post-processing (e.g., models/all: && node ./bundle/bundle.js > ./bundle/model.json)
    if (bundleScript && hasPostProcessing(bundleScript)) {
      console.log(`    [post-process] Running post-processing for ${cwd}`)
      const esbuildIndex = bundleScript.indexOf('esbuild.js')
      const afterEsbuild = bundleScript.slice(esbuildIndex + 10)
      const postProcessMatch = afterEsbuild.match(/\s*&&\s*(node\s+.*)$/)
      if (postProcessMatch) {
        const postProcessCmd = postProcessMatch[1]
        execSync(postProcessCmd, { cwd, stdio: 'pipe' })
        console.log('    [post-process] Completed')
      }
    }

    return { success: true }
  } catch (error) {
    return { success: false, error }
  }
}

// Run the package's own `bundle` script (with optional arguments)
async function runBundleScript (cwd: string, bundleScript: string | null | undefined): Promise<PhaseStepResult> {
  return await new Promise((resolve) => {
    let args = ['run', 'bundle']
    if (bundleScript) {
      const argsMatch = bundleScript.match(/\b(?:rushx|pnpm run)\s+bundle\s+(.+)$/)
      if (argsMatch) {
        const extraArgs = argsMatch[1].trim().split(/\s+/)
        args = args.concat(extraArgs)
      }
    }

    const startTime = performance.now()
    const child = spawn(PNPM_CMD, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true
    })

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString()
    })

    child.on('close', (code) => {
      const time = performance.now() - startTime

      if (code === 0) {
        resolve({ success: true, time })
      } else {
        const error: CommandError = new Error(`Bundle failed with exit code ${code}`)
        error.stdout = stdout
        error.stderr = stderr
        resolve({ success: false, error, time })
      }
    })

    child.on('error', (err) => {
      resolve({ success: false, error: err })
    })
  })
}

function hasBundleOutput (cwd: string, bundleScript: string | null | undefined): boolean {
  const isStandard = isStandardEsbuild(bundleScript, bundleContext(cwd).bundle.standardScript)
  const bundleOutput = isStandard ? join(cwd, 'bundle', 'bundle.js') : join(cwd, 'bundle')
  return existsSync(bundleOutput)
}

export async function runBundlePhase (
  graph: DependencyGraph,
  packageNames: string[],
  concurrency: number,
  options: PhaseRunOptions = {}
): Promise<PhaseRunResults> {
  const { force = false, packageHash } = options
  const results: PhaseRunResults = {
    successCount: 0,
    cacheHits: 0,
    total: packageNames.length,
    errors: [],
    time: 0
  }

  const startTime = performance.now()

  async function bundlePackage (packageName: string): Promise<PhaseStepResult> {
    const node = graph.get(packageName)
    if (node === undefined) throw new Error(`Package not in graph: ${packageName}`)
    const cwd = node.project.fullPath
    const { standardScript, external } = bundleContext(cwd).bundle
    // Use phaseBundle (_phase:bundle) if it carries arguments after the bundle script,
    // otherwise use bundleScript (bundle) directly
    let bundleScript = node.bundleScript
    if (/\b(?:rushx|pnpm run)\s+bundle\b/.test(node.phaseBundle ?? '')) {
      const argsMatch = (node.phaseBundle as string).match(/\b(?:rushx|pnpm run)\s+bundle\s+(.+)$/)
      if (argsMatch && argsMatch[1].trim()) {
        bundleScript = node.bundleScript + ' ' + argsMatch[1].trim()
      }
    }

    // Skip "echo done" type scripts
    if (bundleScript?.startsWith('echo ')) {
      return { success: true, skipped: true }
    }

    // Check cache using pre-calculated package hash
    if (!force && packageHash) {
      if (isPhaseCached(cwd, packageHash, 'bundle', (pkgPath: string) => hasBundleOutput(pkgPath, bundleScript), ['bundle'])) {
        return { success: true, fromCache: true }
      }
    }

    let result: PhaseStepResult
    const isStandard = isStandardEsbuild(bundleScript, standardScript)
    // Check if we can use optimized esbuild
    if (isStandard) {
      const config = parseEsbuildArgs(bundleScript as string, cwd, external)
      console.log(`    [esbuild] ${packageName} - direct build`)
      result = await runEsbuildDirect(cwd, config, bundleScript as string, packageName)
    } else {
      console.log(`    [pnpm] ${packageName} - using its own bundle script`)
      result = await runBundleScript(cwd, bundleScript)
    }

    // esbuild has exited 0 after writing a truncated bundle.js, and the break only surfaced
    // as a SyntaxError inside the running container. Parse the output before caching it.
    if (result.success && isStandard) {
      const bundleFile = join(cwd, 'bundle', 'bundle.js')
      const check = spawnSync(process.execPath, ['--check', bundleFile], { stdio: 'pipe' })
      if (check.status !== 0) {
        const size = existsSync(bundleFile) ? statSync(bundleFile).size : 0
        return {
          success: false,
          error: new Error(`bundle.js is not parseable (${size} bytes): ${String(check.stderr).trim()}`)
        }
      }
    }

    if (result.success && packageHash) {
      markPhaseCompleted(cwd, packageHash, 'bundle', null, ['bundle'])
    }
    return result
  }

  const promises = packageNames.map(async (name) => {
    const result = await bundlePackage(name)
    if (result.success) {
      results.successCount++
      if (result.fromCache) results.cacheHits++
    } else {
      results.errors.push({ package: name, error: result.error })
    }
    return result
  })

  await Promise.all(promises)
  results.time = performance.now() - startTime

  return results
}
