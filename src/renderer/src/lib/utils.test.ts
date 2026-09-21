import { describe, expect, it } from 'vitest'
import { cn } from './utils'

describe('cn', () => {
  it('joins class names', () => {
    expect(cn('a', 'b')).toBe('a b')
  })

  it('drops falsy values so conditional classes stay readable', () => {
    const enabled = false
    expect(cn('a', enabled && 'b', null, undefined, '', 'c')).toBe('a c')
  })

  it('accepts arrays and objects, the way clsx does', () => {
    expect(cn(['a', 'b'], { c: true, d: false })).toBe('a b c')
  })

  it('lets a later Tailwind class win over an earlier one in the same group', () => {
    expect(cn('px-2', 'px-4')).toBe('px-4')
    expect(cn('text-sev-resolved', 'text-sev-outage')).toBe('text-sev-outage')
  })

  it('keeps classes from different groups', () => {
    expect(cn('px-2 text-sm', 'py-1')).toBe('px-2 text-sm py-1')
  })

  it('returns an empty string for no input', () => {
    expect(cn()).toBe('')
  })
})
