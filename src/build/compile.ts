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

import { join, dirname, basename, relative } from 'path'
import {
  readFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  lstatSync,
  writeFileSync,
  copyFileSync,
  rmSync
} from 'fs'
import { createRequire } from 'module'
import * as esbuild from 'esbuild'

import { getTypeScriptDriver, resolveTsc7 } from './drivers/tsc.js'
import type { EsbuildOptions, TscCompileOptions } from './types.js'

const nodeRequire = createRequire(__filename)

export { resolveTsc7 }

/**
 * Collect source files recursively from a directory
 */
export function collectFiles (source: string): string[] {
  const result: string[] = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)

    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectFiles(sourceFile))
    } else {
      const fileName = basename(sourceFile)
      // Skip non-source files
      if (!fileName.endsWith('.ts') && !fileName.endsWith('.js') && !fileName.endsWith('.svelte')) {
        continue
      }
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Collect JSON files recursively from a directory
 */
function collectJsonFiles (source: string): string[] {
  const result: string[] = []
  if (!existsSync(source)) {
    return result
  }
  const files = readdirSync(source)
  for (const f of files) {
    const sourceFile = join(source, f)
    if (lstatSync(sourceFile).isDirectory()) {
      result.push(...collectJsonFiles(sourceFile))
    } else if (f.endsWith('.json')) {
      result.push(sourceFile)
    }
  }
  return result
}

/**
 * Copy JSON files from source to destination preserving directory structure
 */
function copyJsonFiles (srcDir: string, outDir: string, cwd: string): void {
  const absoluteSrcDir = join(cwd, srcDir)
  const absoluteOutDir = join(cwd, outDir)
  const jsonFiles = collectJsonFiles(absoluteSrcDir)

  for (const jsonFile of jsonFiles) {
    const relativePath = relative(absoluteSrcDir, jsonFile)
    const destFile = join(absoluteOutDir, relativePath)
    const destDir = dirname(destFile)

    if (!existsSync(destDir)) {
      mkdirSync(destDir, { recursive: true })
    }
    copyFileSync(jsonFile, destFile)
  }
}

// Plain per-file transpile, no type information involved. Restored from the pre-tsc7 rig so the
// build phase can emit JS here and leave tsc with declarations only.
export async function performESBuild (filesToTranspile: string[], options: EsbuildOptions = {}): Promise<void> {
  const { srcDir = 'src', cwd = process.cwd(), outDir = 'lib' } = options

  if (filesToTranspile.length === 0) {
    return
  }

  copyJsonFiles(srcDir, outDir, cwd)

  await esbuild.build({
    entryPoints: filesToTranspile,
    bundle: false,
    minify: false,
    outdir: outDir,
    outbase: srcDir,
    keepNames: true,
    sourcemap: 'linked',
    allowOverwrite: true,
    format: 'cjs',
    color: true,
    logLevel: 'error',
    absWorkingDir: cwd
  })
}

// rootDir comes from the package's tsconfig: the sanity test packages compile ./tests, not ./src.
export async function emitLib (cwd: string): Promise<void> {
  const m = /"rootDir"\s*:\s*"([^"]+)"/.exec(readFileSync(join(cwd, 'tsconfig.json'), 'utf8'))
  const srcDir = m?.[1] ?? 'src'
  const files = collectFiles(join(cwd, srcDir)).map((f) => relative(cwd, f))
  await performESBuild(files, { srcDir, cwd, outDir: 'lib' })
}

export async function performESBuildWithSvelte (
  filesToTranspile: string[],
  options: EsbuildOptions = {}
): Promise<void> {
  const { cwd = process.cwd() } = options

  // Separate Svelte and non-Svelte files
  const svelteFiles = filesToTranspile.filter((f) => f.endsWith('.svelte'))
  const nonSvelteFiles = filesToTranspile.filter((f) => !f.endsWith('.svelte'))

  const outdir = join(cwd, 'lib')
  const outbase = join(cwd, 'src')

  // Build non-Svelte files
  if (nonSvelteFiles.length > 0) {
    // Not esbuild-plugin-copy: on Windows its glob reads the backslashes of an absolute path as
    // escapes and crawls the whole repo from process.cwd(), growing the build process until OOM.
    copyJsonFiles('src', 'lib', cwd)
    await esbuild.build({
      entryPoints: nonSvelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      keepNames: true,
      logLevel: 'error',
      sourcemap: 'linked',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd
    })
  }

  // Build Svelte files
  if (svelteFiles.length > 0) {
    const sveltePlugin = nodeRequire('esbuild-svelte') as typeof import('esbuild-svelte').default
    const sveltePreprocess = nodeRequire('svelte-preprocess') as typeof import('svelte-preprocess').default
    await esbuild.build({
      entryPoints: svelteFiles,
      bundle: false,
      minify: false,
      outdir,
      outbase,
      outExtension: { '.js': '.svelte.js' },
      keepNames: true,
      sourcemap: 'linked',
      logLevel: 'error',
      allowOverwrite: true,
      format: 'cjs',
      color: true,
      absWorkingDir: cwd,
      plugins: [
        sveltePlugin({
          // svelte-preprocess 6 elides imports that only the markup uses (a store referenced
          // as $store) unless this is set. Deliberately not in tsconfig: esbuild reads it too
          // and would then keep type-only imports, pulling .svelte source into node bundles.
          preprocess: sveltePreprocess({ typescript: { compilerOptions: { verbatimModuleSyntax: true } } }),
          compilerOptions: {
            css: 'injected',
            generate: 'ssr'
          }
        })
      ]
    })
  }
}

export async function generateSvelteTypes (options: EsbuildOptions = {}): Promise<void> {
  const { cwd = process.cwd() } = options
  const srcDir = join(cwd, 'src')
  const typesDir = join(cwd, 'types')

  if (!existsSync(srcDir)) {
    return
  }

  if (!existsSync(typesDir)) {
    mkdirSync(typesDir, { recursive: true })
  }

  const svelteFiles = collectFiles(srcDir).filter((f) => f.endsWith('.svelte'))
  const { svelte2tsx } = nodeRequire('svelte2tsx') as typeof import('svelte2tsx')

  for (const svelteFile of svelteFiles) {
    try {
      const content = readFileSync(svelteFile, 'utf-8')
      const result = svelte2tsx(content, {
        filename: svelteFile,
        isTsFile: true,
        mode: 'dts'
      })

      const relativePath = svelteFile.replace(srcDir, '')
      const outputPath = join(typesDir, relativePath.replace('.svelte', '.svelte.d.ts'))
      const outputDir = dirname(outputPath)

      if (!existsSync(outputDir)) {
        mkdirSync(outputDir, { recursive: true })
      }

      writeFileSync(outputPath, result.code)
    } catch (err) {
      console.error(`Error generating types for ${svelteFile}:`, (err as Error).message)
    }
  }
}

function collectDts (dir: string): string[] {
  const result: string[] = []
  for (const f of existsSync(dir) ? readdirSync(dir) : []) {
    const full = join(dir, f)
    if (lstatSync(full).isDirectory()) result.push(...collectDts(full))
    else if (f.endsWith('.svelte.d.ts')) result.push(full)
  }
  return result
}

// tsc sees a .svelte import only through the `*.svelte` shim; these give dependents real prop types
// through types/ instead of compiling this package's sources again.
export async function emitSvelteDts (cwd: string): Promise<void> {
  const srcDir = join(cwd, 'src')
  if (!collectFiles(srcDir).some((f) => f.endsWith('.svelte'))) return
  const { emitDts } = nodeRequire('svelte2tsx') as typeof import('svelte2tsx')
  const outDir = join(cwd, '.build', 'svelte-dts')
  rmSync(outDir, { recursive: true, force: true })
  await emitDts({
    declarationDir: outDir,
    svelteShimsPath: nodeRequire.resolve('svelte2tsx/svelte-shims-v4.d.ts'),
    libRoot: srcDir,
    tsconfig: join(cwd, 'tsconfig.json')
  })
  // The .ts declarations stay tsc 7's; only the components come from here.
  for (const f of collectDts(outDir)) {
    const dest = join(cwd, 'types', relative(outDir, f))
    mkdirSync(dirname(dest), { recursive: true })
    copyFileSync(f, dest)
  }
}

/**
 * Single-pass compile via tsc 7: JS + .d.ts + maps, or declarations only.
 */
export async function tscCompile (options: TscCompileOptions = {}): Promise<void> {
  const { cwd = process.cwd(), emitDeclarationOnly = false, throwOnError = false } = options
  const buildDir = join(cwd, '.build')

  if (!existsSync(buildDir)) {
    mkdirSync(buildDir, { recursive: true })
  }

  // Passed explicitly: a relative path in a rig profile resolves into the shared rig folder.
  const res = await getTypeScriptDriver().run({
    cwd,
    project: 'tsconfig.json',
    tsBuildInfoFile: join('.build', 'build.tsbuildinfo'),
    emitDeclarationOnly,
    noCheck: false
  })
  writeFileSync(join(buildDir, 'compile.log'), res.out)

  if (!res.success) {
    // A spawn failure has no compiler output; surface it instead of printing nothing.
    if (res.out === '' && res.error != null) {
      throw new Error(res.error)
    }
    if (throwOnError) {
      throw new Error(res.out)
    }
    console.error(res.out)
    process.exit(res.exitCode ?? 1)
  }

  if (!emitDeclarationOnly) {
    copyJsonFiles('src', 'lib', cwd)
  }
}
