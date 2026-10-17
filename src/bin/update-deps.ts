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

// Checks and updates dependencies of the configured npm scope across all workspace packages

import { existsSync, readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import https from 'https'
import { loadYamaConfig } from '../build/config.js'
import { findWorkspaceRoot, listWorkspaceProjects } from '../build/libs/workspace.js'
import type { DepChange, DepMap, DepsScanPackageJson, WorkspaceProject } from '../build/types.js'

const DEPENDENCY_TYPES = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

let SCOPE = ''

function getWorkspaceRoot (): string {
  const root = findWorkspaceRoot()
  if (root == null) throw new Error('Could not determine workspace root')
  return root
}

// Latest version of a package from the npm registry; null when the registry does not know it
function getLatestVersion (packageName: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const url = `https://registry.npmjs.org/${packageName}/latest`

    https
      .get(url, (res) => {
        let data = ''

        res.on('data', (chunk) => {
          data += chunk
        })

        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data) as { version: string }
              resolve(parsed.version)
            } catch (err) {
              reject(new Error(`Failed to parse response for ${packageName}: ${(err as Error).message}`))
            }
          } else if (res.statusCode === 404) {
            resolve(null)
          } else {
            reject(new Error(`HTTP ${res.statusCode} for ${packageName}`))
          }
        })
      })
      .on('error', (err) => {
        reject(err)
      })
  })
}

function isNewerVersion (current: string, latest: string): boolean {
  // Remove workspace: prefix and version operators
  current = current.replace(/^workspace:|[\^~><=]/g, '')

  const currentParts = current.split('.').map(Number)
  const latestParts = latest.split('.').map(Number)

  for (let i = 0; i < 3; i++) {
    if (latestParts[i] > currentParts[i]) return true
    if (latestParts[i] < currentParts[i]) return false
  }

  return false
}

function updatePackageDependencies (
  project: WorkspaceProject,
  latestVersions: Record<string, string>,
  dryRun = false
): number {
  const packageJsonPath = project.fullPath ? join(project.fullPath, 'package.json') : null

  if (!packageJsonPath || !existsSync(packageJsonPath)) {
    return 0
  }

  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as DepsScanPackageJson
  const packageName = packageJson.name
  let hasChanges = false
  const changes: DepChange[] = []

  for (const depType of DEPENDENCY_TYPES) {
    const deps = packageJson[depType] as DepMap | undefined
    if (!deps) continue

    for (const [depName, currentVersion] of Object.entries(deps)) {
      if (!depName.startsWith(SCOPE)) continue

      // Skip workspace dependencies
      if (currentVersion.startsWith('workspace:')) {
        continue
      }

      const latestVersion = latestVersions[depName]

      if (!latestVersion) {
        console.log(`  ⚠️  ${depName}: not found in npm registry (current: ${currentVersion})`)
        continue
      }

      if (isNewerVersion(currentVersion, latestVersion)) {
        const prefix = currentVersion.match(/^[\^~]/)?.[0] || '^'
        const newVersion = `${prefix}${latestVersion}`

        changes.push({
          depType,
          depName,
          oldVersion: currentVersion,
          newVersion
        })

        if (!dryRun) {
          deps[depName] = newVersion
          hasChanges = true
        }
      }
    }
  }

  if (changes.length > 0) {
    console.log(`\n📦 ${packageName}`)
    for (const change of changes) {
      console.log(`  ✓ ${change.depName}: ${change.oldVersion} → ${change.newVersion} (${change.depType})`)
    }

    if (!dryRun && hasChanges) {
      writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n', 'utf-8')
    }
  }

  return changes.length
}

async function fetchLatestVersions (projects: WorkspaceProject[]): Promise<Record<string, string>> {
  const packageNames = new Set<string>()

  // Collect all scoped package names from all projects
  for (const project of projects) {
    const packageJsonPath = project.fullPath ? join(project.fullPath, 'package.json') : null
    if (!packageJsonPath || !existsSync(packageJsonPath)) continue

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf-8')) as DepsScanPackageJson

    for (const depType of DEPENDENCY_TYPES) {
      const deps = packageJson[depType] as DepMap | undefined
      if (!deps) continue

      for (const depName of Object.keys(deps)) {
        if (depName.startsWith(SCOPE)) {
          packageNames.add(depName)
        }
      }
    }
  }

  console.log(`\n🔍 Checking latest versions for ${packageNames.size} ${SCOPE}* packages...\n`)

  const latestVersions: Record<string, string> = {}
  const promises = Array.from(packageNames).map(async (packageName) => {
    try {
      const version = await getLatestVersion(packageName)
      if (version) {
        latestVersions[packageName] = version
        console.log(`  ✓ ${packageName}@${version}`)
      } else {
        console.log(`  ⚠️  ${packageName}: not found in registry`)
      }
    } catch (err) {
      console.error(`  ✗ ${packageName}: ${(err as Error).message}`)
    }
  })

  await Promise.all(promises)

  return latestVersions
}

async function main (): Promise<void> {
  const args = process.argv.slice(2)

  const scope = loadYamaConfig(getWorkspaceRoot()).deps?.scope
  if (scope === undefined || scope === '') {
    console.error('\n❌ Error: deps.scope must be set in yama.config.json')
    process.exit(1)
  }
  SCOPE = scope

  // Show help
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`
${SCOPE} Dependencies Updater

Usage:
  update-deps [options]

Options:
  --dry-run, -n    Check for updates without modifying files
  --help, -h       Show this help message

Description:
  This script checks all workspace packages for ${SCOPE}* dependencies
  and updates them to the latest versions available in npm registry.

  Workspace dependencies (using 'workspace:' protocol) are never modified.

Examples:
  # Check for updates (dry run)
  update-deps --dry-run

  # Apply updates
  update-deps

After updating:
  1. Run 'pnpm install' to update the lockfile
  2. Run 'pnpm build' to verify builds
  3. Test your changes
`)
    return
  }

  const dryRun = args.includes('--dry-run') || args.includes('-n')

  console.log(`🚀 ${SCOPE} Dependencies Updater\n`)

  const projects = listWorkspaceProjects()
  const workspaceRoot = getWorkspaceRoot()

  console.log(`Workspace: ${workspaceRoot}`)
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'UPDATE'}`)
  console.log(`Found ${projects.length} projects`)

  // Fetch latest versions from npm
  const latestVersions = await fetchLatestVersions(projects)

  if (Object.keys(latestVersions).length === 0) {
    console.log(`\n⚠️  No ${SCOPE} packages found in npm registry`)
    return
  }

  console.log('\n' + '='.repeat(80))
  console.log('Checking for updates...')
  console.log('='.repeat(80))

  // Update each project's dependencies
  let totalUpdates = 0
  for (const project of projects) {
    totalUpdates += updatePackageDependencies(project, latestVersions, dryRun)
  }

  console.log('\n' + '='.repeat(80))

  if (totalUpdates === 0) {
    console.log(`✅ All ${SCOPE} dependencies are up to date!`)
  } else {
    if (dryRun) {
      console.log(`\n📊 Found ${totalUpdates} potential update(s)`)
      console.log('\nRun without --dry-run flag to apply changes')
    } else {
      console.log(`\n✅ Updated ${totalUpdates} dependency version(s)`)
      console.log('\n💡 Next steps:')
      console.log('   1. Run: pnpm install')
      console.log('   2. Run: pnpm build')
      console.log('   3. Test your changes')
    }
  }
}

main().catch((err: Error) => {
  console.error('\n❌ Error:', err.message)
  process.exit(1)
})
