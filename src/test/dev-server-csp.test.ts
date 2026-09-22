/**
 * The gap between the policy the renderer ships with and the one the dev server has to
 * send.
 *
 * The shipped `<meta>` policy is the window's only guard against a compromised feed item
 * turning into code, so the interesting thing to pin down is not that development works
 * — that is visible the moment you edit a file — but that making it work left the
 * packaged policy exactly where it was.
 */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Plugin } from 'vite'
import config, { allowDevServerWorkers } from '../../electron.vite.config'

const INDEX_HTML = readFileSync(resolve('src/renderer/index.html'), 'utf8')

/** The page as the dev server sends it: the file on disk, run through the plugin. */
function asServed(html: string): string {
  const transform = allowDevServerWorkers().transformIndexHtml
  const rewrite = (typeof transform === 'object' ? transform?.handler : transform) as unknown as (
    html: string
  ) => string
  return rewrite(html)
}

/** The value of the page's `Content-Security-Policy` meta tag, directive by directive. */
function policy(html: string): string[] {
  const content = html.match(
    /<meta[^>]+http-equiv="Content-Security-Policy"[^>]+content="([^"]*)"/
  )?.[1]
  if (content === undefined) throw new Error('the renderer has no CSP meta tag')
  return content.split(';').map((directive) => directive.trim())
}

describe('the dev server CSP', () => {
  it('lets the dev client build its reconnect worker out of a blob', () => {
    expect(policy(asServed(INDEX_HTML))).toContain("worker-src 'self' blob:")
  })

  /**
   * The rest of the policy is the reason this is a rewrite of one directive rather than
   * a second policy written out for development: a relaxation nobody meant to make would
   * live here for as long as it took someone to read the served page.
   */
  it('changes nothing else about the policy', () => {
    const shipped = policy(INDEX_HTML)
    expect(policy(asServed(INDEX_HTML)).filter((d) => !d.startsWith('worker-src'))).toEqual(shipped)
  })

  it('leaves the shipped policy with no worker source at all', () => {
    expect(INDEX_HTML).not.toContain('blob:')
    expect(policy(INDEX_HTML).some((directive) => directive.startsWith('worker-src'))).toBe(false)
  })

  /** A build must not reach the plugin at all, which is what `apply: 'serve'` states. */
  it('is a dev-server plugin the renderer actually loads', () => {
    const plugins = (config.renderer?.plugins ?? []).flat() as Plugin[]
    const wired = plugins.find((plugin) => plugin?.name === 'statusky:dev-server-csp')
    expect(wired?.apply).toBe('serve')
  })

  /**
   * Why the plugin exists, asserted against the thing that motivated it: Vite's dev
   * client polls for a restarted server from a SharedWorker it builds out of a blob URL.
   * When a Vite upgrade stops doing that, this fails — and the plugin above, along with
   * this file, can go.
   */
  it('is still needed, because the dev client still builds a worker from a blob', () => {
    const client = readFileSync(resolve('node_modules/vite/dist/client/client.mjs'), 'utf8')
    expect(client).toMatch(/new SharedWorker\(/)
    expect(client).toMatch(/URL\.createObjectURL\(/)
  })
})
