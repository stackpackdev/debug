import { describe, it, expect } from 'vitest'
import { detectFileOrbiting } from '../src/file-orbiting.js'

// The real loop: the agent passed AuthDrawer.tsx as the suspect file across
// several debug_investigate calls while the symptom never resolved. Error-
// fingerprint orbiting missed it because the error text shifted; what stayed
// constant was the *files being edited*.
type Entry = { sourceFiles: string[]; resolved: boolean }

describe('detectFileOrbiting', () => {
  it('fires when the same file is the suspect across 3+ unresolved attempts', () => {
    const traj: Entry[] = [
      { sourceFiles: ['components/AuthDrawer.tsx'], resolved: false },
      { sourceFiles: ['components/AuthDrawer.tsx'], resolved: false },
      { sourceFiles: ['components/AuthDrawer.tsx', 'app/layout.tsx'], resolved: false },
    ]
    const r = detectFileOrbiting(traj)
    expect(r).not.toBeNull()
    expect(r!.file).toBe('components/AuthDrawer.tsx')
    expect(r!.attempts).toBe(3)
    expect(r!.message.toLowerCase()).toContain('emit')
  })

  it('does not fire below the threshold', () => {
    const traj: Entry[] = [
      { sourceFiles: ['components/AuthDrawer.tsx'], resolved: false },
      { sourceFiles: ['components/AuthDrawer.tsx'], resolved: false },
    ]
    expect(detectFileOrbiting(traj)).toBeNull()
  })

  it('does not fire when attempts touch different files', () => {
    const traj: Entry[] = [
      { sourceFiles: ['a.tsx'], resolved: false },
      { sourceFiles: ['b.tsx'], resolved: false },
      { sourceFiles: ['c.tsx'], resolved: false },
    ]
    expect(detectFileOrbiting(traj)).toBeNull()
  })

  it('does not fire if the symptom resolved at any point', () => {
    const traj: Entry[] = [
      { sourceFiles: ['x.tsx'], resolved: false },
      { sourceFiles: ['x.tsx'], resolved: true },
      { sourceFiles: ['x.tsx'], resolved: false },
    ]
    // The resolved entry breaks the streak; only one unresolved since.
    expect(detectFileOrbiting(traj)).toBeNull()
  })

  it('only counts the trailing unresolved streak', () => {
    const traj: Entry[] = [
      { sourceFiles: ['old.tsx'], resolved: true },
      { sourceFiles: ['hot.tsx'], resolved: false },
      { sourceFiles: ['hot.tsx'], resolved: false },
      { sourceFiles: ['hot.tsx'], resolved: false },
    ]
    const r = detectFileOrbiting(traj)
    expect(r!.file).toBe('hot.tsx')
    expect(r!.attempts).toBe(3)
  })
})
