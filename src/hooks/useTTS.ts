'use client';

// ==========================================================
// DOCENT — Text-to-Speech Hook (Dual Engine: Browser + Gemini)
// Manages speech synthesis with language-aware voice selection
// ==========================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import type { VoiceGender, TTSEngine } from '@/src/types';
import { VOICE_CONFIG, LANGUAGE_VOICE_PREFS, GEMINI_VOICE_GENDER } from '@/src/lib/constants';
import { cleanTextForSpeech, chunkText, chunkTextForGemini } from '@/src/lib/presentation';

export function useTTS(voiceGender: VoiceGender, ttsEngine: TTSEngine = 'browser', googleApiKey: string = '') {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [voicesReady, setVoicesReady] = useState(false);
  const generationRef = useRef(0);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const geminiAbortRef = useRef<AbortController | null>(null);
  const prefetchBufferRef = useRef<Map<string, Promise<string>>>(new Map());

  // Preload browser voices on mount
  useEffect(() => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    const checkVoices = () => {
      const voices = speechSynthesis.getVoices();
      if (voices.length > 0) {
        setVoicesReady(true);
      }
    };

    checkVoices();
    speechSynthesis.addEventListener('voiceschanged', checkVoices);
    return () => {
      speechSynthesis.removeEventListener('voiceschanged', checkVoices);
    };
  }, []);

  const getVoice = useCallback((lang?: string): SpeechSynthesisVoice | null => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return null;
    const voices = speechSynthesis.getVoices();
    if (voices.length === 0) return null;

    const targetLang = lang || 'en';
    const config = VOICE_CONFIG[voiceGender] || VOICE_CONFIG.female;

    // English: use the existing preferred voice logic
    if (targetLang.startsWith('en')) {
      for (const preferred of config.preferredVoice) {
        const match = voices.find(v => v.name.includes(preferred));
        if (match) return match;
      }
      const english = voices.find(v => v.lang.startsWith('en'));
      return english || voices[0] || null;
    }

    // Non-English: find a voice matching the target language
    const langVoices = voices.filter(v => v.lang.startsWith(targetLang));
    if (langVoices.length === 0) {
      return voices[0] || null;
    }

    // Try quality-ordered language-specific voice preferences
    const langPrefs = LANGUAGE_VOICE_PREFS[targetLang];
    const genderKey = voiceGender === 'neutral' ? 'female' : voiceGender;
    const preferredNames = langPrefs?.[genderKey] || [];

    for (const preferred of preferredNames) {
      const match = langVoices.find(v => v.name.includes(preferred));
      if (match) return match;
    }

    // Fallback: try the other gender's preferred voices
    const otherGender = genderKey === 'female' ? 'male' : 'female';
    const otherNames = langPrefs?.[otherGender] || [];
    for (const preferred of otherNames) {
      const match = langVoices.find(v => v.name.includes(preferred));
      if (match) return match;
    }

    return langVoices[0];
  }, [voiceGender]);

  // ── Browser TTS (Web Speech API) ──
  const speakBrowser = useCallback((text: string, onEnd?: () => void, lang?: string) => {
    if (typeof window === 'undefined' || !window.speechSynthesis) return;

    speechSynthesis.cancel();

    const gen = ++generationRef.current;
    const cleaned = cleanTextForSpeech(text);
    const chunks = chunkText(cleaned);
    const config = VOICE_CONFIG[voiceGender] || VOICE_CONFIG.female;
    const voice = getVoice(lang);

    setIsSpeaking(true);

    const speakChunk = (index: number) => {
      if (gen !== generationRef.current) {
        setIsSpeaking(false);
        return;
      }
      if (index >= chunks.length) {
        setIsSpeaking(false);
        onEnd?.();
        return;
      }

      const utterance = new SpeechSynthesisUtterance(chunks[index]);
      if (lang) utterance.lang = lang;
      if (voice) utterance.voice = voice;
      utterance.pitch = config.pitch;
      utterance.rate = config.rate;

      utterance.onend = () => {
        if (gen !== generationRef.current) {
          setIsSpeaking(false);
          return;
        }
        setTimeout(() => speakChunk(index + 1), 80);
      };

      utterance.onerror = () => {
        if (gen !== generationRef.current) return;
        setIsSpeaking(false);
        onEnd?.();
      };

      speechSynthesis.speak(utterance);
    };

    speakChunk(0);
  }, [voiceGender, getVoice]);

  // ── Gemini audio fetch helper (shared by playChunk and prefetchAudio) ──
  const fetchGeminiAudio = useCallback(async (
    text: string, voiceName: string, apiKey: string, signal?: AbortSignal
  ): Promise<string> => {
    const res = await fetch('/api/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-google-api-key': apiKey },
      body: JSON.stringify({ text, voiceName }),
      signal,
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'TTS failed');
    return data.audioBase64;
  }, []);

  // ── Gemini TTS (Google AI API) with look-ahead prefetch ──
  const speakGemini = useCallback((text: string, onEnd?: () => void, _lang?: string, onAlmostDone?: () => void) => {
    const gen = ++generationRef.current;
    const cleaned = cleanTextForSpeech(text);
    const chunks = chunkTextForGemini(cleaned);
    const voiceName = GEMINI_VOICE_GENDER[voiceGender] || GEMINI_VOICE_GENDER.female;

    setIsSpeaking(true);
    setIsLoadingAudio(true);

    const playChunk = async (index: number) => {
      if (gen !== generationRef.current) {
        setIsSpeaking(false);
        setIsLoadingAudio(false);
        return;
      }

      if (index >= chunks.length) {
        setIsSpeaking(false);
        setIsLoadingAudio(false);
        onEnd?.();
        return;
      }

      try {
        const controller = new AbortController();
        geminiAbortRef.current = controller;

        // Check prefetch buffer first, otherwise fetch fresh
        let audioBase64: string;
        const cached = prefetchBufferRef.current.get(chunks[index]);
        if (cached) {
          prefetchBufferRef.current.delete(chunks[index]);
          audioBase64 = await cached;
        } else {
          audioBase64 = await fetchGeminiAudio(chunks[index], voiceName, googleApiKey, controller.signal);
        }

        if (gen !== generationRef.current) return;

        setIsLoadingAudio(false);

        // Prefetch next chunk while this one plays
        if (index + 1 < chunks.length && !prefetchBufferRef.current.has(chunks[index + 1])) {
          const prefetchController = new AbortController();
          prefetchBufferRef.current.set(
            chunks[index + 1],
            fetchGeminiAudio(chunks[index + 1], voiceName, googleApiKey, prefetchController.signal),
          );
        }

        // Signal "almost done" when the last chunk starts playing
        // This gives the narration coordinator time to prefetch the next slide's audio
        if (index === chunks.length - 1) {
          onAlmostDone?.();
        }

        const audio = new Audio(`data:audio/wav;base64,${audioBase64}`);
        audioRef.current = audio;

        audio.onended = () => {
          if (gen !== generationRef.current) return;
          // No delay needed — next chunk is already prefetched
          playChunk(index + 1);
        };

        audio.onerror = () => {
          if (gen !== generationRef.current) return;
          console.warn('[Gemini TTS] Audio playback error on chunk', index);
          playChunk(index + 1);
        };

        audio.play();
      } catch (err) {
        if (gen !== generationRef.current) return;

        // On error, fall back to browser TTS for remaining text
        console.warn('[Gemini TTS] Error, falling back to browser TTS:', err);
        setIsLoadingAudio(false);
        speakBrowser(chunks.slice(index).join(' '), onEnd, _lang);
      }
    };

    playChunk(0);
  }, [voiceGender, googleApiKey, speakBrowser, fetchGeminiAudio]);

  // ── Prefetch audio for upcoming text (cross-slide look-ahead) ──
  const prefetchAudio = useCallback((text: string) => {
    if (ttsEngine !== 'gemini' || !googleApiKey) return;
    const voiceName = GEMINI_VOICE_GENDER[voiceGender] || GEMINI_VOICE_GENDER.female;
    const cleaned = cleanTextForSpeech(text);
    const chunks = chunkTextForGemini(cleaned);
    // Prefetch just the first chunk of the upcoming text
    const firstChunk = chunks[0];
    if (firstChunk && !prefetchBufferRef.current.has(firstChunk)) {
      prefetchBufferRef.current.set(
        firstChunk,
        fetchGeminiAudio(firstChunk, voiceName, googleApiKey),
      );
    }
  }, [ttsEngine, googleApiKey, voiceGender, fetchGeminiAudio]);

  // ── Unified stop ──
  const stopSpeaking = useCallback(() => {
    generationRef.current++;

    // Stop browser TTS
    if (typeof window !== 'undefined' && window.speechSynthesis) {
      speechSynthesis.cancel();
    }

    // Stop Gemini audio
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.currentTime = 0;
      audioRef.current = null;
    }

    // Abort in-flight Gemini requests
    if (geminiAbortRef.current) {
      geminiAbortRef.current.abort();
      geminiAbortRef.current = null;
    }

    // Clear prefetch buffer
    prefetchBufferRef.current.clear();

    setIsSpeaking(false);
    setIsLoadingAudio(false);
  }, []);

  // ── Unified speak ──
  const speak = useCallback((text: string, onEnd?: () => void, lang?: string, onAlmostDone?: () => void) => {
    if (ttsEngine === 'gemini' && googleApiKey) {
      speakGemini(text, onEnd, lang, onAlmostDone);
    } else {
      // Browser TTS, or Gemini without API key (fallback)
      if (ttsEngine === 'gemini' && !googleApiKey) {
        console.warn('[TTS] Gemini selected but no Google API key. Falling back to browser TTS.');
      }
      speakBrowser(text, onEnd, lang);
    }
  }, [ttsEngine, googleApiKey, speakGemini, speakBrowser]);

  return { isSpeaking, isLoadingAudio, voicesReady, speak, stopSpeaking, prefetchAudio };
}
