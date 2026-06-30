import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySessionToken, COOKIE_NAME } from '@/app/lib/session'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // The sync ingest + digest + status + backup-status endpoints authenticate
  // with a bearer token, not the session cookie, so let them through to their
  // own auth (see app/api/ingest + app/api/digest + app/api/sync-status +
  // app/api/backup-status route handlers).
  if (
    pathname.startsWith('/api/ingest') ||
    pathname.startsWith('/api/digest') ||
    pathname.startsWith('/api/sync-status') ||
    pathname.startsWith('/api/backup-status')
  ) {
    return NextResponse.next()
  }

  // The push service worker must be a public, non-redirected script — browsers
  // refuse to register a SW that 307s to the login page. It contains no data.
  if (pathname === '/sw.js') {
    return NextResponse.next()
  }

  // PWA install assets must be publicly fetchable. Chrome requests the manifest
  // and its icons *without credentials*, so if these 307 to /login the browser
  // can't parse the manifest and the "Install app" option never appears. They
  // hold no personal data — just the app name, colours, and icon artwork.
  if (
    pathname === '/manifest.webmanifest' ||
    pathname === '/icon-192.png' ||
    pathname === '/icon-512.png' ||
    pathname === '/badge.png'
  ) {
    return NextResponse.next()
  }

  // Public shortcut into the read-only demo: the route handler mints the demo
  // session cookie and redirects to the dashboard. Must be reachable without an
  // existing session.
  if (pathname === '/demo') {
    return NextResponse.next()
  }

  if (pathname === '/login') {
    // Redirect authenticated users away from login
    const token = request.cookies.get(COOKIE_NAME)?.value
    if (token && (await verifySessionToken(token))) {
      return NextResponse.redirect(new URL('/', request.url))
    }
    return NextResponse.next()
  }

  const token = request.cookies.get(COOKIE_NAME)?.value
  if (!token || !(await verifySessionToken(token))) {
    return NextResponse.redirect(new URL('/login', request.url))
  }

  return NextResponse.next()
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
