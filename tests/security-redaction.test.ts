import { describe, it, expect } from 'vitest'
import { redactSensitiveData, redactCaptureValue } from '../src/security.js'

// Regression tests for the secret-leak bug: a live Neon DATABASE_URL
// (postgresql:// with embedded credentials) reached debug://status in plaintext.
// Redaction must cover the connection-string variants and URL-embedded secrets
// that actually appear in dev-server output and browser network captures.

describe('redactSensitiveData — connection strings', () => {
  it('redacts a Neon postgresql:// URL with credentials (the reported leak)', () => {
    const line = 'Connected to postgresql://neon_user:npg_secretPassword123@ep-cool-pg.neon.tech/neondb?sslmode=require'
    const out = redactSensitiveData(line)
    expect(out).not.toContain('npg_secretPassword123')
    expect(out).not.toContain('neon_user')
    expect(out).toContain('[REDACTED')
  })

  it('redacts a DATABASE_URL= assignment carrying a postgresql connection string', () => {
    const line = 'DATABASE_URL=postgresql://user:p4ssw0rd@host.neon.tech/db'
    const out = redactSensitiveData(line)
    expect(out).not.toContain('p4ssw0rd')
  })

  it('still redacts postgres:// (no -ql) and other scheme variants', () => {
    expect(redactSensitiveData('postgres://u:pw@h/db')).not.toContain('pw')
    expect(redactSensitiveData('mongodb+srv://u:pw@cluster.mongodb.net/db')).not.toContain('pw')
  })
})

describe('redactSensitiveData — URL-embedded secrets', () => {
  it('redacts basic-auth credentials in an https URL', () => {
    const out = redactSensitiveData('GET https://admin:supersecret@api.example.com/v1/data → 200')
    expect(out).not.toContain('supersecret')
  })

  it('redacts a token in a query string', () => {
    const out = redactSensitiveData('GET https://api.neon.tech/auth?token=sk_neon_abc123XYZdef456ghi789 → 200')
    expect(out).not.toContain('sk_neon_abc123XYZdef456ghi789')
  })
})

describe('redactCaptureValue — deep redaction of capture data', () => {
  it('redacts strings nested in capture data objects (debug_capture output path)', () => {
    const data = {
      stream: 'stdout',
      text: 'Connected to postgresql://u:npg_secret123@ep.neon.tech/db',
      url: 'https://api.example.com/x?api_key=live_key_abcdef123456',
      args: ['ok', 'DATABASE_URL=postgres://u:pw@h/db'],
    }
    const out = redactCaptureValue(data)
    expect(JSON.stringify(out)).not.toContain('npg_secret123')
    expect(JSON.stringify(out)).not.toContain('live_key_abcdef123456')
    expect(JSON.stringify(out)).not.toContain('pw@h')
    expect(out.stream).toBe('stdout') // non-secret fields preserved
  })

  it('passes through non-string primitives untouched', () => {
    expect(redactCaptureValue(200)).toBe(200)
    expect(redactCaptureValue(null)).toBe(null)
    expect(redactCaptureValue(true)).toBe(true)
  })
})
