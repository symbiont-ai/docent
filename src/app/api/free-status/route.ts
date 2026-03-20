// ==========================================================
// DOCENT — Free Mode Status Endpoint
// Returns whether a server-side API key is configured,
// enabling "free mode" for users without their own key.
// ==========================================================

import { NextResponse } from 'next/server';

export async function GET() {
  const hasServerKey = !!process.env.OPENROUTER_API_KEY;
  return NextResponse.json({ available: hasServerKey });
}
