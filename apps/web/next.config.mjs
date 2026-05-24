/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  transpilePackages: ['@construct/shared'],
  outputFileTracingRoot: process.env.NEXT_TRACE_ROOT,
  experimental: {
    typedRoutes: true,
  },
  async rewrites() {
    const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
    return [
      { source: '/api/v1/:path*', destination: `${api}/:path*` },
    ];
  },
  async headers() {
    // HTML страницы не должны кэшироваться: Telegram in-app WebView
    // и Mobile Safari иначе держат старый HTML со ссылками на уже
    // несуществующие Next.js chunk-хэши и валятся в client exception.
    // _next/static и _next/image сохраняют свой immutable cache (они
    // выпадают из source-паттерна ниже).
    return [
      {
        source: '/((?!_next/static|_next/image|favicon\\.ico).*)',
        headers: [
          { key: 'Cache-Control', value: 'no-store, must-revalidate' },
        ],
      },
    ];
  },
};

export default nextConfig;
