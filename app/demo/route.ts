import { enterDemo } from '@/app/actions/auth'

/**
 * GET /demo — a shareable shortcut into the read-only demo. Sets the signed
 * `demo` session cookie and redirects to the dashboard, so a link like
 * `https://…/demo` drops a visitor straight into the synthetic dataset with no
 * sign-in. Mirrors the "Explore the demo" button on the login page.
 */
export async function GET(): Promise<void> {
  await enterDemo()
}
