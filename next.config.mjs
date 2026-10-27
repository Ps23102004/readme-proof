/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: ["@vercel/sandbox", "undici"],
  outputFileTracingIncludes: { "/api/run": ["./data/demo/**"] },
};
export default nextConfig;
