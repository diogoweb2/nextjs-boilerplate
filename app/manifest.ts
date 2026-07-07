import type { MetadataRoute } from 'next'

/**
 * PWA manifest — lets the app install to a phone home screen and gives Android a
 * proper maskable icon (the same artwork the push notifications use, served from
 * /public). Next auto-injects the <link rel="manifest"> from this file.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Pereira Lope$',
    short_name: 'Lope$',
    description: 'The family fortune, live — watch it grow wings and fly away in real time.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0a0f0c',
    theme_color: '#0a0f0c',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  }
}
