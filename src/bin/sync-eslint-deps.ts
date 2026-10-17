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

// Syncs ESLint dev dependencies from the configured source package to all workspace packages

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { loadYamaConfig } from '../build/config.js'
import { findWorkspaceRoot, listWorkspaceProjects } from '../build/libs/workspace.js'
import type { EslintSyncPackageJson, EslintSyncResult } from '../build/types.js'

// ESLint related dependency prefixes to sync
const ESLINT_PATTERNS = ['eslint', '@typescript-eslint/', '@stylistic/', 'eslint-plugin-', 'eslint-config-']

function isEslintDependency (depName: string): boolean {
  return ESLINT_PATTERNS.some((pattern) => depName.startsWith(pattern))
}

function findSourcePackagePath (sourceName: string): string | null {
  const cwd = process.cwd()
  const possiblePaths = [
    join(cwd, 'common', 'scripts', 'node_modules', sourceName),
    join(cwd, 'node_modules', sourceName)
  ]

  for (const sourcePath of possiblePaths) {
    const packageJsonPath = join(sourcePath, 'package.json')
    if (existsSync(packageJsonPath)) {
      return sourcePath
    }
  }

  return null
}

function getEslintDepsFromSource (sourcePath: string): Record<string, string> {
  const packageJsonPath = join(sourcePath, 'package.json')

  if (!existsSync(packageJsonPath)) {
    throw new Error(`source package.json not found at: ${packageJsonPath}`)
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as EslintSyncPackageJson
  const dependencies = packageJson.dependencies || {}

  const eslintDeps: Record<string, string> = {}
  for (const [name, version] of Object.entries(dependencies)) {
    if (isEslintDependency(name)) {
      eslintDeps[name] = version
    }
  }

  return eslintDeps
}

function updatePackageJson (packagePath: string, eslintDeps: Record<string, string>, sourceName: string): EslintSyncResult {
  const packageJsonPath = join(packagePath, 'package.json')

  if (!existsSync(packageJsonPath)) {
    console.warn(`⚠️  package.json not found at: ${packageJsonPath}`)
    return { updated: false, changes: [] }
  }

  const content = readFileSync(packageJsonPath, 'utf-8')
  const packageJson = JSON.parse(content) as EslintSyncPackageJson

  // Skip if this is the source package itself
  if (packageJson.name === sourceName) {
    return { updated: false, changes: [] }
  }

  // Initialize devDependencies if it doesn't exist
  if (!packageJson.devDependencies) {
    packageJson.devDependencies = {}
  }

  const changes: string[] = []
  let hasChanges = false

  // Add or update ESLint dependencies
  for (const [name, version] of Object.entries(eslintDeps)) {
    const currentVersion = packageJson.devDependencies[name]

    if (currentVersion !== version) {
      packageJson.devDependencies[name] = version
      hasChanges = true

      if (currentVersion) {
        changes.push(`  ${name}: ${currentVersion} → ${version}`)
      } else {
        changes.push(`  ${name}: (new) → ${version}`)
      }
    }
  }

  if (hasChanges) {
    // Preserve original formatting by maintaining indent detection
    const indent = content.match(/^(\s+)/m)?.[1]?.length || 2
    const newContent = JSON.stringify(packageJson, null, indent) + '\n'
    writeFileSync(packageJsonPath, newContent, 'utf-8')
  }

  return { updated: hasChanges, changes }
}

function main (): void {
  try {
    const root = findWorkspaceRoot()
    const sourceName = root === null ? undefined : loadYamaConfig(root).deps?.eslintDepsSource
    if (sourceName === undefined || sourceName === '') {
      console.error('\n❌ Error: deps.eslintDepsSource must be set in yama.config.json')
      process.exit(1)
    }

    console.log(`🔍 Syncing ESLint dependencies from ${sourceName} to all packages...\n`)

    // Find the source package in node_modules
    const sourcePath = findSourcePackagePath(sourceName)
    if (!sourcePath) {
      console.log(`⚠️  ${sourceName} package not found in node_modules. Skipping sync.`)
      console.log(`   Make sure ${sourceName} is installed as a dependency.`)
      return
    }

    console.log(`📍 Found ${sourceName} at: ${sourcePath}\n`)

    const eslintDeps = getEslintDepsFromSource(sourcePath)

    if (Object.keys(eslintDeps).length === 0) {
      console.log(`⚠️  No ESLint dependencies found in ${sourceName}`)
      return
    }

    console.log(`📦 ESLint dependencies from ${sourceName}:`)
    for (const [name, version] of Object.entries(eslintDeps)) {
      console.log(`  ${name}: ${version}`)
    }
    console.log()

    // Get all workspace projects
    const projects = listWorkspaceProjects()
    console.log(`Found ${projects.length} projects in workspace\n`)

    // Update all packages
    let updatedCount = 0
    let skippedCount = 0

    for (const project of projects) {
      const result = updatePackageJson(project.fullPath, eslintDeps, sourceName)

      if (result.updated) {
        updatedCount++
        console.log(`✅ Updated ${project.name}`)
        result.changes.forEach((change) => console.log(change))
        console.log()
      } else if (result.changes.length === 0 && project.name !== sourceName) {
        skippedCount++
      }
    }

    console.log('━'.repeat(50))
    console.log('✨ Sync complete!')
    console.log(`   Updated: ${updatedCount} package(s)`)
    console.log(`   Skipped: ${skippedCount} package(s) (already up-to-date)`)

    if (updatedCount > 0) {
      console.log('\n💡 Don\'t forget to run "pnpm install" to install the updated dependencies')
    }
  } catch (error) {
    console.error(`\n❌ Error: ${(error as Error).message}`)
    process.exit(1)
  }
}

main()
