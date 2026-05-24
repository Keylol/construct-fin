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
};

export default nextConfig;
