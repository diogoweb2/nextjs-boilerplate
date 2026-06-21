import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySessionToken, COOKIE_NAME } from '@/app/lib/session'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // The sync ingest + digest + status endpoints authenticate with a bearer token,
  // not the session cookie, so let them through to their own auth (see
  // app/api/ingest + app/api/digest + app/api/sync-status route handlers).
  if (
    pathname.startsWith('/api/ingest') ||
    pathname.startsWith('/api/digest') ||
    pathname.startsWith('/api/sync-status')
  ) {
    return NextResponse.next()
  }

  // The push service worker must be a public, non-redirected script — browsers
  // refuse to register a SW that 307s to the login page. It contains no data.
  if (pathname === '/sw.js') {
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
