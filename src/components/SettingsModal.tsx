'use client';

import React, { useState } from 'react';
import { COLORS } from '@/src/lib/colors';
import ModelPicker from './ModelPicker';
import type { VoiceGender, TTSEngine, ModelOption } from '@/src/types';

interface SettingsModalProps {
  show: boolean;
  onClose: () => void;
  voiceGender: VoiceGender;
  setVoiceGender: (v: VoiceGender) => void;
  ttsEngine: TTSEngine;
  setTTSEngine: (v: TTSEngine) => void;
  googleApiKey: string;
  setGoogleApiKey: (v: string) => void;
  apiKey: string;
  setApiKey: (v: string) => void;
  selectedModel: string;
  setSelectedModel: (v: string) => void;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  maxOutputTokens: number;
  setMaxOutputTokens: (v: number) => void;
  modelMaxTokens: number;
}

/** Build preset buttons dynamically based on the model's max completion tokens */
function buildTokenPresets(cap: number): { value: number; label: string }[] {
  const candidates = [4000, 8000, 16000, 24000, 32000, 48000, 64000, 96000, 128000];
  // Always include 8K as first, then spread evenly up to the cap
  const presets = candidates.filter(v => v <= cap && v >= 8000);
  // Keep at most 4 presets: first, two middle, and last
  if (presets.length <= 4) {
    return presets.map(v => ({ value: v, label: `${v / 1000}K` }));
  }
  const first = presets[0];
  const last = presets[presets.length - 1];
  const mid1 = presets[Math.floor(presets.length / 3)];
  const mid2 = presets[Math.floor((presets.length * 2) / 3)];
  return [first, mid1, mid2, last]
    .filter((v, i, a) => a.indexOf(v) === i) // deduplicate
    .map(v => ({ value: v, label: `${v / 1000}K` }));
}

const VOICE_OPTIONS: { value: VoiceGender; label: string; icon: string }[] = [
  { value: 'female', label: 'Female', icon: '\u2640' },
  { value: 'male', label: 'Male', icon: '\u2642' },
  { value: 'neutral', label: 'Neutral', icon: '\u25D1' },
];

const TTS_ENGINE_OPTIONS: { value: TTSEngine; label: string; desc: string }[] = [
  { value: 'browser', label: 'Browser (Free)', desc: 'Built-in voices' },
  { value: 'gemini', label: 'Gemini AI', desc: 'Neural quality' },
];

export default function SettingsModal({
  show,
  onClose,
  voiceGender,
  setVoiceGender,
  ttsEngine,
  setTTSEngine,
  googleApiKey,
  setGoogleApiKey,
  apiKey,
  setApiKey,
  selectedModel,
  setSelectedModel,
  availableModels,
  modelsLoading,
  maxOutputTokens,
  setMaxOutputTokens,
  modelMaxTokens,
}: SettingsModalProps) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [showGoogleKey, setShowGoogleKey] = useState(false);
  const tokenPresets = buildTokenPresets(modelMaxTokens);

  if (!show) return null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, backgroundColor: 'rgba(0,0,0,0.7)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        zIndex: 999,
      }}
      onClick={onClose}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          width: '520px', maxHeight: '90vh', overflowY: 'auto',
          backgroundColor: COLORS.surface,
          borderRadius: '16px', border: `1px solid ${COLORS.border}`,
          padding: '28px', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          marginBottom: '20px',
        }}>
          <h3 style={{
            margin: 0, fontSize: '18px',
            color: COLORS.accent, fontWeight: 600,
          }}>
            Settings
          </h3>
          <button
            onClick={onClose}
            style={{
              padding: '8px 20px', borderRadius: '8px', border: 'none',
              backgroundColor: COLORS.accent, color: COLORS.bg, cursor: 'pointer',
              fontSize: '13px', fontWeight: 600, fontFamily: 'system-ui, sans-serif',
            }}
          >
            Done
          </button>
        </div>

        {/* Voice Gender */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{
            fontSize: '13px', color: COLORS.textMuted, display: 'block',
            marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
          }}>
            Sage&apos;s Voice
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {VOICE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setVoiceGender(opt.value)}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', cursor: 'pointer',
                  border: `1px solid ${voiceGender === opt.value ? COLORS.accent : COLORS.border}`,
                  backgroundColor: voiceGender === opt.value ? COLORS.accentBg : 'transparent',
                  color: voiceGender === opt.value ? COLORS.accent : COLORS.textMuted,
                  fontSize: '13px', fontWeight: 500, textTransform: 'capitalize',
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                {opt.icon} {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* TTS Engine */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{
            fontSize: '13px', color: COLORS.textMuted, display: 'block',
            marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
          }}>
            TTS Engine
          </label>
          <div style={{ display: 'flex', gap: '8px' }}>
            {TTS_ENGINE_OPTIONS.map(opt => (
              <button
                key={opt.value}
                onClick={() => setTTSEngine(opt.value)}
                style={{
                  flex: 1, padding: '10px', borderRadius: '8px', cursor: 'pointer',
                  border: `1px solid ${ttsEngine === opt.value ? COLORS.accent : COLORS.border}`,
                  backgroundColor: ttsEngine === opt.value ? COLORS.accentBg : 'transparent',
                  color: ttsEngine === opt.value ? COLORS.accent : COLORS.textMuted,
                  fontSize: '13px', fontWeight: 500,
                  fontFamily: 'system-ui, sans-serif',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '2px',
                }}
              >
                <span>{opt.label}</span>
                <span style={{ fontSize: '10px', opacity: 0.7 }}>{opt.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Google API Key (visible only when Gemini TTS selected) */}
        {ttsEngine === 'gemini' && (
          <div style={{ marginBottom: '20px' }}>
            <label style={{
              fontSize: '13px', color: COLORS.textMuted, display: 'block',
              marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
            }}>
              Google API Key
              <span style={{
                fontSize: '11px', color: COLORS.textDim, marginLeft: '6px',
              }}>
                (for Gemini TTS)
              </span>
            </label>
            <div style={{ position: 'relative' }}>
              <input
                type={showGoogleKey ? 'text' : 'password'}
                value={googleApiKey}
                onChange={e => setGoogleApiKey(e.target.value)}
                placeholder="AIza..."
                style={{
                  width: '100%', padding: '10px', paddingRight: '44px',
                  borderRadius: '8px', border: `1px solid ${COLORS.border}`,
                  backgroundColor: COLORS.bg, color: COLORS.text, fontSize: '13px',
                  boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif',
                  outline: 'none',
                }}
              />
              <button
                onClick={() => setShowGoogleKey(v => !v)}
                style={{
                  position: 'absolute', right: '8px', top: '50%',
                  transform: 'translateY(-50%)', padding: '4px 8px',
                  fontSize: '11px', borderRadius: '4px',
                  border: `1px solid ${COLORS.border}`, backgroundColor: 'transparent',
                  color: COLORS.textMuted, cursor: 'pointer',
                  fontFamily: 'system-ui, sans-serif',
                }}
                title={showGoogleKey ? 'Hide key' : 'Show key'}
              >
                {showGoogleKey ? 'Hide' : 'Show'}
              </button>
            </div>
            <div style={{
              fontSize: '11px', color: COLORS.textDim, marginTop: '6px',
              fontFamily: 'system-ui, sans-serif',
            }}>
              Get a free key at{' '}
              <a
                href="https://aistudio.google.com/apikey"
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: COLORS.accent, textDecoration: 'underline' }}
              >
                aistudio.google.com
              </a>
            </div>
          </div>
        )}

        {/* API Key */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{
            fontSize: '13px', color: COLORS.textMuted, display: 'block',
            marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
          }}>
            OpenRouter API Key
          </label>
          <div style={{ position: 'relative' }}>
            <input
              type={showApiKey ? 'text' : 'password'}
              value={apiKey}
              onChange={e => setApiKey(e.target.value)}
              placeholder="sk-or-..."
              style={{
                width: '100%', padding: '10px', paddingRight: '44px',
                borderRadius: '8px', border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.bg, color: COLORS.text, fontSize: '13px',
                boxSizing: 'border-box', fontFamily: 'system-ui, sans-serif',
                outline: 'none',
              }}
            />
            <button
              onClick={() => setShowApiKey(v => !v)}
              style={{
                position: 'absolute', right: '8px', top: '50%',
                transform: 'translateY(-50%)', padding: '4px 8px',
                fontSize: '11px', borderRadius: '4px',
                border: `1px solid ${COLORS.border}`, backgroundColor: 'transparent',
                color: COLORS.textMuted, cursor: 'pointer',
                fontFamily: 'system-ui, sans-serif',
              }}
              title={showApiKey ? 'Hide key' : 'Show key'}
            >
              {showApiKey ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>

        {/* Max Output Tokens */}
        <div style={{ marginBottom: '20px' }}>
          <label style={{
            fontSize: '13px', color: COLORS.textMuted, display: 'block',
            marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
          }}>
            Max Output Tokens
            <span style={{
              float: 'right', color: COLORS.accent, fontWeight: 600,
            }}>
              {(maxOutputTokens / 1000).toFixed(0)}K
            </span>
          </label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            {tokenPresets.map(preset => (
              <button
                key={preset.value}
                onClick={() => setMaxOutputTokens(preset.value)}
                style={{
                  flex: 1, padding: '8px', borderRadius: '8px', cursor: 'pointer',
                  border: `1px solid ${maxOutputTokens === preset.value ? COLORS.accent : COLORS.border}`,
                  backgroundColor: maxOutputTokens === preset.value ? COLORS.accentBg : 'transparent',
                  color: maxOutputTokens === preset.value ? COLORS.accent : COLORS.textMuted,
                  fontSize: '13px', fontWeight: 500,
                  fontFamily: 'system-ui, sans-serif',
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input
            type="range"
            min={4000}
            max={modelMaxTokens}
            step={1000}
            value={Math.min(maxOutputTokens, modelMaxTokens)}
            onChange={e => setMaxOutputTokens(parseInt(e.target.value, 10))}
            style={{
              width: '100%', accentColor: COLORS.accent,
              cursor: 'pointer',
            }}
          />
          <div style={{
            display: 'flex', justifyContent: 'space-between',
            fontSize: '11px', color: COLORS.textDim, marginTop: '2px',
            fontFamily: 'system-ui, sans-serif',
          }}>
            <span>4K (less credits needed)</span>
            <span>{Math.round(modelMaxTokens / 1000)}K (longer output)</span>
          </div>
        </div>

        {/* Model Selection */}
        <div style={{ marginBottom: '24px' }}>
          <label style={{
            fontSize: '13px', color: COLORS.textMuted, display: 'block',
            marginBottom: '8px', fontFamily: 'system-ui, sans-serif',
          }}>
            Model
          </label>
          <ModelPicker
            models={availableModels}
            selectedModel={selectedModel}
            onSelect={setSelectedModel}
            loading={modelsLoading}
          />
        </div>

        {/* Footer */}
        <div style={{ textAlign: 'center', marginTop: '4px' }}>
          <span style={{
            fontSize: '11px', color: COLORS.textDim, fontFamily: 'system-ui, sans-serif',
          }}>
            Docent v1.0.0 {'\u00B7'} MIT License {'\u00B7'} Symbiont-AI Cognitive Labs
          </span>
        </div>
      </div>
    </div>
  );
}
