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

import type { DependencyGraph, PhaseSelection, PhaseSelectionOptions } from '../types.js'

// Phase scripts this tool knows how to run itself. Anything else in a `_phase:*`
// script is reported through `unknown` rather than silently dropped.
// `compile build` emits JS + .d.ts, `compile build-ui` only .d.ts (UI packages ship sources),
// `compile ui-esbuild` is the one svelte package that still needs esbuild.
export const BUILD_SCRIPTS = new Set<string | null>(['compile build', 'compile build-ui', 'compile ui-esbuild'])

// An explicit opt-out written by hand in package.json.
const NOOP_SCRIPTS = new Set(['echo done', ''])

function isNoop (script: string | null | undefined): boolean {
  return script == null || NOOP_SCRIPTS.has(script.trim())
}

/**
 * Decide which packages take part in which phase.
 * `targetPackages` restricts the selection to these packages (--to).
 */
export function selectPackagesForPhases (graph: DependencyGraph, options: PhaseSelectionOptions = {}): PhaseSelection {
  const {
    doTest = false,
    doBundle = false,
    doPackage = false,
    doDockerBuild = false,
    doSvelteCheck = false,
    targetPackages = null
  } = options

  const result: PhaseSelection = {
    build: [],
    test: [],
    format: [],
    bundle: [],
    package: [],
    dockerBuild: [],
    svelteCheck: [],
    unknown: []
  }

  for (const [name, node] of graph) {
    if (targetPackages != null && !targetPackages.has(name)) continue

    if (BUILD_SCRIPTS.has(node.phaseBuild)) {
      result.build.push(name)
    } else if (!isNoop(node.phaseBuild)) {
      result.unknown.push({ package: name, phase: 'build', script: node.phaseBuild as string })
    }

    // The remaining phases shell out to the package's own script, so any non-empty
    // value is runnable and there is nothing to recognise.
    if (doTest && !isNoop(node.phaseTest)) result.test.push(name)
    if (!isNoop(node.phaseFormat)) result.format.push(name)
    if (doBundle && !isNoop(node.phaseBundle)) result.bundle.push(name)
    if ((doPackage || doDockerBuild) && !isNoop(node.phasePackage)) result.package.push(name)
    if (doDockerBuild && !isNoop(node.phaseDockerBuild)) result.dockerBuild.push(name)
    if (doSvelteCheck && !isNoop(node.phaseSvelteCheck)) result.svelteCheck.push(name)
  }

  return result
}
