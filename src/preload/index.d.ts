import type { StatuskyBridge } from '../shared/bridge'

declare global {
  interface Window {
    /**
     * Exposed by the generated preload wiring — but only to a frame that passes the
     * origin check, so it is genuinely absent on any page that should not have it.
     */
    statusky?: StatuskyBridge
  }
}

export {}
