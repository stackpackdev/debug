import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { traceSymptomOrigin, extractRedirectTarget } from '../src/symptom-origin.js'

// Reconstructs the real bug: a redirect to /sign-in whose origin is an
// auth guard called by an auto-firing-on-mount component — NOT the auth UI
// that the redirect points at.
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'origin-test-'))
  mkdirSync(join(root, 'app', 'create', 'preview'), { recursive: true })
  mkdirSync(join(root, 'components'), { recursive: true })
  mkdirSync(join(root, 'lib'), { recursive: true })
  mkdirSync(join(root, 'app', 'sign-in'), { recursive: true })

  // The auth guard: this is where the redirect actually comes from.
  writeFileSync(join(root, 'lib', 'auth.ts'),
    `export async function requireUserId() {\n` +
    `  const id = await getUserId()\n` +
    `  if (!id) redirect('/sign-in')\n` +
    `  return id\n}\n`)

  // A server action that calls the guard.
  writeFileSync(join(root, 'lib', 'checkout.ts'),
    `'use server'\nexport async function startDraftCheckout() {\n` +
    `  const userId = await requireUserId()\n` +
    `  return stripe.checkout.create({ userId })\n}\n`)

  // The component that auto-fires the action on mount (open={true}).
  writeFileSync(join(root, 'components', 'EmbeddedPaywall.tsx'),
    `export function EmbeddedPaywall({ open = true }) {\n` +
    `  useEffect(() => { startDraftCheckout() }, [])\n` +
    `  return <Dialog open={open} />\n}\n`)

  // The page that renders the auto-firing component for everyone.
  writeFileSync(join(root, 'app', 'create', 'preview', 'page.tsx'),
    `export default function PreviewPage() {\n` +
    `  return <EmbeddedPaywall />\n}\n`)

  // The DESTINATION — the auth UI everyone wrongly edits. It must NOT be
  // ranked as the origin.
  writeFileSync(join(root, 'components', 'AuthDrawer.tsx'),
    `export function AuthDrawer() {\n  return <SignIn />\n}\n`)
  writeFileSync(join(root, 'app', 'sign-in', 'page.tsx'),
    `export default function SignInPage() { return <AuthDrawer /> }\n`)
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('extractRedirectTarget', () => {
  it('pulls the path out of a redirect symptom string', () => {
    expect(extractRedirectTarget("anon user redirects to /sign-in unexpectedly")).toBe('/sign-in')
    expect(extractRedirectTarget("navigation to /account fails")).toBe('/account')
    expect(extractRedirectTarget("the page is blank")).toBeNull()
  })
})

describe('traceSymptomOrigin', () => {
  it('finds the redirect emitter, not the destination', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    const files = r.origins.map(o => o.file)
    // The guard that emits redirect('/sign-in') is found.
    expect(files.some(f => f.includes('auth.ts'))).toBe(true)
    // The auth UI (destination) is NOT reported as an origin.
    expect(files.some(f => f.includes('AuthDrawer'))).toBe(false)
    expect(files.some(f => f.includes('sign-in/page'))).toBe(false)
  })

  it('ranks an auto-fired (on-mount) trigger above event-driven ones', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    // The top-ranked origin chain should reach an auto-fired call site.
    const autoFired = r.origins.filter(o => o.autoFired)
    expect(autoFired.length).toBeGreaterThan(0)
    // EmbeddedPaywall's useEffect(...,[]) is the auto-fire site.
    expect(autoFired.some(o => o.callers.some(c => c.includes('EmbeddedPaywall')))).toBe(true)
    // Auto-fired origins sort first.
    expect(r.origins[0].autoFired).toBe(true)
  })

  it('produces a human-readable nextStep that names the auto-fire trap', () => {
    const r = traceSymptomOrigin(root, '/sign-in')
    expect(r.summary.toLowerCase()).toContain('mount')
    expect(r.summary).toContain('/sign-in')
  })
})
