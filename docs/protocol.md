# yama build: contracts

The build system talks to the outside world through four contracts: the workspace layout and package scripts it reads, the per-package cache file it writes, the messages it exchanges with worker threads, and the TypeScript driver. A second implementation (the planned Go port on top of the typescript-go API) must keep all four byte-compatible, so both can run against the same checkout and share caches while phases move over one at a time. The TypeScript shapes are in `src/build/types.ts`.

## Workspace

- The root is the nearest directory with `pnpm-workspace.yaml`. Projects are the `packages:` globs of that file; each project is a directory with a `package.json` that has a `name`.
- Edges of the dependency graph are entries of `dependencies`, `devDependencies` and `peerDependencies` whose version starts with `workspace:` or `link:` and whose name is a project of the workspace.
- A package takes part in a phase through a script in its `package.json`:

| Script | Phase | Recognised values |
|---|---|---|
| `_phase:build` | build | `compile build` (lib + types), `compile build-ui` (types only, the package ships sources), `compile ui-esbuild` (svelte compiled to lib) |
| `_phase:format` | format, lint | `format <dir>` |
| `_phase:svelte-check` | svelte-check | any non-noop value |
| `_phase:test` | test | any non-noop value; shared jest run when the `test` script is `jest ...` |
| `_phase:bundle` | bundle | any non-noop value; the `bundle` script is what runs |
| `_phase:package` | package | any non-noop value; runs `pnpm run package` |
| `_phase:docker-build` | docker-build | any non-noop value; runs `pnpm run docker:build` |

`''` and `echo done` are an explicit opt-out. Any other `_phase:build` value is reported as unknown and the package is not built.

Other `package.json` fields: `fastBuild.extraHashFiles` / `fastBuild.extraHashPaths` (more hash inputs, paths may leave the package), `testIsolated: true` (the package's tests never share a jest process).

## yama.config.json

Optional, at the workspace root. Everything the build needs to know about one particular repository lives here, so the code carries no repository names or paths. See `YamaConfig` in `src/build/types.ts`; a missing file is an empty config, a file that does not parse is an error.

## Cache file

One file per package: `<package>/.fast-build-cache.json`, JSON, 2-space indent.

```json
{
  "version": 2,
  "phases": {
    "<phase key>": { "hash": "<hex>", "completedAt": 1760000000000, "outputHash": "<hex or null>", "...": "phase metadata" }
  }
}
```

- Phase keys: `build-split`, with suffixes `-nocheck` (`--no-type-check`) and `-esbuild` (`--esbuild-emit`); `lint`, `format`, `svelte-check`, `test`, `bundle`, `package`, `docker-build`.
- A phase is up to date when the stored `hash` equals the freshly computed input hash and, if `outputHash` is stored, the hash of the phase output directories is unchanged.
- A v1 file (one top-level `hash`) is migrated on load; any other shape is discarded.

### Hashes

- File signature: `<xxh64 of content, hex>:<size in bytes>`. Content, not mtime: a git checkout touches mtimes.
- Package hash: MD5 of newline-joined lines, in order: `src:<path>=<sig>` for `src/` (`.ts .tsx .js .jsx .svelte .json`, sorted by path), `tests:<path>=<sig>` for `tests/` (`.ts .tsx .js .jsx .json`), `<label>:<sig>` for `package.json`, `tsconfig.json`, `Dockerfile`, every `hashFiles` entry of `yama.config.json` (label = the entry as written), and the `fastBuild` extra files and paths. Missing files are skipped, as are `node_modules` and symlinks.
- Build, lint and svelte-check key on dependency outputs, not sources: MD5 of `self:<package hash>`, then `<dep>:types:<hash of the dep's types/>` for every transitive dependency, then `cfg:<file>:<xxh64>` for the phase config files (build: `tsconfig.json`; lint: ESLint configs; svelte-check: `svelte.config.js`, `tsconfig.json`).
- Bundle, package and docker-build: MD5 of the package hash and the sorted hashes of all transitive dependencies.
- Test: `<package hash>-<first 8 hex of MD5(DB_URL, ELASTIC_URL, MONGO_URL)>`.
- Docker image label `PACKAGE_HASH`: `<package hash>-<first 12 hex of MD5 of bundle/ without .map files>`.

The exact byte order of every hash input is defined by `src/build/libs/cache.ts` and `src/build/libs/composite-hash.ts`; a port reproduces it there, not from this summary.

## Worker messages

Lint and format run in worker threads. Messages are plain JSON objects: no `Error` instances, functions or Maps, so a worker can later sit behind any transport.

Parent to worker:

- `{ "type": "lint", "id": 1, "cwd": "<package dir>", "srcDir": "src", "fix": false }`
- `{ "type": "format", "id": 2, "cwd": "<package dir>", "srcDir": "src" }`
- `{ "type": "exit" }`

Worker to parent:

- `{ "type": "ready", "threadId": 3 }` once, after start.
- A result with the task `id`, `threadId`, `success`, optional `error` (stack text), `memoryMB`, `durationMs` and the task fields: lint `errorCount`, `warningCount`, `total`, `output`; format `changed`, `total`, `errors`, `errorCount`, `warningCount`, `lintOutput`, `hasLintErrors`.

The pool recycles a worker after a task count or heap threshold and respawns a crashed one; a result from a replaced worker is ignored.

## TypeScript driver

The orchestrator never spawns the compiler itself; it calls `TypeScriptDriver.run({ cwd, project, tsBuildInfoFile, emitDeclarationOnly, noCheck })` and gets `{ success, out, error }`. The current driver spawns native `tsc` from TypeScript 7 (`TSC7_BIN` overrides the binary). Crash retry (a Go runtime panic in tsc, not a type error) stays in the build phase, above the driver. A Go implementation replaces the driver with an in-process call into typescript-go and keeps the rest of the build phase.

## Outputs per package

`lib/` (JS + maps), `types/` (`.d.ts`), `.build/` (`build.tsbuildinfo`, `compile.log`, `svelte-dts/`), `bundle/`, `dist/`, `.eslintcache`, `.svelte-check/`.
