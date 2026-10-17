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

// Unified package hash calculation and per-phase caching for the fast build.
//
// Cache format v2 stores a hash per phase. v1 had one top-level hash shared by all phases,
// so a phase using a composite hash overwrote the base hash of another on every run and
// the two invalidated each other forever.

import { join } from 'path'
import fs from 'fs'
import crypto from 'crypto'
import { xxh64 } from '@node-rs/xxhash'

import { loadYamaConfig } from '../config.js'
import type { FastBuildConfig, LegacyPackageCacheFile, PackageCacheFile, PhaseCacheEntry } from '../types.js'

const CACHE_VERSION = 2

/**
 * Find repository root by looking for pnpm-workspace.yaml
 * Walks up from the given directory until found
 */
function findRepoRoot (startPath: string): string | null {
  let current = startPath
  const root = '/'

  while (current !== root) {
    if (fs.existsSync(join(current, 'pnpm-workspace.yaml'))) {
      return current
    }
    const parent = join(current, '..')
    if (parent === current) break
    current = parent
  }

  return null
}

/**
 * Output directories for each phase that need to be verified
 */
const phaseOutputDirs: Record<string, string[]> = {
  transpile: ['lib'],
  validate: ['types'],
  bundle: ['bundle'],
  package: ['dist'],
  'docker-build': []
}

/**
 * Collect file signatures (content hash:size) recursively.
 * `extensions` optionally restricts the files to those extensions (e.g. '.ts', '.js').
 */
export function collectFileSignatures (dir: string, extensions: Set<string> | null = null): Record<string, string> {
  const signatures: Record<string, string> = {}
  if (!fs.existsSync(dir)) return signatures

  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const fullPath = join(dir, entry.name)
    // A junction (how pnpm links packages on Windows) reports isDirectory() === true, unlike a
    // symlink on unix. Without these guards the walk descends into node_modules and re-hashes the
    // whole dependency tree once per package.
    if (entry.name === 'node_modules' || entry.isSymbolicLink()) continue
    if (entry.isDirectory()) {
      if (fs.lstatSync(fullPath).isSymbolicLink()) continue
      Object.assign(signatures, collectFileSignatures(fullPath, extensions))
    } else {
      if (extensions !== null) {
        const ext = entry.name.slice(entry.name.lastIndexOf('.'))
        // Special handling for .d.ts files
        const isMatch = extensions.has(ext) || (ext === '.ts' && entry.name.endsWith('.d.ts') && extensions.has('.d.ts'))
        if (!isMatch) {
          continue
        }
      }
      try {
        const stat = fs.lstatSync(fullPath)
        if (!stat.isFile()) continue
        // Content hash, not mtime: git checkout bumps mtime. xxh64 is ~5-10x faster than md5,
        // source files typically <100KB.
        const content = fs.readFileSync(fullPath)
        const hash = xxh64(content).toString(16)
        signatures[fullPath] = `${hash}:${stat.size}`
      } catch {
        // Ignore stat/read errors
      }
    }
  }
  return signatures
}

/**
 * Read fastBuild section from package.json
 * Supported fields:
 *   fastBuild.extraHashFiles: string[]  - extra files (relative to package dir)
 *   fastBuild.extraHashPaths: string[]  - extra files/dirs (relative to package dir)
 *                                          dirs are hashed recursively
 */
function readFastBuildConfig (packagePath: string): Required<FastBuildConfig> {
  const pkgJsonPath = join(packagePath, 'package.json')
  if (!fs.existsSync(pkgJsonPath)) return { extraHashFiles: [], extraHashPaths: [] }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf8')) as { fastBuild?: FastBuildConfig }
    const fb = pkg.fastBuild ?? {}
    return {
      extraHashFiles: Array.isArray(fb.extraHashFiles) ? fb.extraHashFiles : [],
      extraHashPaths: Array.isArray(fb.extraHashPaths) ? fb.extraHashPaths : []
    }
  } catch {
    return { extraHashFiles: [], extraHashPaths: [] }
  }
}

/**
 * Calculate unified package hash based on all source inputs.
 * Used across all phases to detect changes.
 *
 * Includes:
 * - src/ and tests/ directories
 * - package.json, tsconfig.json, Dockerfile
 * - the repo-relative `hashFiles` of yama.config.json (global files: when one changes, all packages rebuild)
 * - Any additional config files provided via parameter or package.json fastBuild
 *
 * `extraFiles` are relative to the package dir. Returns an MD5 hash.
 */
export function calculatePackageHash (packagePath: string, extraFiles: string[] = []): string {
  const parts: string[] = []

  const srcPath = join(packagePath, 'src')
  if (fs.existsSync(srcPath)) {
    const srcExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.svelte', '.json'])
    const sigs = collectFileSignatures(srcPath, srcExtensions)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`src:${key}=${sigs[key]}`)
    }
  }

  const testsPath = join(packagePath, 'tests')
  if (fs.existsSync(testsPath)) {
    const testExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.json'])
    const sigs = collectFileSignatures(testsPath, testExtensions)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`tests:${key}=${sigs[key]}`)
    }
  }

  // Content hash, not mtime: git checkout bumps mtime.
  const pushFileSig = (label: string, absPath: string): void => {
    if (!fs.existsSync(absPath)) return
    try {
      const stat = fs.statSync(absPath)
      if (!stat.isFile()) return
      const content = fs.readFileSync(absPath)
      const hash = xxh64(content).toString(16)
      parts.push(`${label}:${hash}:${stat.size}`)
    } catch {
      /* ignore */
    }
  }

  pushFileSig('package.json', join(packagePath, 'package.json'))
  pushFileSig('tsconfig.json', join(packagePath, 'tsconfig.json'))
  pushFileSig('Dockerfile', join(packagePath, 'Dockerfile'))

  const rootDir = findRepoRoot(packagePath)
  if (rootDir !== null) {
    for (const file of loadYamaConfig(rootDir).hashFiles ?? []) {
      pushFileSig(file, join(rootDir, file))
    }
  }

  // Merge extraFiles from parameter with fastBuild config from package.json
  const fb = readFastBuildConfig(packagePath)
  const allExtraFiles = [...extraFiles, ...fb.extraHashFiles]
  for (const file of allExtraFiles) {
    pushFileSig(`extra:${file}`, join(packagePath, file))
  }

  // extraHashPaths supports both files and directories (recursive)
  // Paths are relative to package dir; can point outside (e.g. ../../dev/prod/dist)
  for (const rel of fb.extraHashPaths) {
    const absPath = join(packagePath, rel)
    if (!fs.existsSync(absPath)) continue
    try {
      const stat = fs.statSync(absPath)
      if (stat.isFile()) {
        pushFileSig(`path:${rel}`, absPath)
      } else if (stat.isDirectory()) {
        const sigs = collectFileSignatures(absPath)
        const sortedKeys = Object.keys(sigs).sort()
        for (const key of sortedKeys) {
          // Use relative key inside the directory to keep hash stable across machines
          const relKey = key.slice(absPath.length)
          parts.push(`path:${rel}:${relKey}=${sigs[key]}`)
        }
      }
    } catch {
      /* ignore */
    }
  }

  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

/**
 * Hash of the output directory contents of a phase.
 * Used to detect if output was modified/corrupted after build.
 * Returns null when the phase has no output dirs or any dir doesn't exist.
 */
export function calculateOutputHash (packagePath: string, phase: string): string | null {
  const dirs = phaseOutputDirs[phase]
  if (!dirs || dirs.length === 0) return null
  return calculateOutputHashForDirs(packagePath, dirs)
}

/**
 * Hash of specific output directories (names relative to the package).
 * Returns null when any dir doesn't exist.
 */
export function calculateOutputHashForDirs (packagePath: string, dirs: string[]): string | null {
  const parts: string[] = []
  for (const dir of dirs) {
    const dirPath = join(packagePath, dir)
    if (!fs.existsSync(dirPath)) return null

    const sigs = collectFileSignatures(dirPath)
    const sortedKeys = Object.keys(sigs).sort()
    for (const key of sortedKeys) {
      parts.push(`${dir}:${key}=${sigs[key]}`)
    }
  }

  if (parts.length === 0) return null
  return crypto.createHash('md5').update(parts.join('\n')).digest('hex')
}

/**
 * Load package cache from .fast-build-cache.json.
 * Handles migration from v1 format transparently.
 */
export function loadPackageCache (packagePath: string): PackageCacheFile | null {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    if (fs.existsSync(cachePath)) {
      const raw = JSON.parse(fs.readFileSync(cachePath, 'utf-8')) as LegacyPackageCacheFile

      // Already v2
      if (raw.version === CACHE_VERSION && raw.phases) {
        return raw as PackageCacheFile
      }

      // Migrate v1 -> v2
      // v1 format: { hash: "...", timestamp: ..., phases: { transpile: { completedAt: ... }, ... } }
      if (raw.hash && raw.phases) {
        const migrated: PackageCacheFile = { version: CACHE_VERSION, phases: {} }
        for (const [phase, meta] of Object.entries(raw.phases)) {
          if (meta && typeof meta === 'object') {
            migrated.phases[phase] = {
              hash: raw.hash,
              ...meta
            } as PhaseCacheEntry
          }
        }
        savePackageCache(packagePath, migrated)
        return migrated
      }

      // Unrecognised format - discard
      return null
    }
  } catch {
    /* ignore corrupted cache */
  }
  return null
}

/**
 * Save package cache to .fast-build-cache.json
 */
export function savePackageCache (packagePath: string, cache: PackageCacheFile): void {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2), 'utf-8')
  } catch {
    /* ignore write errors */
  }
}

/**
 * Check if a phase is cached and valid.
 * `packageHash` may differ per phase; `outputDirs` overrides the phase's default output dirs.
 */
export function isPhaseCached (
  packagePath: string,
  packageHash: string,
  phase: string,
  outputCheck: ((packagePath: string) => boolean) | null = null,
  outputDirs: string[] | null = null
): boolean {
  const cache = loadPackageCache(packagePath)
  if (cache === null) return false

  const phaseEntry = cache.phases?.[phase]
  if (!phaseEntry) return false

  // Each phase stores its own hash - compare only against that phase's hash
  if (phaseEntry.hash !== packageHash) return false

  // Verify output hash matches what was stored (detects deleted/corrupted outputs)
  if (phaseEntry.outputHash) {
    const currentOutputHash =
      outputDirs !== null ? calculateOutputHashForDirs(packagePath, outputDirs) : calculateOutputHash(packagePath, phase)
    if (currentOutputHash !== phaseEntry.outputHash) return false
  }

  if (outputCheck !== null && !outputCheck(packagePath)) {
    return false
  }

  return true
}

/**
 * Mark a phase as completed in cache.
 * `metadata` is stored flat next to the hash (e.g. { errorCount: 0, warningCount: 5 }).
 */
export function markPhaseCompleted (
  packagePath: string,
  packageHash: string,
  phase: string,
  metadata: Record<string, unknown> | null = null,
  outputDirs: string[] | null = null
): void {
  let cache = loadPackageCache(packagePath)

  if (cache === null) {
    cache = { version: CACHE_VERSION, phases: {} }
  }

  if (!cache.phases) {
    cache.phases = {}
  }

  // Output hash is taken AFTER the phase completed
  const outputHash =
    outputDirs !== null ? calculateOutputHashForDirs(packagePath, outputDirs) : calculateOutputHash(packagePath, phase)

  // Each phase tracks its own hash independently; other phases are left untouched.
  cache.phases[phase] = {
    hash: packageHash,
    completedAt: Date.now(),
    outputHash,
    ...metadata
  }

  savePackageCache(packagePath, cache)
}

/**
 * Get phase metadata from cache, or null if not cached for this hash
 */
export function getPhaseMetadata (packagePath: string, packageHash: string, phase: string): PhaseCacheEntry | null {
  const cache = loadPackageCache(packagePath)
  if (cache === null) return null

  const phaseEntry = cache.phases?.[phase]
  if (!phaseEntry) return null
  if (phaseEntry.hash !== packageHash) return null

  return phaseEntry
}

/**
 * Get list of completed phases for a package whose hash still matches.
 * Because each phase may use a different hash, the caller may pass a phase -> hash map
 * instead of a single hash (applied to all phases).
 */
export function getCompletedPhases (packagePath: string, packageHash: string | Record<string, string>): string[] {
  const cache = loadPackageCache(packagePath)
  if (cache === null || !cache.phases) return []

  const result: string[] = []
  for (const [phase, entry] of Object.entries(cache.phases)) {
    if (!entry) continue
    const expectedHash = typeof packageHash === 'string' ? packageHash : packageHash[phase]
    if (expectedHash && entry.hash === expectedHash) {
      result.push(phase)
    }
  }
  return result
}

/**
 * Drop a single phase from the cache, leaving the other phases untouched.
 * Transpile used to call invalidateCache() on any upstream change, which wiped
 * validate/lint/svelte-check/bundle/package/docker-build for the whole downstream closure.
 */
export function invalidatePhase (packagePath: string, phase: string): void {
  const cache = loadPackageCache(packagePath)
  if (cache === null || !cache.phases || !cache.phases[phase]) return

  delete cache.phases[phase]
  savePackageCache(packagePath, cache)
}

/**
 * Invalidate all caches for a package (when force rebuilding)
 */
export function invalidateCache (packagePath: string): void {
  const cachePath = join(packagePath, '.fast-build-cache.json')
  try {
    if (fs.existsSync(cachePath)) {
      fs.unlinkSync(cachePath)
    }
  } catch {
    /* ignore */
  }
}
