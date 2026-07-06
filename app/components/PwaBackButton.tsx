'use client'

import { useEffect, useState } from 'react'
import { usePathname, useRouter } from 'next/navigation'

/**
 * Installed web apps (PWAs launched from the home screen / app dock) run in
 * standalone mode with no browser chrome — so there's no browser back button.
 * This renders an in-app back control that only appears when running standalone.
 */
export function PwaBackButton() {
  const router = useRouter()
  const pathname = usePathname()
  const [standalone, setStandalone] = useState(false)

  useEffect(() => {
    const mq = window.matchMedia('(display-mode: standalone)')
    const update = () => {
      // iOS Safari exposes navigator.standalone; other platforms use the media query.
      const iosStandalone =
        (window.navigator as Navigator & { standalone?: boolean }).standalone === true
      setStandalone(mq.matches || iosStandalone)
    }
    update()
    mq.addEventListener('change', update)
    return () => mq.removeEventListener('change', update)
  }, [])

  // Nothing to go back to on the home screen.
  if (!standalone || pathname === '/') return null

  return (
    <button
      type="button"
      aria-label="Go back"
      onClick={() => router.back()}
      className="flex flex-none items-center justify-center rounded-lg px-2 py-1 text-lg leading-none text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
    >
      ‹
    </button>
  )
}
