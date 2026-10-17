# @intabia-fusion/yama - Yet Another Multi-repository Manager

## Project Overview

Yama is a CLI tool for managing multiple repositories in a monorepo setup. It was created to simplify dependency and version management across multiple packages, addressing limitations found in tools like rush.js, turbo, and pnpm.

**Key Concept**: The tool aims to eventually eliminate manual `package.json` management by auto-generating them in a `.build` folder, keeping source directories free from dependency burden.

## Comments in code

All comments should be in English.

## Conversation language

All conversations should be in Russian.

## Packing instructions.

All new types/interfaces should be in types.ts, reuse existing if possible as much as possible.

## Technology Stack

- **Language**: TypeScript 5.9+ (ESNext, NodeNext modules)
- **Runtime**: Node.js
- **Packaging**: ESM module
- **Package Manager**: pnpm 10.17.1
- **CLI Framework**: yargs
- **Key Dependencies**:
  - `globby` - File globbing for finding package.json files
  - `js-yaml` - YAML configuration parsing
  - `yargs` - CLI argument parsing

## Project Structure

```
├── src/
│   ├── index.ts           # CLI entry point, command definitions
│   └── tools/
│       ├── config.ts      # ymrm.yaml configuration management
│       ├── deps.ts        # Dependency tree building (placeholder)
│       ├── exports.ts     # Source exports detection in package.json
│       ├── group.ts       # Package grouping utilities (by root/feature)
│       ├── list.ts        # Package listing functionality
│       └── sync.ts        # Dependency version synchronization
├── lib/                   # Compiled JavaScript output
├── types/                 # TypeScript declaration files
├── package.json           # Package configuration
├── tsconfig.json          # TypeScript configuration
└── eslint.config.mts      # ESLint configuration
```

## Build and Development Commands

```bash
# Compile TypeScript
pnpm build

# Run ESLint with auto-fix
pnpm lint

# Build and run the CLI
pnpm do

# Build and run with debugger (inspect-brk)
pnpm dod

# Run tests (placeholder - no tests implemented)
pnpm test
```

## CLI Commands

The tool provides the following commands:

### 1. `list <root> [mode]`
List all packages in the root directory recursively.
- `root` - Root directory for the project (default: `.`)
- `mode` - Display mode: `folder` or `feature` (default: `folder`)

### 2. `config <root>`
Scan, create, and update the `ymrm.yaml` configuration file.
- Analyzes all packages and groups them by features
- Creates/updates configuration with enabled/disabled features

### 3. `apply <root>`
Apply configuration to managed `package.json` files.
- Adds/removes dependencies based on enabled features in ymrm.yaml
- Uses `workspace:^` protocol for workspace dependencies

### 4. `find-source-exports <root>`
Find and list all source exports in package.json files.
- Detects TypeScript exports (`.ts` extensions)
- Supports `--fix` flag to auto-fix export paths

### 5. `sync-versions <root>`
Synchronize all dependency versions across packages.
- Finds the latest version of each dependency
- Updates all packages to use consistent versions
- Adds `workspace:` prefix for workspace packages

## Configuration File (ymrm.yaml)

The configuration file defines how packages are organized and managed:

```yaml
# User-defined categories for feature grouping
categories:
  - my-category

# Feature definitions with enabled status
features:
  feature-name:
    modules: 5          # Number of packages in this feature
    enabled: true       # Whether feature is enabled
    names: []           # List of package names

# Total module count
modules: 10

# Managed package.json files
managed:
  package-name:
    exclude: []         # Packages to exclude
    features: []        # Features this package depends on
```

## Code Style Guidelines

### Prettier Configuration
- Tab width: 2 spaces
- No semicolons
- Single quotes
- Print width: 120
- No trailing commas

### ESLint Configuration
- Uses `@eslint/js` recommended rules
- TypeScript ESLint recommended rules
- Neostandard for additional style enforcement
- Targets: `**/*.{js,mjs,cjs,ts,mts,cts}`

### TypeScript Configuration
- Target: ESNext
- Module: NodeNext
- Strict mode enabled
- Source maps enabled
- Declaration files generated to `types/`
- Output to `lib/`

## Testing

Currently no tests are implemented. The test script outputs:
```
Error: no test specified
```

## Package Publishing

Published files (as defined in `package.json`):
- `src/` - Source code
- `lib/` - Compiled JavaScript
- `types/` - TypeScript declarations
- `package.json`
- `readme.md`

## Development Notes

1. **Entry Point**: `lib/index.js` (compiled from `src/index.ts`)
2. **Source Maps**: Enabled for debugging (`--enable-source-maps`)
3. **Git Ignore**: `node_modules/`, `lib/`, `types/`, `out.log`
4. **License**: EPL-2.0

## Security Considerations

- The tool reads and writes `package.json` files - ensure proper file permissions
- Uses `gitignore: true` when globbing to respect `.gitignore` patterns
- Does not follow symbolic links during file globbing
