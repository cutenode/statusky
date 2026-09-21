/**
 * The main process owns the theme via `nativeTheme.themeSource`, which Chromium
 * surfaces to the renderer as `prefers-color-scheme`. We only mirror that onto the
 * `dark` class Tailwind keys off, so there is exactly one source of truth.
 */
export function startThemeSync(): () => void {
  const query = window.matchMedia('(prefers-color-scheme: dark)')

  const apply = (): void => {
    document.documentElement.classList.toggle('dark', query.matches)
    document.documentElement.style.colorScheme = query.matches ? 'dark' : 'light'
  }

  apply()
  query.addEventListener('change', apply)
  return () => query.removeEventListener('change', apply)
}
