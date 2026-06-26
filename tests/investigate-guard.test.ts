import { describe, it, expect } from 'vitest'

// The guard logic lives inline in mcp.ts. We test the regex directly here so
// that the rule is documented as a pinned contract: these inputs must trip
// the guard, these must not.

const placeholderPatterns = [/\[Component\]/, /<Component>/, /(^|\s)%[sdofij](\s|$)/]
function shouldGuard(s: string): boolean {
  return placeholderPatterns.some(rx => rx.test(s))
}

describe('debug_investigate placeholder guard', () => {
  it('catches [Component] placeholders', () => {
    expect(shouldGuard('Error in [Component]')).toBe(true)
  })

  it('catches <Component> placeholders', () => {
    expect(shouldGuard('Failed render: <Component>')).toBe(true)
  })

  it('catches unsubstituted %s tokens', () => {
    expect(shouldGuard('Error in %s at line 42')).toBe(true)
    expect(shouldGuard('values: %d %o')).toBe(true)
  })

  it('does not trip on resolved component names', () => {
    expect(shouldGuard('Error in IndexProgressBar at line 42')).toBe(false)
    expect(shouldGuard('TypeError: cannot read property of undefined')).toBe(false)
  })

  it('does not trip on % inside words (edge case)', () => {
    expect(shouldGuard('discount: 50%off')).toBe(false)
    expect(shouldGuard('coverage: 100%')).toBe(false)
  })
})
