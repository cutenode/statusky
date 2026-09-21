import { describe, expect, it } from 'vitest'
import { mediaListenerCount, setMediaQuery } from '../test/setup'
import { startThemeSync } from './theme.svelte'

const DARK = '(prefers-color-scheme: dark)'

describe('startThemeSync', () => {
  it('applies the current scheme immediately', () => {
    setMediaQuery(DARK, true)
    const stop = startThemeSync()

    expect(document.documentElement.classList.contains('dark')).toBe(true)
    expect(document.documentElement.style.colorScheme).toBe('dark')

    stop()
  })

  it('starts light when the system is light', () => {
    setMediaQuery(DARK, false)
    const stop = startThemeSync()

    expect(document.documentElement.classList.contains('dark')).toBe(false)
    expect(document.documentElement.style.colorScheme).toBe('light')

    stop()
  })

  it('follows the system when it changes', () => {
    setMediaQuery(DARK, false)
    const stop = startThemeSync()

    setMediaQuery(DARK, true)
    expect(document.documentElement.classList.contains('dark')).toBe(true)

    setMediaQuery(DARK, false)
    expect(document.documentElement.classList.contains('dark')).toBe(false)

    stop()
  })

  it('unsubscribes when stopped, and stops following', () => {
    setMediaQuery(DARK, false)
    const stop = startThemeSync()
    expect(mediaListenerCount(DARK)).toBe(1)

    stop()
    expect(mediaListenerCount(DARK)).toBe(0)

    setMediaQuery(DARK, true)
    expect(document.documentElement.classList.contains('dark')).toBe(false)
  })
})
