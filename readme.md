# yama

Yet another multi-repository manager: a build system and a set of dependency tools for large pnpm monorepos written in TypeScript and Svelte.

One process walks the workspace dependency graph and runs the build, lint, format, svelte-check, test, bundle, package and docker-build phases for every package, in dependency order, with a content-hashed cache per package and per phase. Type checking is done by the native TypeScript 7 compiler (`tsc` from `typescript@7`), JS is emitted by esbuild.

```bash
npm i -D @intabia-fusion/yama
npx compile-all . --parallel
```

## Why

Managing dependencies and versions of a multi-repo with rush.js, turbo and pnpm turned into a daily fight. yama is one orchestrator that knows the package graph, runs every phase in-process or through bounded worker pools, and only redoes work whose inputs changed.

## Requirements

- Node.js 20 or newer.
- A pnpm workspace: `pnpm-workspace.yaml` at the root with a `packages:` list.
- `eslint`, `prettier` and `svelte` are optional peer dependencies, needed only for the lint, format and Svelte phases. They are resolved from the package being processed first, so a repository keeps its own versions.

## How a package takes part

Packages opt into phases with `_phase:*` scripts in their `package.json`. Edges of the graph are workspace dependencies (`workspace:` or `link:` versions in `dependencies`, `devDependencies` or `peerDependencies`).

```json
{
  "scripts": {
    "build": "compile",
    "_phase:build": "compile build",
    "_phase:format": "format src",
    "_phase:test": "jest --passWithNoTests --silent",
    "_phase:bundle": "pnpm run bundle",
    "_phase:docker-build": "pnpm run docker:build"
  }
}
```

| Script | Phase | Values |
|---|---|---|
| `_phase:build` | build | `compile build` (JS in `lib/`, declarations in `types/`), `compile build-ui` (declarations only, the package ships sources), `compile ui-esbuild` (Svelte compiled to `lib/`) |
| `_phase:format` | format, lint | `format <dir>` |
| `_phase:svelte-check` | svelte-check | any value except a no-op |
| `_phase:test` | test | any value except a no-op; packages whose `test` script is `jest ...` share one jest run |
| `_phase:bundle` | bundle | any value except a no-op; runs the package's `bundle` script |
| `_phase:package` | package | any value except a no-op; runs `pnpm run package` |
| `_phase:docker-build` | docker-build | any value except a no-op; runs `pnpm run docker:build` |

`''` and `echo done` mean "skip this phase". An unrecognised `_phase:build` value is reported and the package is not built.

Optional fields:

- `fastBuild.extraHashFiles`, `fastBuild.extraHashPaths` - more cache inputs (for example a webpack config), paths may point outside the package.
- `testIsolated: true` - the package's tests never share a jest process.

## compile-all

```bash
compile-all <root> [options]
```

| Option | Meaning |
|---|---|
| `--to <pkg>` | Only this package and its dependencies. Repeatable, comma-separated values allowed. |
| `--parallel, -p [n]` | Worker count. Without a number: CPU count, limited by available memory. |
| `--lint` | ESLint after the build, for packages with `_phase:format`. `--fix` applies fixes. |
| `--format` | Build, then prettier + `eslint --fix` for packages with `_phase:format`. |
| `--svelte-check` | svelte-check for packages with `_phase:svelte-check`. |
| `--test` | Tests for packages with `_phase:test`. `--no-test-group` gives every package its own jest process. |
| `--bundle` | Bundle phase. |
| `--package` | Package phase, implies `--bundle`. |
| `--docker-build` | Docker images, implies `--package` and `--bundle`. Images are labelled with their input hash and rebuilt only when it changes. |
| `--force, -f` | Ignore the cache. With a single leaf phase (`--lint`, `--test`, ...) only that phase is forced. |
| `--no-type-check` | Emit with `tsc --noCheck`. |
| `--esbuild-emit` | JS from esbuild, declarations only from tsc. |
| `--list, -l` | Print what would run per phase and exit. |
| `--force-workers` | Use exactly `--parallel` workers, skip memory limits. |
| `--verbose, -v` | Per-package output. |

Environment: `TO`, `LIST=1`, `VERBOSE=1` mirror the flags; `FAST_BUILD_WORKERS`, `FAST_BUILD_MEMORY_MB` and the per-phase `FAST_BUILD_*_WORKERS` / `FAST_BUILD_*_HEAP_MB` override the memory planner; `TSC7_BIN` points at a different `tsc` binary; `TSC_CRASH_RETRIES` (default 2) retries a crashed compiler, never a type error; `DOCKER_NAMESPACE` prefixes image names.

`yama build <root> [options]` runs the same command.

## Other commands

| Command | What it does |
|---|---|
| `watch-all <root>` | Watches package sources and rebuilds changed packages and their dependents. `--lint`, `--to`, `--debounce <ms>`. |
| `compile [build\|build-ui\|ui-esbuild\|svelte-dts]` | Builds the package in the current directory (the per-package `build` script). |
| `format [dir]` | Formats one package (prettier, then `eslint --fix`). |
| `do-svelte-check` | Runs svelte-check for one package and prints parsed errors. |
| `check-svelte-imports <root>` | Reports unresolved imports and missing exports in `.svelte` files. |
| `yama-jest` | One jest run over all packages with tests, using the root `jest.config.js`. |
| `yama-test-group <integration\|bench>` | Runs `*.itest.*` or `*.bench.*` files across the workspace. |
| `yama-coverage` | Workspace coverage from jest and vitest runs, merged into one istanbul report. |
| `yama-stand-coverage` | Converts V8 coverage profiles collected from running containers to istanbul, using bundle source maps. |
| `bump-package-version`, `bump-changes-from-tag` | Version bumps from git tags. |
| `update-deps` | Checks the registry for newer versions of the packages in `deps.scope`. |
| `sync-eslint-deps` | Copies ESLint-related dependencies of `deps.eslintDepsSource` into every project. |
| `yama deps <root>` | Dependency tree, cycles, build order, dependents. |
| `yama external-deps <root>` | External npm dependencies: usage counts, versions, sizes. |
| `yama where-used <root> <package>` | Where a dependency is used. |
| `yama sync-versions <root>` | Aligns every dependency to the highest version used in the workspace. |
| `yama list <root> [folder\|feature]` | Lists packages. |

Test files are grouped by name: `*.test.*` / `*.spec.*` are unit tests, `*.itest.*` integration tests, `*.bench.*` benchmarks.

## yama.config.json

Everything that is specific to one repository lives in an optional `yama.config.json` next to `pnpm-workspace.yaml`. A missing file means defaults; a file that does not parse is an error.

```json
{
  "hashFiles": ["common/scripts/version.txt"],
  "bundle": {
    "standardScript": "common/scripts/esbuild.js",
    "modelVersionFile": "common/scripts/version.txt",
    "modelPackage": "models/all",
    "escapeNonLatin1": true,
    "external": ["snappy"]
  },
  "docker": { "namespace": "myorg" },
  "lint": { "pluginsPackage": "@myorg/build-rig" },
  "coverage": {
    "serverDirs": ["server/", "services/"],
    "testContainersPackage": "@myorg/test-containers",
    "standProfilesDir": "api-tests/coverage"
  },
  "deps": { "scope": "@myorg/", "eslintDepsSource": "@myorg/build-rig" }
}
```

| Field | Effect |
|---|---|
| `hashFiles` | Repository files folded into every package hash; changing one rebuilds everything. |
| `bundle.standardScript` | A `bundle` script that calls this file is bundled by esbuild in-process instead of spawning `pnpm run bundle`. |
| `bundle.modelVersionFile` | Its content becomes `process.env.MODEL_VERSION` in bundles that ask for it. |
| `bundle.modelPackage` | Package whose `bundle/model.json` feeds `get-model` steps. |
| `bundle.escapeNonLatin1` | Escapes non-Latin-1 characters in `bundle.js`, so V8 stores the source as one byte per character. |
| `bundle.external` | Default esbuild externals. |
| `docker.namespace` | Prefix for bare image names. |
| `lint.pluginsPackage` | Package whose `node_modules` ESLint loads plugins from. |
| `coverage.*` | What `yama-coverage` counts as server code, which package starts test containers, where stand profiles are. |
| `deps.*` | Scope for `update-deps`, source package for `sync-eslint-deps`. |

## Cache

Each package keeps `.fast-build-cache.json` with one entry per phase. Inputs are hashed by content (xxh64), not mtime, so switching branches does not invalidate everything. Build, lint and svelte-check key on the package's own sources plus the emitted `types/` of its dependencies, so a change that does not alter a dependency's declarations does not rebuild its dependents. Bundle, package and docker-build key on the sources of the whole dependency closure. The format is described in [docs/protocol.md](docs/protocol.md).

## Towards Go

The orchestrator is written so that it can be ported to Go once the typescript-go API is usable from Go:

- The compiler is reached only through the `TypeScriptDriver` interface. Today it spawns the native `tsc`; a Go version calls typescript-go in-process. esbuild already has a Go API.
- Everything that crosses a process or disk boundary - `yama.config.json`, the cache file, worker messages - is plain JSON with its shape in `src/build/types.ts` and its rules in [docs/protocol.md](docs/protocol.md). A Go implementation can share caches with this one and take over phase by phase.
- ESLint and prettier run in Node worker threads that only exchange JSON messages, so a Go orchestrator can keep them in Node.
- The smoke tests drive the `compile-all` binary as a black box. `YAMA_BIN=/path/to/binary pnpm test` runs them against another implementation.

## Development

```bash
pnpm install
pnpm build      # tsc -> lib/, types/
pnpm test       # build + vitest
pnpm lint
```

Layout: `src/build/` - orchestrator (`libs/`, `phases/`, `workers/`, `drivers/`, `compile-all.ts`, `watch-all.ts`); `src/bin/` - CLI entry points; `src/tools/` - dependency tools behind the `yama` command.

## License

EPL-2.0
