// ==========================================================
// DOCENT — Gemini TTS API Route
// Converts text to speech using Google Gemini 2.5 Flash TTS
// Returns base64-encoded WAV audio
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const GEMINI_TTS_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-tts:generateContent';

/** Wrap raw PCM data (base64) with a WAV header and return as base64 WAV */
function createWavBase64(pcmBase64: string, sampleRate: number, bitsPerSample: number, channels: number): string {
  const pcmBuffer = Buffer.from(pcmBase64, 'base64');
  const dataSize = pcmBuffer.length;
  const header = Buffer.alloc(44);

  // RIFF header
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataSize, 4);
  header.write('WAVE', 8);
  // fmt chunk
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM format
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  // data chunk
  header.write('data', 36);
  header.writeUInt32LE(dataSize, 40);

  const wavBuffer = Buffer.concat([header, pcmBuffer]);
  return wavBuffer.toString('base64');
}

export async function POST(request: NextRequest) {
  try {
    const { text, voiceName } = await request.json();
    const googleKey = request.headers.get('x-google-api-key') || process.env.GOOGLE_API_KEY;

    if (!text) {
      return NextResponse.json({ error: 'Missing text' }, { status: 400 });
    }
    if (!googleKey) {
      return NextResponse.json({ error: 'No Google API key provided. Add it in Settings.' }, { status: 401 });
    }

    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName || 'Kore',
            },
          },
        },
      },
    };

    const response = await fetch(`${GEMINI_TTS_URL}?key=${googleKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[TTS] Gemini error:', response.status, err.substring(0, 300));
      return NextResponse.json(
        { error: `Gemini TTS failed (${response.status}): ${err.substring(0, 200)}` },
        { status: response.status },
      );
    }

    const data = await response.json();
    const audioData = data.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;

    if (!audioData) {
      return NextResponse.json({ error: 'No audio data in Gemini response' }, { status: 502 });
    }

    // Gemini returns raw PCM (24kHz, 16-bit, mono) — wrap with WAV header
    const wavBase64 = createWavBase64(audioData, 24000, 16, 1);

    return NextResponse.json({ audioBase64: wavBase64 });
  } catch (err) {
    console.error('[TTS] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'TTS request failed' },
      { status: 500 },
    );
  }
}
