import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { verifySessionToken, COOKIE_NAME } from '@/app/lib/session'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

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
