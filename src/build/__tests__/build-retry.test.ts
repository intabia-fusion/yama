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

import { describe, it, expect } from 'vitest'

import { GO_CRASH } from '../phases/build.js'

// Verbatim from pipeline 57371, where tsgo died on a different package each run.
const SEGFAULT = `unexpected fault address 0x3dd607931a88
fatal error: fault
[signal SIGSEGV: segmentation violation code=0x1 addr=0x3dd607931a88 pc=0x6862a5]

goroutine 3352 gp=0x3dd7072ffc20 m=11 mp=0x3dd70773e008 [running]:
runtime.throw({0xfdfe0a?, 0x3dd709aad2e0?})`

const PANIC = `panic: runtime error: index out of range [4294968347] with length 2799 [recovered, repanicked]

goroutine 1566 [running]:
sync.(*WaitGroup).Go.func1.1()`

const TYPE_ERROR = `src/index.ts(12,7): error TS2322: Type 'string' is not assignable to type 'number'.
src/index.ts(40,1): error TS2554: Expected 2 arguments, but got 1.`

describe('GO_CRASH', () => {
  it('matches a tsgo segfault', () => {
    expect(GO_CRASH.test(SEGFAULT)).toBe(true)
  })

  it('matches a tsgo panic', () => {
    expect(GO_CRASH.test(PANIC)).toBe(true)
  })

  it('leaves plain type errors alone', () => {
    expect(GO_CRASH.test(TYPE_ERROR)).toBe(false)
  })

  it('leaves an empty output alone', () => {
    expect(GO_CRASH.test('')).toBe(false)
  })
})
