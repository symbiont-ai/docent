/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {
    root: __dirname, // Anchor workspace root to this directory
  },
  webpack: (config) => {
    // pdf.js worker support
    config.resolve.alias.canvas = false;
    return config;
  },
};

module.exports = nextConfig;
