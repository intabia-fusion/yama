// By Andrey Sobolev haiodo@gmail.com
import { join, resolve } from 'path'
import { spawnSync } from 'child_process'
import yargs, { Arguments } from 'yargs'
import { hideBin } from 'yargs/helpers'
import { listPackages } from './tools/list.js'
import { findSourceExports } from './tools/exports.js'
import { syncVersions } from './tools/sync.js'
import { applyConfig, updateConfig } from './tools/config.js'
import {
  buildDependencyTree,
  formatDependencyTree,
  analyzeExternalDependencies,
  formatExternalDependenciesAnalysis,
  formatPackageDependencyTypes,
  findWhereUsed,
  formatWhereUsedResult
} from './tools/deps.js'
import { main as compileAllMain } from './build/compile-all.js'

// Raw argv after the command word: compile-all and compile do their own parsing.
function forwardedArgs (command: string): string[] {
  const argv = hideBin(process.argv)
  return argv.slice(argv.indexOf(command) + 1)
}

yargs(hideBin(process.argv))
  .command('list <root> [mode]', 'and and list all packages in the root directory recursively',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
        .positional('mode', { describe: 'A display mode folder or feature', default: 'folder' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await listPackages(root, argv.mode as 'feature' | 'folder')
    }
  )
  .command('config <root> [mode]', 'Scan&Create&Update config',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await updateConfig(root)
    }
  )
  .command('apply <root>', 'Apply configuration to managed package.json\'s',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
        .positional('mode', { describe: 'A bundles mode, none|include', default: 'none' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await applyConfig(root)
    }
  )
  .command('find-source-exports <root>', 'and and list all packages in the root directory recursively',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await findSourceExports(root, argv.fix as boolean)
    }
  ).option('fix', {
    alias: 'f',
    describe: 'apply fixes',
    type: 'boolean',
    default: false
  })
  .command('sync-versions <root>', 'Sync all versions to proper ones',
    (yargs) => {
      return yargs.positional('root', { describe: 'a root directory for a project to list all packages.', default: '.' })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      await syncVersions(root)
    }
  )
  .command('deps <root>', 'Build and display dependency tree',
    (yargs) => {
      return yargs
        .positional('root', { describe: 'a root directory for a project to analyze dependencies.', default: '.' })
        .option('json', {
          alias: 'j',
          describe: 'Output as JSON',
          type: 'boolean',
          default: false
        })
        .option('cycles-only', {
          alias: 'c',
          describe: 'Show only circular dependencies',
          type: 'boolean',
          default: false
        })
        .option('build-order', {
          alias: 'b',
          describe: 'Show only build order',
          type: 'boolean',
          default: false
        })
        .option('dependents', {
          alias: 'd',
          describe: 'Show dependents of a package',
          type: 'string'
        })
        .option('types', {
          alias: 't',
          describe: 'Show dependency types (dev/prod/peer) for a package',
          type: 'string'
        })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      console.log(`Analyzing dependencies in ${root}...`)

      const tree = await buildDependencyTree(root)

      if (argv['cycles-only']) {
        if (tree.cycles.length === 0) {
          console.log('✅ No circular dependencies found!')
        } else {
          console.log(`⚠️  Found ${tree.cycles.length} circular dependencies:`)
          for (const cycle of tree.cycles) {
            console.log(`  ${cycle.join(' → ')}`)
          }
        }
        return
      }

      if (argv['build-order']) {
        console.log('Build order:')
        tree.buildOrder.forEach((name, i) => {
          console.log(`  ${i + 1}. ${name}`)
        })
        return
      }

      const pkg = argv.dependents as string | undefined
      if (pkg !== undefined && pkg.length > 0) {
        const { getTransitiveDependents } = await import('./tools/deps.js')
        const dependents = getTransitiveDependents(tree, pkg)
        console.log(`Packages depending on ${pkg}:`)
        for (const name of [...dependents].sort()) {
          console.log(`  - ${name}`)
        }
        return
      }

      const typesPkg = argv.types as string | undefined
      if (typesPkg !== undefined && typesPkg.length > 0) {
        console.log(formatPackageDependencyTypes(tree, typesPkg))
        return
      }

      if (argv.json) {
        console.log(JSON.stringify({
          packages: Array.from(tree.packages.keys()),
          edges: tree.edges,
          cycles: tree.cycles,
          buildOrder: tree.buildOrder,
          errors: tree.errors
        }, null, 2))
      } else {
        console.log(formatDependencyTree(tree))
      }
    }
  )
  .command('external-deps <root>', 'Analyze external dependencies (npm packages)',
    (yargs) => {
      return yargs
        .positional('root', { describe: 'a root directory for a project to analyze.', default: '.' })
        .option('top', {
          alias: 'n',
          describe: 'Number of top dependencies to show',
          type: 'number',
          default: 25
        })
        .option('by-size', {
          alias: 's',
          describe: 'Sort by size (default: by usage count)',
          type: 'boolean',
          default: true
        })
        .option('no-size', {
          describe: 'Skip size calculation',
          type: 'boolean',
          default: false
        })
        .option('details', {
          describe: 'Show detailed information (versions, usages)',
          type: 'boolean',
          default: false
        })
        .option('exclude', {
          alias: 'e',
          describe: 'Packages to exclude (glob patterns supported: @scope/*, package-*, etc.)',
          type: 'string',
          array: true,
          default: []
        })
        .option('mode', {
          alias: 'm',
          describe: 'Filter mode: prod (default), dev, or both',
          choices: ['prod', 'dev', 'both'] as const,
          default: 'both'
        })
        .option('json', {
          alias: 'j',
          describe: 'Output as JSON',
          type: 'boolean',
          default: false
        })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      const top = argv.top as number
      const bySize = argv['by-size'] as boolean
      const noSize = argv['no-size'] as boolean
      const details = argv.details as boolean
      const excludeRaw = argv.exclude as string[]
      const mode = argv.mode as 'prod' | 'dev' | 'both'
      const json = argv.json as boolean

      // Parse exclude list (handle both comma-separated and multiple flags)
      const exclude = excludeRaw
        .flatMap(e => e.split(','))
        .map(e => e.trim())
        .filter(e => e.length > 0)

      console.log(`Analyzing external dependencies in ${root}...`)
      console.log(`Mode: ${mode}`)
      if (exclude.length > 0) {
        console.log(`Excluding: ${exclude.join(', ')}`)
      }
      console.log('This may take a while if calculating package sizes...\n')

      const analysis = await analyzeExternalDependencies(root, {
        calculateSize: !noSize,
        sizeLimit: top,
        exclude,
        mode
      })

      if (json) {
        // Преобразуем Map в объект для JSON
        const depsObj: Record<string, unknown> = {}
        for (const [name, info] of analysis.dependencies) {
          depsObj[name] = {
            ...info,
            usages: info.usages.map(u => ({
              ...u,
              isWorkspace: u.isWorkspace
            }))
          }
        }
        console.log(JSON.stringify({
          totalCount: analysis.totalCount,
          totalSize: analysis.totalSize,
          mode,
          excluded: analysis.excluded,
          sizeErrors: analysis.sizeErrors,
          topBySize: analysis.bySize.slice(0, top).map(d => ({
            name: d.name,
            size: d.size,
            totalCount: d.totalCount,
            prodCount: d.prodCount,
            devCount: d.devCount
          })),
          topByUsage: analysis.byUsageCount.slice(0, top).map(d => ({
            name: d.name,
            totalCount: d.totalCount,
            size: d.size,
            prodCount: d.prodCount,
            devCount: d.devCount
          }))
        }, null, 2))
      } else {
        console.log(formatExternalDependenciesAnalysis(analysis, {
          topCount: top,
          bySize,
          showDetails: details,
          mode
        }))
      }
    }
  )
  .command('where-used <root> <package> [mode]', 'Find where a dependency is used',
    (yargs) => {
      return yargs
        .positional('root', { describe: 'a root directory for a project to analyze.', default: '.' })
        .positional('package', { describe: 'package name to search for', type: 'string' })
        .positional('mode', {
          describe: 'Filter mode: prod (default), dev, or both',
          choices: ['prod', 'dev', 'both'] as const,
          default: 'prod'
        })
        .option('json', {
          alias: 'j',
          describe: 'Output as JSON',
          type: 'boolean',
          default: false
        })
    },
    async (argv: Arguments) => {
      const root = resolve(argv.root as string)
      const packageName = argv.package as string
      const mode = argv.mode as 'prod' | 'dev' | 'both'
      const json = argv.json as boolean

      console.log(`Searching for "${packageName}" in ${root}...`)
      console.log(`Mode: ${mode}\n`)

      const result = await findWhereUsed(root, packageName, mode)

      if (json) {
        console.log(JSON.stringify({
          dependencyName: result.dependencyName,
          found: result.found,
          isInternal: result.isInternal,
          mode: result.mode,
          totalUsages: result.totalUsages,
          totalUsagesBeforeFilter: result.totalUsagesBeforeFilter,
          usages: result.isInternal ? result.internalUsages : result.externalUsages
        }, null, 2))
      } else {
        console.log(formatWhereUsedResult(result))
      }
    }
  )
  .command('compile [mode]', 'Compile the package in the current directory (build, build-ui, ui-esbuild, svelte-dts)',
    (yargs) => {
      return yargs.positional('mode', { describe: 'Compile mode, passed to the compile bin', type: 'string' })
    },
    () => {
      const result = spawnSync(process.execPath, [join(__dirname, 'bin/compile.js'), ...forwardedArgs('compile')], {
        stdio: 'inherit'
      })
      process.exit(result.status ?? 1)
    }
  )
  .command('build [args..]', 'Build all packages in dependency order (compile-all flags are forwarded)',
    (yargs) => yargs.positional('args', { describe: 'root directory and compile-all flags, see compile-all --help' }),
    async () => {
      await compileAllMain(forwardedArgs('build'))
    }
  )
  // Type checking is part of the build, so validate is the same command.
  .command('validate [args..]', 'Alias of build',
    (yargs) => yargs.positional('args', { describe: 'root directory and compile-all flags, see compile-all --help' }),
    async () => {
      await compileAllMain(forwardedArgs('validate'))
    }
  )
  .parse()
