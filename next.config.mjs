/** @type {import('next').NextConfig} */
const nextConfig = {
  // Ensure the fixture tarballs and finding JSON ship in the serverless bundle so
  // the oracle can re-scan them at runtime on Vercel.
  outputFileTracingIncludes: {
    "/api/**": ["./fixtures/**/*", "./lib/sandbox-fingerprint.json"],
  },
  eslint: { ignoreDuringBuilds: true },
};
export default nextConfig;
