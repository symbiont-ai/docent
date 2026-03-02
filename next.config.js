/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  turbopack: {},
  webpack: (config) => {
    // pdf.js worker support
    config.resolve.alias.canvas = false;
    return config;
  },
};

module.exports = nextConfig;
