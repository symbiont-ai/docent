// ==========================================================
// DOCENT — Speech-to-Text Hook
// Dual-engine STT: Browser Web Speech API (free) + Whisper (premium)
// Provides toggle-mic UX with silence detection & auto-submit
// ==========================================================

'use client';

import { useState, useRef, useCallback, useEffect } from 'react';
import type { STTEngine } from '@/src/types';

// ── Types ────────────────────────────────────────────────

interface UseSTTOptions {
  engine: STTEngine;
  apiKey?: string;
  /** Called with final transcript text when silence triggers auto-stop */
  onFinalTranscript?: (text: string) => void;
  /** Silence duration in ms before auto-stopping (default: 1500) */
  silenceTimeout?: number;
}

interface UseSTTReturn {
  isListening: boolean;
  transcript: string;
  interimTranscript: string;
  error: string | null;
  startListening: () => void;
  stopListening: () => void;
  resetTranscript: () => void;
  /** Whether browser Web Speech API is supported */
  browserSTTSupported: boolean;
}

// ── Constants ────────────────────────────────────────────

const SILENCE_TIMEOUT_MS = 1500;
const RMS_SILENCE_THRESHOLD = 0.01;
const RMS_POLL_INTERVAL_MS = 100;

// ── Hook ─────────────────────────────────────────────────

export function useSTT({
  engine,
  apiKey,
  onFinalTranscript,
  silenceTimeout = SILENCE_TIMEOUT_MS,
}: UseSTTOptions): UseSTTReturn {
  const [isListening, setIsListening] = useState(false);
  const [transcript, setTranscript] = useState('');
  const [interimTranscript, setInterimTranscript] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Refs for cleanup
  const recognitionRef = useRef<SpeechRecognition | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const silenceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isListeningRef = useRef(false);
  const onFinalTranscriptRef = useRef(onFinalTranscript);
  const accumulatedTranscriptRef = useRef('');

  // Keep callback ref fresh
  useEffect(() => {
    onFinalTranscriptRef.current = onFinalTranscript;
  }, [onFinalTranscript]);

  // Detect browser support
  const browserSTTSupported = typeof window !== 'undefined' &&
    ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

  // ── Cleanup helpers ──────────────────────────────────

  const clearSilenceTimer = useCallback(() => {
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = null;
    }
  }, []);

  const cleanupMediaResources = useCallback(() => {
    if (mediaRecorderRef.current) {
      if (mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(t => t.stop());
      mediaStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
  }, []);

  // ── Browser Web Speech API engine ────────────────────

  const startBrowserSTT = useCallback(() => {
    if (!browserSTTSupported) {
      setError('Web Speech API is not supported in this browser. Switch to Whisper in Settings.');
      return;
    }

    const SpeechRecognitionClass = (window as unknown as { SpeechRecognition?: typeof SpeechRecognition; webkitSpeechRecognition?: typeof SpeechRecognition }).SpeechRecognition
      || (window as unknown as { webkitSpeechRecognition?: typeof SpeechRecognition }).webkitSpeechRecognition;

    if (!SpeechRecognitionClass) {
      setError('Speech recognition not available.');
      return;
    }

    const recognition = new SpeechRecognitionClass();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    recognition.onresult = (event: SpeechRecognitionEvent) => {
      clearSilenceTimer();

      let interim = '';
      let finalText = '';

      for (let i = 0; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalText += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      if (finalText) {
        accumulatedTranscriptRef.current = finalText;
        setTranscript(finalText);
      }
      setInterimTranscript(interim);

      // Start silence timer — if no new results within timeout, auto-stop
      silenceTimerRef.current = setTimeout(() => {
        const finalResult = accumulatedTranscriptRef.current || interim;
        if (finalResult.trim() && isListeningRef.current) {
          stopListening();
          onFinalTranscriptRef.current?.(finalResult.trim());
        }
      }, silenceTimeout);
    };

    recognition.onspeechend = () => {
      // Speech ended — start silence timer if not already running
      if (!silenceTimerRef.current) {
        silenceTimerRef.current = setTimeout(() => {
          const finalResult = accumulatedTranscriptRef.current || interimTranscript;
          if (finalResult.trim() && isListeningRef.current) {
            stopListening();
            onFinalTranscriptRef.current?.(finalResult.trim());
          }
        }, silenceTimeout);
      }
    };

    recognition.onerror = (event: SpeechRecognitionErrorEvent) => {
      // Suppress user-initiated abort and no-speech (common non-errors)
      if (event.error === 'aborted' || event.error === 'no-speech') return;

      const errorMap: Record<string, string> = {
        'not-allowed': 'Microphone access denied. Please allow microphone permissions.',
        'audio-capture': 'No microphone found. Please check your audio devices.',
        'network': 'Network error. Check your connection.',
      };
      const msg = errorMap[event.error] || `Speech recognition error: ${event.error}`;
      setError(msg);
      stopListening();
    };

    recognition.onend = () => {
      // Chrome auto-stops after ~60s — restart if still listening
      if (isListeningRef.current && recognitionRef.current) {
        try {
          recognition.start();
        } catch {
          // Already started or disposed
        }
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
      setIsListening(true);
      isListeningRef.current = true;
      setError(null);
      setTranscript('');
      setInterimTranscript('');
      accumulatedTranscriptRef.current = '';
    } catch (err) {
      setError('Failed to start speech recognition.');
      console.error('[STT] Browser start error:', err);
    }
  }, [browserSTTSupported, clearSilenceTimer, silenceTimeout, interimTranscript]);

  // ── Whisper engine (MediaRecorder + API) ─────────────

  const startWhisperSTT = useCallback(async () => {
    if (!apiKey) {
      setError('No API key configured. Add your OpenAI API key in Settings to use Whisper.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      // Set up audio analysis for silence detection
      const audioContext = new AudioContext();
      audioContextRef.current = audioContext;
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);

      const dataArray = new Float32Array(analyser.frequencyBinCount);
      let silenceStart: number | null = null;

      // Start recording
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : 'audio/mp4';

      const recorder = new MediaRecorder(stream, { mimeType });
      const chunks: Blob[] = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };

      recorder.onstop = async () => {
        const blob = new Blob(chunks, { type: mimeType });
        cleanupMediaResources();

        if (blob.size < 1000) {
          // Too short / no audio
          setError('Recording was too short. Try speaking louder.');
          setIsListening(false);
          isListeningRef.current = false;
          return;
        }

        setInterimTranscript('Transcribing...');

        try {
          const formData = new FormData();
          formData.append('file', blob, 'audio.webm');

          const res = await fetch('/api/stt', {
            method: 'POST',
            headers: { 'x-api-key': apiKey || '' },
            body: formData,
          });

          if (!res.ok) {
            const errData = await res.json().catch(() => ({ error: 'Transcription failed' }));
            throw new Error(errData.error || `HTTP ${res.status}`);
          }

          const data = await res.json();
          const text = data.text?.trim() || '';

          setTranscript(text);
          setInterimTranscript('');

          if (text) {
            onFinalTranscriptRef.current?.(text);
          } else {
            setError('No speech detected in recording.');
          }
        } catch (err) {
          setError(err instanceof Error ? err.message : 'Whisper transcription failed');
          setInterimTranscript('');
        }

        setIsListening(false);
        isListeningRef.current = false;
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250); // Collect data every 250ms

      setIsListening(true);
      isListeningRef.current = true;
      setError(null);
      setTranscript('');
      setInterimTranscript('');
      accumulatedTranscriptRef.current = '';

      // Poll for silence
      const pollSilence = () => {
        if (!isListeningRef.current) return;

        analyser.getFloatTimeDomainData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i] * dataArray[i];
        }
        const rms = Math.sqrt(sum / dataArray.length);

        if (rms < RMS_SILENCE_THRESHOLD) {
          if (!silenceStart) {
            silenceStart = Date.now();
          } else if (Date.now() - silenceStart > silenceTimeout) {
            // Silence detected — stop recording
            if (mediaRecorderRef.current?.state === 'recording') {
              mediaRecorderRef.current.stop();
            }
            return;
          }
        } else {
          silenceStart = null;
          // Show visual feedback that audio is being captured
          setInterimTranscript('Listening...');
        }

        setTimeout(pollSilence, RMS_POLL_INTERVAL_MS);
      };

      // Wait a moment for mic to warm up, then start polling
      setTimeout(pollSilence, 300);

    } catch (err) {
      const msg = err instanceof Error && err.name === 'NotAllowedError'
        ? 'Microphone access denied. Please allow microphone permissions.'
        : 'Failed to access microphone.';
      setError(msg);
      cleanupMediaResources();
      console.error('[STT] Whisper start error:', err);
    }
  }, [apiKey, cleanupMediaResources, silenceTimeout]);

  // ── Public API ───────────────────────────────────────

  const startListening = useCallback(() => {
    if (isListeningRef.current) return;
    setError(null);

    if (engine === 'whisper') {
      startWhisperSTT();
    } else {
      startBrowserSTT();
    }
  }, [engine, startBrowserSTT, startWhisperSTT]);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const stopListening = useCallback(() => {
    clearSilenceTimer();
    isListeningRef.current = false;
    setIsListening(false);

    // Stop browser recognition
    if (recognitionRef.current) {
      recognitionRef.current.abort();
      recognitionRef.current = null;
    }

    // Stop whisper recording
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop(); // triggers onstop → transcription
    } else {
      cleanupMediaResources();
    }

    setInterimTranscript('');
  }, [clearSilenceTimer, cleanupMediaResources]);

  const resetTranscript = useCallback(() => {
    setTranscript('');
    setInterimTranscript('');
    accumulatedTranscriptRef.current = '';
  }, []);

  const clearError = useCallback(() => setError(null), []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      clearSilenceTimer();
      if (recognitionRef.current) {
        recognitionRef.current.abort();
        recognitionRef.current = null;
      }
      cleanupMediaResources();
      isListeningRef.current = false;
    };
  }, [clearSilenceTimer, cleanupMediaResources]);

  return {
    isListening,
    transcript,
    interimTranscript,
    error,
    startListening,
    stopListening,
    resetTranscript,
    clearError,
    browserSTTSupported,
  };
}
