import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLoopEvent } from '@stackpack/loop-protocol'
import { rehydrateFromDisk, eventsPath } from '../src/loop-server.js'
import { loopBus } from '../src/loop-bus.js'

let cwd: string

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'spdg-rehy-'))
  loopBus.clear()
})

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true })
})

describe('rehydrateFromDisk', () => {
  it('returns 0 when no file exists', () => {
    expect(rehydrateFromDisk(cwd)).toBe(0)
    expect(loopBus.timeline().length).toBe(0)
  })

  it('replays JSONL events into the bus', () => {
    mkdirSync(join(cwd, '.debug'), { recursive: true })
    const e1 = createLoopEvent({ source: 'state', kind: 'mutation', storeName: 'a', payload: {} })
    const e2 = createLoopEvent({ source: 'browser', kind: 'console.error', payload: { message: 'x' } })
    writeFileSync(eventsPath(cwd), JSON.stringify(e1) + '\n' + JSON.stringify(e2) + '\n')

    const n = rehydrateFromDisk(cwd)
    expect(n).toBe(2)
    expect(loopBus.timeline().map(e => e.id)).toEqual([e1.id, e2.id])
  })

  it('skips torn / malformed lines without crashing', () => {
    mkdirSync(join(cwd, '.debug'), { recursive: true })
    const e1 = createLoopEvent({ source: 'state', kind: 'mutation', storeName: 'a', payload: {} })
    writeFileSync(
      eventsPath(cwd),
      JSON.stringify(e1) + '\nnot json\n{"id":"truncate' + '\n',
    )
    const n = rehydrateFromDisk(cwd)
    expect(n).toBe(1)
  })
})
