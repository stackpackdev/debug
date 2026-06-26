import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceSymptomOrigin } from '../src/symptom-origin.js'

// A noisier, more Next.js-shaped fixture: the tracer must still pick the real
// emitter and the auto-fire trap out of a tree full of unrelated files and
// an event-driven (non-auto) sign-in button that must NOT outrank it.
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'origin-real-'))
  for (const d of ['app/create/preview', 'app/(marketing)', 'components/ui', 'lib', 'server/actions']) {
    mkdirSync(join(root, d), { recursive: true })
  }
  // Noise.
  writeFileSync(join(root, 'app/(marketing)/page.tsx'), `export default function Home() { return <h1>hi</h1> }\n`)
  writeFileSync(join(root, 'components/ui/Button.tsx'), `export function Button(p) { return <button {...p} /> }\n`)
  writeFileSync(join(root, 'lib/format.ts'), `export const fmt = (n) => n.toFixed(2)\n`)

  // Real guard.
  writeFileSync(join(root, 'lib/auth.ts'),
    `import { redirect } from 'next/navigation'\n` +
    `export async function requireUserId() {\n` +
    `  const id = await session()\n` +
    `  if (!id) redirect('/sign-in')\n  return id\n}\n`)
  // Server action wrapping the guard.
  writeFileSync(join(root, 'server/actions/checkout.ts'),
    `'use server'\nimport { requireUserId } from '@/lib/auth'\n` +
    `export async function startDraftCheckout() {\n  const u = await requireUserId()\n  return mkSession(u)\n}\n`)
  // Auto-firing component.
  writeFileSync(join(root, 'components/EmbeddedPaywall.tsx'),
    `import { startDraftCheckout } from '@/server/actions/checkout'\n` +
    `export function EmbeddedPaywall({ open = true }) {\n` +
    `  useEffect(() => { startDraftCheckout() }, [])\n  return <Dialog open={open} />\n}\n`)
  writeFileSync(join(root, 'app/create/preview/page.tsx'),
    `import { EmbeddedPaywall } from '@/components/EmbeddedPaywall'\n` +
    `export default function Preview() { return <EmbeddedPaywall /> }\n`)

  // An EVENT-DRIVEN sign-in trigger — legitimately calls requireUserId behind a
  // click. It must be found but NOT outrank the auto-fired paywall.
  writeFileSync(join(root, 'components/ui/SignInButton.tsx'),
    `export function SignInButton() {\n` +
    `  return <button onClick={() => requireUserId()}>Sign in</button>\n}\n`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('traceSymptomOrigin — realistic tree', () => {
  it('identifies the guard file as the emitter', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    expect(r.origins.length).toBeGreaterThan(0)
    expect(r.origins.some(o => o.file.includes('auth.ts'))).toBe(true)
  })

  it('reaches the on-mount paywall through the server action (2-hop)', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    const allCallers = r.origins.flatMap(o => o.callers).join(' | ')
    expect(allCallers).toContain('EmbeddedPaywall')
    expect(allCallers.toLowerCase()).toContain('mount')
  })

  it('ranks the auto-fired origin first and summary warns about it', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    expect(r.origins[0].autoFired).toBe(true)
    expect(r.summary.toLowerCase()).toMatch(/mount|auto-fired|no user click/)
  })
})
