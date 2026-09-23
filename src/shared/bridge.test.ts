import { afterEach, describe, expect, it } from 'vitest'
import { bridge, ipcErrorMessage } from './bridge'
import { installBridge } from '../test/bridge'

const global = globalThis as Record<string, unknown>

afterEach(() => {
  delete global.statusky
})

describe('bridge', () => {
  it('hands back whatever the preload exposed', () => {
    const installed = installBridge()
    expect(bridge()).toBe(installed.api)
    installed.restore()
  })

  // The preload only exposes the API to a page that passes the origin check, so this
  // is what a page that should not have it actually sees.
  it('explains itself when nothing was exposed', () => {
    delete global.statusky
    expect(() => bridge()).toThrow('This page is not allowed to talk to Statusky.')
  })
})

describe('ipcErrorMessage', () => {
  it('unwraps the message Electron put a channel in front of', () => {
    const error = new Error(
      "Error invoking remote method '$eipc_message$_9f2_$_statusky_$_Accounts_$_add': " +
        'Error: Profile not found for @nobody.invalid.'
    )
    expect(ipcErrorMessage(error)).toBe('Profile not found for @nobody.invalid.')
  })

  it('leaves a message that was never wrapped alone', () => {
    expect(ipcErrorMessage(new Error('Only http and https links can be opened.'))).toBe(
      'Only http and https links can be opened.'
    )
  })

  it('strips a bare error-class prefix', () => {
    expect(ipcErrorMessage(new Error('TypeError: x is not a function'))).toBe('x is not a function')
  })

  it('stringifies a rejection that is not an Error', () => {
    expect(ipcErrorMessage('a bare string')).toBe('a bare string')
    expect(ipcErrorMessage(undefined)).toBe('undefined')
  })

  // Electron sends a failure back as `String(error)`, so it names whatever class main
  // threw; neither that nor the generated channel name is anything a person should see.
  it('unwraps a failure main threw as some other class of error', () => {
    const error = new Error(
      "Error invoking remote method '$eipc_message$_deadbeef_$_statusky_$_State_$_get': " +
        "TypeError: Cannot read properties of undefined (reading 'did')"
    )
    expect(ipcErrorMessage(error)).toBe("Cannot read properties of undefined (reading 'did')")
  })
})
