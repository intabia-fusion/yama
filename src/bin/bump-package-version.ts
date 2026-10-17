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

import { exec } from 'child_process'

exec('git describe --tags --abbrev=0 --match="v*"', (err, stdout) => {
  if (err !== null) {
    if (err.message.includes('No names found')) {
      console.log('No git version available')
      return
    }
    console.log('Error', err)
    process.exit(1)
  }
  const rawVersion = stdout.trim().replace('v', '').replace('u', '').replace('s', '').split('.')
  if (rawVersion.length === 3) {
    const version = {
      major: parseInt(rawVersion[0]),
      minor: parseInt(rawVersion[1]),
      patch: parseInt(rawVersion[2])
    }
    const versionStr = `${version.major}.${version.minor}.${version.patch}`
    console.log(`Setting version to ${versionStr}`)
    exec(`npm version ${versionStr}`)
  }
})
