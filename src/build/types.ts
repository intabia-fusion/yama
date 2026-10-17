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

import type { Worker, WorkerOptions } from 'worker_threads'

// Shapes that cross a process or disk boundary stay plain JSON so a Go port can share them.
// docs/protocol.md describes the same contracts.

// yama.config.json at the workspace root (next to pnpm-workspace.yaml)

export interface YamaConfig {
  // Repo-relative files folded into every package hash (e.g. a model version file).
  hashFiles?: string[]
  bundle?: BundleConfig
  docker?: DockerConfig
  lint?: LintConfig
  coverage?: CoverageConfig
  deps?: DepsConfig
}

export interface BundleConfig {
  // A `bundle` script containing this path is run in-process with esbuild.
  standardScript?: string
  // Repo-relative file whose trimmed content is defined as process.env.MODEL_VERSION.
  modelVersionFile?: string
  // Repo-relative package dir whose bundle/model.json feeds `get-model` steps.
  modelPackage?: string
  // Escape non-Latin-1 chars in bundle.js so V8 keeps the source as 1 byte per char.
  escapeNonLatin1?: boolean
  // Default esbuild externals for the in-process bundle.
  external?: string[]
}

export interface DockerConfig {
  // Prefix for bare image names; env DOCKER_NAMESPACE wins.
  namespace?: string
}

export interface LintConfig {
  // Package (resolved from each linted package) whose node_modules ESLint plugins load from.
  pluginsPackage?: string
}

export interface CoverageConfig {
  // Repo-relative dir prefixes counted as server code in the coverage table.
  serverDirs?: string[]
  // Package providing test containers for integration runs.
  testContainersPackage?: string
  // Default dir of V8 profiles for stand coverage.
  standProfilesDir?: string
}

export interface DepsConfig {
  // npm scope checked by update-deps, e.g. "@hcengineering/".
  scope?: string
  // Package whose ESLint-related deps sync-eslint-deps copies into every project.
  eslintDepsSource?: string
}

// Workspace and dependency graph

export interface WorkspaceProject {
  name: string
  // Path relative to the workspace root.
  path: string
  fullPath: string
  private: boolean
}

export interface PackageScripts {
  phaseBuild: string | null
  phaseTest: string | null
  phaseBundle: string | null
  phasePackage: string | null
  phaseDockerBuild: string | null
  phaseFormat: string | null
  phaseSvelteCheck: string | null
  bundleScript: string | null
  packageScript: string | null
  dockerBuildScript: string | null
}

export interface PackageNode extends PackageScripts {
  project: WorkspaceProject
  dependencies: Set<string>
  dependents: Set<string>
}

export type DependencyGraph = Map<string, PackageNode>

// .fast-build-cache.json in every package dir, format v2

export interface PhaseCacheEntry {
  hash: string
  completedAt: number
  outputHash: string | null
  // Phase-specific metadata is stored flat next to the fixed fields.
  [key: string]: unknown
}

export interface PackageCacheFile {
  version: 2
  phases: Record<string, PhaseCacheEntry>
}

// Worker pool messages (parent <-> worker). JSON only: no Error objects, no functions.

export interface WorkerReadyMessage {
  type: 'ready'
  threadId: number
}

export interface WorkerExitMessage {
  type: 'exit'
}

export interface LintTaskMessage {
  type: 'lint'
  id: number
  cwd: string
  srcDir: string
  fix: boolean
}

export interface FormatTaskMessage {
  type: 'format'
  id: number
  cwd: string
  srcDir: string
}

export type WorkerTaskMessage = LintTaskMessage | FormatTaskMessage

export interface WorkerResultBase {
  id: number
  threadId: number
  success: boolean
  // Stack or message text of a failure.
  error?: string
  memoryMB?: number
  durationMs?: number
}

export interface LintResultMessage extends WorkerResultBase {
  errorCount: number
  warningCount: number
  total: number
  output: string
}

export interface FormatResultMessage extends WorkerResultBase {
  changed: number
  total: number
  errors: string[]
  errorCount: number
  warningCount: number
  lintOutput: string
  hasLintErrors: boolean
}

// TypeScript driver: the one seam between the orchestrator and the compiler.
// Today it spawns native tsc 7; a Go port calls the typescript-go API in-process instead.

export interface TscRunOptions {
  cwd: string
  // Relative to cwd.
  project: string
  tsBuildInfoFile: string
  emitDeclarationOnly: boolean
  noCheck: boolean
}

export interface TscRunResult {
  success: boolean
  // Combined stdout + stderr of the compiler.
  out: string
  // Absent when the compiler could not be started.
  exitCode?: number
  error?: string
}

export interface TypeScriptDriver {
  readonly name: string
  run: (options: TscRunOptions) => Promise<TscRunResult>
}

// Bundle, package and docker-build phases

export interface CommandError extends Error {
  stdout?: string
  stderr?: string
}

export interface PhaseStepResult {
  success: boolean
  error?: unknown
  time?: number
  fromCache?: boolean
  skipped?: boolean
}

export interface PhaseRunOptions {
  force?: boolean
  // Pre-calculated package hash used for the phase cache.
  packageHash?: string
}

export interface PhaseRunResults {
  successCount: number
  cacheHits: number
  total: number
  errors: Array<{ package: string, error: unknown }>
  time: number
}

export interface DockerImageInfo {
  exists: boolean
  hash: string | null
}

export interface DockerPhaseOptions extends PhaseRunOptions {
  imageCache?: Map<string, DockerImageInfo>
}

export interface EsbuildArgs {
  entryPoint: string
  outdir: string
  platform: 'node' | 'browser' | 'neutral'
  minify: boolean
  keepNames: boolean
  sourcemap: string | boolean
  logLevel: 'error' | 'warning' | 'info' | 'debug' | 'silent' | 'verbose'
  external: string[]
  define: Record<string, boolean>
}

// libs: colors, workspace, graph, phase-select, cache, utils

export interface ColorizedError {
  // File path (with location when present), kept free of ANSI codes for terminal links.
  plain: string
  colored: string
}

export interface WorkspaceProjectsCache {
  key: string
  projects: WorkspaceProject[]
}

export interface PackageJsonFields {
  scripts?: Record<string, string | undefined>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

export interface PackageInfo extends PackageScripts {
  dependencies: string[]
}

export interface DependencyGraphResult {
  graph: DependencyGraph
  projects: WorkspaceProject[]
  projectByName: Map<string, WorkspaceProject>
}

export interface PhaseSelectionOptions {
  doTest?: boolean
  doBundle?: boolean
  doPackage?: boolean
  doDockerBuild?: boolean
  doSvelteCheck?: boolean
  // Restrict to these packages (--to).
  targetPackages?: Set<string> | null
}

export interface UnknownPhaseScript {
  package: string
  phase: string
  script: string
}

export interface PhaseSelection {
  build: string[]
  test: string[]
  format: string[]
  bundle: string[]
  package: string[]
  dockerBuild: string[]
  svelteCheck: string[]
  unknown: UnknownPhaseScript[]
}

// `fastBuild` section of package.json
export interface FastBuildConfig {
  // Extra files, relative to the package dir.
  extraHashFiles?: string[]
  // Extra files or dirs relative to the package dir; dirs are hashed recursively.
  extraHashPaths?: string[]
}

// Cache file as read from disk: v2, or v1 with one top-level hash shared by all phases.
export interface LegacyPackageCacheFile {
  version?: number
  hash?: string
  timestamp?: number
  phases?: Record<string, Partial<PhaseCacheEntry> | null>
}

export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
  total: number
}

export interface CpuUsage {
  percent: number
  user: number
  sys: number
}

export interface CpuStats {
  avg: number
  peak: number
  min: number
  samples?: number
}

export interface PeakMemory {
  peakMB: number | null
  source: string
}

export interface PhaseMemorySpec {
  // Below this the heaviest package of the phase OOMs.
  minHeapMB: number
  // Ceiling worth giving a worker when memory allows.
  heapMB: number
  // Fixed worker ceiling for phases whose worker is multi-threaded itself.
  workers?: number
  maxWorkers?: number
}

export interface WorkerCountOverrides {
  availableMemoryMB?: number
  cpuCount?: number
}

export interface WorkerCountInfo {
  workers: number
  heapMB: number
  availableMemoryMB: number
  budgetMB: number
  cpuCount: number
  limitedByMemory: boolean
  belowSafeHeap: boolean
  minHeapMB: number
}

export interface SyncDirectoryOptions {
  removeExtra?: boolean
  verbose?: boolean
}

export interface SyncDirectoryResult {
  copied: number
  unchanged: number
  removed: number
}

// libs: task-queue

export type BuildTaskType =
  | 'transpile'
  | 'validate'
  | 'lint'
  | 'svelte-check-task'
  | 'bundle'
  | 'package'
  | 'docker-build'

export interface BuildTaskQueueOptions {
  concurrency?: number
  verbose?: boolean
}

export interface QueuedTask {
  taskType: BuildTaskType
  packageName: string
}

export interface TaskResultEntry extends QueuedTask {
  result: unknown
}

export interface TaskTypeStats {
  pending: number
  inProgress: number
  completed: number
}

// libs: workers

// Fields the pool itself reads or sets on every task it posts.
export interface WorkerTaskBase {
  id: number
  type: string
  cwd: string
}

export interface WorkerPoolOptions {
  workerOptions?: WorkerOptions
  // Replace a worker after this many tasks (0 = never).
  recycleAfter?: number
  // Replace a worker whose reported memoryMB reaches this (0 = never).
  recycleMemoryMB?: number
  // Cap on replacements of one crashed slot.
  maxRespawns?: number
}

// What a pool task resolves with. A failure carries an Error here, not the worker's message text.
export type WorkerPoolResult<TResult extends WorkerResultBase> = Omit<TResult, 'error'> & { error?: Error }

export interface PendingPoolTask<TTask extends WorkerTaskBase, TResult extends WorkerResultBase> {
  task: TTask
  resolve: (result: WorkerPoolResult<TResult>) => void
  reject: (reason: unknown) => void
}

export interface PoolWorker extends Worker {
  _workerId: number
}

export interface WorkerMemoryReport {
  after?: unknown
  [key: string]: unknown
}

// Any message a worker posts; narrowed by `type` (ready) or `id` (task result).
export interface WorkerInbound {
  type?: string
  id?: number
  threadId?: number
  memory?: WorkerMemoryReport
  memoryMB?: number
}

export interface WorkerStats {
  totalIdleTime: number
  totalWorkTime: number
  taskCount: number
  lastTaskCompletedAt: number | null
}

// libs: test-groups

export interface TestGroupSpec {
  file: RegExp
  testMatch?: string[]
  testTimeout?: number
}

export interface TestEntry {
  name: string
  cwd: string
}

export interface IsolatedTestPackage {
  name: string
  reason: string
  exclusive: boolean
}

export interface TestRunPlan {
  shared: { packages: TestEntry[], flags: string[] } | null
  isolated: IsolatedTestPackage[]
}

export type TestVerdict = { isolated: string, exclusive?: boolean } | { flags: string[] }

export interface JestProjectConfig {
  testTimeout?: number
  preset?: string
  transform?: Record<string, unknown>
  testRegex?: unknown
  testMatch?: string[]
  rootDir?: string
  displayName?: string
  [key: string]: unknown
}

export interface SharedJestConfig {
  projects: JestProjectConfig[]
  testTimeout: number | undefined
}

// Build, lint, format, svelte-check and test phases; compile; workers

export interface EsbuildOptions {
  srcDir?: string
  cwd?: string
  outDir?: string
}

export interface TscCompileOptions {
  cwd?: string
  emitDeclarationOnly?: boolean
  throwOnError?: boolean
}

export interface BuildStepResult {
  success: boolean
  error?: Error
}

export interface PhaseFailure {
  package: string
  error?: Error | string
  output?: string
}

export interface GraphPhaseOptions {
  force?: boolean
  fix?: boolean
  packageHashes?: Map<string, string>
  typesHashes?: Map<string, string>
}

export interface BuildPhaseOptions {
  force?: boolean
  packageHashes: Map<string, string>
  noTypeCheck?: boolean
  esbuildEmit?: boolean
}

export interface TestPhaseOptions {
  force?: boolean
  packageHashes?: Map<string, string>
  verbose?: boolean
  group?: boolean
}

export interface GraphPhaseResults {
  successCount: number
  cacheHits: number
  total: number
  errors: PhaseFailure[]
  time: number
  skippedCount?: number
  changedPackages?: Set<string>
  peakMemoryMB?: number
  peakChildRssMB?: number
  workers?: number
  heapMB?: number
}

export interface SvelteCheckPackageResult {
  success: boolean
  output?: string
  peakRssMB: number
  error?: Error
}

export interface SvelteCheckError {
  file: string
  message: string
}

export interface TestPackageResult {
  success: boolean
  time?: number
  fromCache?: boolean
  skipped?: boolean
  error?: CommandError
  details?: string
}

export interface TestPackageReport {
  byPackage: Map<string, { time: number, failed: boolean, details: string[] }>
  wall: number
  parsed: boolean
  output: string
}

export interface JestSuiteReport {
  name: string
  startTime: number
  endTime: number
  status: string
  message?: string
}

export interface JestReport {
  testResults?: JestSuiteReport[]
}

export interface LintPackageOptions {
  srcDir?: string
  chunkSize?: number
  fix?: boolean
}

export interface LintPackageResult {
  success: boolean
  errorCount: number
  warningCount: number
  total: number
  output: string
  memoryMB: number
  durationMs: number
}

export interface FormatPackageOptions {
  srcDir?: string
}

// errorCount and the lint fields are absent when the package has no source files.
export interface FormatPackageResult {
  success: boolean
  changed: number
  total: number
  errors: string[]
  errorCount?: number
  warningCount?: number
  lintOutput?: string
  hasLintErrors?: boolean
  memoryMB: number
  durationMs: number
}

// The slice of eslint's resolved config that the parse diagnostics read.
export interface EslintResolvedConfig {
  parser?: string
  parserOptions?: {
    project?: unknown
    tsconfigRootDir?: string
    ecmaVersion?: unknown
    sourceType?: string
  }
}

export interface EslintParserProgram {
  getSourceFile: (file: string) => { scriptKind?: number, languageVersion?: number } | undefined
  getSourceFiles?: () => unknown[]
  getSyntacticDiagnostics: (sourceFile: unknown) => unknown[]
}

export interface EslintParserModule {
  parseForESLint: (
    code: string,
    options: Record<string, unknown>
  ) => { services?: { program?: EslintParserProgram | null } }
}

// bin/coverage.ts

export interface TestContainers {
  postgresUrl: () => Promise<string>
  elasticUrl: () => Promise<string>
  kafkaBrokers: () => Promise<string>
  minioConfig: () => Promise<{ endPoint: string, port: number }>
  stopContainers: () => Promise<void>
}

export interface PackageCoverage {
  files: number
  covered: number
  total: number
}

export interface CoverageFileRow {
  file: string
  hit: number
  total: number
  owner: string | undefined
}

export interface JsonFileCoverage {
  data?: { s?: Record<string, number> }
  s?: Record<string, number>
}

// bin/bump-changes-from-tag.ts

export interface BumpProject {
  packageName: string
  projectFolder: string
  shouldPublish: boolean
}

export interface BumpedPackage extends BumpProject {
  newVersion: string
  oldVersion: string
}

export interface BumpPackageJson {
  version?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

// bin/update-deps.ts

export type DepMap = Record<string, string>

export interface DepsScanPackageJson {
  name?: string
  [depType: string]: unknown
}

export interface DepChange {
  depType: string
  depName: string
  oldVersion: string
  newVersion: string
}

// bin/sync-eslint-deps.ts

export interface EslintSyncResult {
  updated: boolean
  changes: string[]
}

export interface EslintSyncPackageJson {
  name?: string
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

// bin/check-svelte-imports.ts

export interface SvelteNamedImport {
  name: string
  local: string
  spec: string
  line: number
}

export interface CompiledSvelte {
  source: string
  js: string
}

// compile-all.ts / watch-all.ts

export interface CompileAllOptions {
  parallel?: number
  verbose?: boolean
  doTest?: boolean
  doLint?: boolean
  doFormat?: boolean
  force?: boolean
  doBundle?: boolean
  doPackage?: boolean
  doDockerBuild?: boolean
  doSvelteCheck?: boolean
  noTypeCheck?: boolean
  esbuildEmit?: boolean
  list?: boolean
  toPackage?: string | null
  forceWorkers?: boolean
  groupTests?: boolean
  lintFix?: boolean
}

export interface CompileAllCliOptions extends CompileAllOptions {
  help: boolean
  rootDir: string
}

export interface CompileAllResult {
  success: boolean
  listOnly?: boolean
  errors?: number
  time?: number
  cpuStats?: CpuStats
}

export interface CompileAllError {
  phase: string
  package: string
  error?: unknown
  output?: string
}

export interface PipelineBucket {
  successCount: number
  total: number
  cacheHits: number
  errors: Array<{ package: string, error: unknown }>
}

export interface PipelineResults {
  bundle: PipelineBucket
  package: PipelineBucket
  dockerBuild: PipelineBucket
}

export interface PhaseStat {
  name: string
  seconds: number | null
  total: number
  cacheHits: number
  errors: number
  workers?: number | null
  heapMB?: number | null
  peakChildRssMB: number
}

export interface WatchAllOptions {
  parallel: number
  verbose: boolean
  doValidate: boolean
  doLint: boolean
  force: boolean
  toPackage: string | null
  rootDir: string
  debounceMs: number
}

// __tests__/fixtures/mini-repo.ts

export interface MiniPackageSpec {
  deps?: string[]
  scripts?: Record<string, string>
  files?: Record<string, string>
  extraPkgJson?: Record<string, unknown>
  compilerOptions?: Record<string, unknown>
}

export interface MiniRepo {
  root: string
  cleanup: () => void
  pkgDir: (name: string) => string
}
