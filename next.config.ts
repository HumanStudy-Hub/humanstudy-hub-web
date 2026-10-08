/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    unoptimized: true,
  },
  async headers() {
    return [{ source: "/auth/confirm", headers: [
      { key: "Referrer-Policy", value: "no-referrer" },
      { key: "Cache-Control", value: "private, no-store" },
    ] }];
  },
  async redirects() {
    return [
      // Serve our custom icon when browser requests favicon.ico (avoids Vercel default)
      { source: "/favicon.ico", destination: "/favicon.svg", permanent: false },
    ];
  },
};

module.exports = nextConfig;
