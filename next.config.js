const { execSync } = require('child_process');

// Get last git commit date at build time (fallback to current date)
let buildDate;
try {
  buildDate = execSync('git log -1 --format="%ci"').toString().trim().slice(0, 10); // YYYY-MM-DD
} catch {
  buildDate = new Date().toISOString().slice(0, 10);
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  env: {
    NEXT_PUBLIC_BUILD_DATE: buildDate,
  },
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
