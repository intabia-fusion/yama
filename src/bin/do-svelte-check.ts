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

import { join } from 'path'
import { readFileSync, existsSync, mkdirSync, createWriteStream } from 'fs'
import { spawn } from 'child_process'
import type { SvelteCheckError } from '../build/types.js'

function parseSvelteCheckLog (logContent: string): void {
  const lines = logContent.split('\n')
  const errors: SvelteCheckError[] = []
  let currentError: SvelteCheckError | null = null

  let pline = ''
  for (const line of lines) {
    if (line.includes('Error:')) {
      // Start of a new error
      if (currentError) {
        errors.push(currentError)
      }
      currentError = {
        file: pline,
        message: line.split('Error:')[1].trim()
      }
    } else if (line.includes('====================================')) {
      // End of log, push last error if exists
      if (currentError) {
        errors.push(currentError)
      }
      break
    }
    pline = line
  }

  // Print errors
  if (errors.length === 0) {
    console.log('No errors found')
  } else {
    errors.forEach((error) => {
      console.log(`File: ${error.file}`)
      console.log(`Message: \x1b[31m ${error.message} \x1b[0m\n`)
    })
  }
}

async function execProcess (cmd: string, logFile: string, args: string[], useConsole: boolean): Promise<void> {
  console.log('Svelte check...\n')

  if (!existsSync(join(process.cwd(), '.svelte-check'))) {
    mkdirSync(join(process.cwd(), '.svelte-check'))
  }

  const compileOut = spawn(cmd, args)

  const stdoutFilePath = `.svelte-check/${logFile}.log`
  const stderrFilePath = `.svelte-check/${logFile}-err.log`

  const outPromise = new Promise<void>((resolve) => {
    if (compileOut.stdout != null) {
      const outPipe = createWriteStream(stdoutFilePath)
      compileOut.stdout.pipe(outPipe)
      compileOut.stdout.on('end', function () {
        outPipe.close()
        if (useConsole) {
          const data = readFileSync(stdoutFilePath).toString() + readFileSync(stderrFilePath).toString()
          parseSvelteCheckLog(data)
        }
        resolve()
      })
    } else {
      resolve()
    }
  })

  const errPromise = new Promise<void>((resolve) => {
    if (compileOut.stderr != null) {
      const outPipe = createWriteStream(stderrFilePath)
      compileOut.stderr.pipe(outPipe)
      compileOut.stderr.on('end', function () {
        outPipe.close()
        resolve()
      })
    } else {
      resolve()
    }
  })

  let editCode: number | null = 0
  const closePromise = new Promise<void>((resolve) => {
    compileOut.on('close', (code) => {
      editCode = code
      resolve()
    })
    compileOut.on('error', (err) => {
      console.error(err)
      resolve()
    })
  })

  await Promise.all([outPromise, errPromise, closePromise])

  if (editCode !== 0) {
    if (!useConsole) {
      const data = readFileSync(stdoutFilePath).toString()
      const errData = readFileSync(stderrFilePath).toString()
      parseSvelteCheckLog(data)
      console.error('\n' + errData.toString())
    }
    process.exit(editCode ?? undefined)
  }
}

const args: string[] = []
let useConsole = false
for (const a of process.argv.slice(2)) {
  if (a === '--console') {
    useConsole = true
  } else {
    args.push(a)
  }
}
const st = performance.now()
execProcess('svelte-check', 'svelte-check', ['--output', 'human', ...args], useConsole).then(() => {
  console.log('Svelte check time: ', Math.round((performance.now() - st) * 100) / 100)
}).catch((err: unknown) => {
  console.error(err)
  process.exitCode = 1
})
