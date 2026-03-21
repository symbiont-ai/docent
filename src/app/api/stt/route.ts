// ==========================================================
// DOCENT — Whisper STT API Route
// Transcribes audio using OpenAI Whisper via OpenRouter
// Accepts audio blob, returns transcribed text
// ==========================================================

import { NextRequest, NextResponse } from 'next/server';

const OPENAI_WHISPER_URL = 'https://api.openai.com/v1/audio/transcriptions';

export async function POST(request: NextRequest) {
  try {
    const apiKey = request.headers.get('x-api-key');

    if (!apiKey) {
      return NextResponse.json(
        { error: 'No API key provided. Add your OpenAI API key in Settings.' },
        { status: 401 },
      );
    }

    const formData = await request.formData();
    const audioFile = formData.get('file');

    if (!audioFile || !(audioFile instanceof Blob)) {
      return NextResponse.json({ error: 'Missing audio file' }, { status: 400 });
    }

    // Forward to OpenAI Whisper API
    const whisperForm = new FormData();
    whisperForm.append('file', audioFile, 'audio.webm');
    whisperForm.append('model', 'whisper-1');

    // Optional language hint
    const language = formData.get('language');
    if (language && typeof language === 'string') {
      whisperForm.append('language', language);
    }

    const response = await fetch(OPENAI_WHISPER_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
      },
      body: whisperForm,
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('[STT] Whisper error:', response.status, err.substring(0, 300));
      return NextResponse.json(
        { error: `Whisper transcription failed (${response.status}): ${err.substring(0, 200)}` },
        { status: response.status },
      );
    }

    const data = await response.json();

    return NextResponse.json({ text: data.text || '' });
  } catch (err) {
    console.error('[STT] Error:', err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'STT request failed' },
      { status: 500 },
    );
  }
}
