'use client';

// ==========================================================
// DOCENT — Smart Model Picker
// Curated model selection with capability badges and cost tiers
// ==========================================================

import React, { useState } from 'react';
import { COLORS } from '@/src/lib/colors';
import type { ModelOption, PricingTier } from '@/src/types';

interface ModelPickerProps {
  models: ModelOption[];
  selectedModel: string;
  onSelect: (modelId: string) => void;
  loading: boolean;
}

// ── Badge components ──────────────────────────────────────

function CapBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: '10px', padding: '1px 6px', borderRadius: '4px',
      backgroundColor: `${color}15`, color,
      border: `1px solid ${color}30`, fontFamily: 'system-ui, sans-serif',
      fontWeight: 500, whiteSpace: 'nowrap', lineHeight: '16px',
    }}>
      {label}
    </span>
  );
}

const PRICING_CONFIG: Record<PricingTier, { label: string; color: string }> = {
  free: { label: 'Free', color: COLORS.green },
  budget: { label: '$', color: COLORS.textMuted },
  standard: { label: '$$', color: COLORS.accent },
  premium: { label: '$$$', color: COLORS.red },
};

function PricingBadge({ tier }: { tier: PricingTier }) {
  const config = PRICING_CONFIG[tier];
  return <CapBadge label={config.label} color={config.color} />;
}

// ── Context length formatter ──────────────────────────────

function formatCtx(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M ctx`;
  return `${Math.round(tokens / 1000)}k ctx`;
}

// ── Single model row ──────────────────────────────────────

function ModelRow({
  model,
  selected,
  onSelect,
}: {
  model: ModelOption;
  selected: boolean;
  onSelect: () => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      onClick={onSelect}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: 'flex', alignItems: 'center', gap: '8px',
        padding: '8px 10px', borderRadius: '8px', cursor: 'pointer',
        backgroundColor: selected ? COLORS.accentBg : hovered ? COLORS.surfaceHover : 'transparent',
        border: `1px solid ${selected ? COLORS.accent : 'transparent'}`,
        transition: 'background-color 0.12s, border-color 0.12s',
      }}
    >
      {/* Radio dot */}
      <div style={{
        width: '14px', height: '14px', borderRadius: '50%', flexShrink: 0,
        border: `2px solid ${selected ? COLORS.accent : COLORS.border}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        {selected && (
          <div style={{
            width: '6px', height: '6px', borderRadius: '50%',
            backgroundColor: COLORS.accent,
          }} />
        )}
      </div>

      {/* Name + meta */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: '13px', color: COLORS.text,
          fontWeight: selected ? 600 : 400,
          fontFamily: 'system-ui, sans-serif',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}>
          {model.name}
        </div>
        <div style={{
          fontSize: '11px', color: COLORS.textDim,
          fontFamily: 'system-ui, sans-serif',
        }}>
          {model.provider} {'\u00B7'} {formatCtx(model.contextLength)}
        </div>
      </div>

      {/* Capability badges */}
      <div style={{
        display: 'flex', gap: '3px', flexWrap: 'wrap',
        justifyContent: 'flex-end', flexShrink: 0,
      }}>
        {model.capabilities.vision && <CapBadge label="Vision" color={COLORS.cyan} />}
        {model.capabilities.reasoning && <CapBadge label="Reasoning" color="#A78BFA" />}
        {model.capabilities.jsonOutput && !model.capabilities.reasoning && (
          <CapBadge label="JSON" color={COLORS.accent} />
        )}
        <PricingBadge tier={model.pricing.tier} />
      </div>
    </div>
  );
}

// ── Main ModelPicker ──────────────────────────────────────

export default function ModelPicker({
  models,
  selectedModel,
  onSelect,
  loading,
}: ModelPickerProps) {
  const [showAll, setShowAll] = useState(false);
  const [recFilter, setRecFilter] = useState('');
  const [allFilter, setAllFilter] = useState('');

  const recommended = models.filter(m => m.recommended);
  const others = models.filter(m => !m.recommended);

  const filteredRecommended = recFilter
    ? recommended.filter(m =>
        m.name.toLowerCase().includes(recFilter.toLowerCase()) ||
        m.provider.toLowerCase().includes(recFilter.toLowerCase()) ||
        m.id.toLowerCase().includes(recFilter.toLowerCase()),
      )
    : recommended;

  const filteredOthers = allFilter
    ? others.filter(m =>
        m.name.toLowerCase().includes(allFilter.toLowerCase()) ||
        m.provider.toLowerCase().includes(allFilter.toLowerCase()) ||
        m.id.toLowerCase().includes(allFilter.toLowerCase()),
      )
    : others;

  if (loading) {
    return (
      <div style={{
        padding: '20px', textAlign: 'center', color: COLORS.textDim,
        fontSize: '13px', fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{
          width: '16px', height: '16px', margin: '0 auto 8px',
          border: `2px solid ${COLORS.accent}`, borderTopColor: 'transparent',
          borderRadius: '50%', animation: 'spin 0.8s linear infinite',
        }} />
        Loading models from OpenRouter...
      </div>
    );
  }

  return (
    <div>
      {/* ── Model Selection Guide ── */}
      <div style={{
        padding: '8px 10px', borderRadius: '8px', marginBottom: '10px',
        backgroundColor: COLORS.bg, border: `1px solid ${COLORS.border}`,
        fontSize: '11px', lineHeight: '1.6', color: COLORS.textDim,
        fontFamily: 'system-ui, sans-serif',
      }}>
        <div style={{ fontWeight: 600, color: COLORS.textMuted, marginBottom: '2px' }}>
          Model selection guide
        </div>
        <div><span style={{ color: COLORS.accent }}>Vision required</span> {'\u2014'} PDF presentations with figure cropping (e.g. Claude, GPT-4o, Gemini)</div>
        <div><span style={{ color: COLORS.textMuted }}>Any model</span> {'\u2014'} topic-based presentations, chat, PDF summaries (uses extracted text)</div>
        <div><span style={{ color: COLORS.purple }}>Reasoning recommended</span> {'\u2014'} complex multi-step analysis, deep thinking tasks</div>
      </div>

      {/* ── Filter for recommended models ── */}
      <input
        type="text"
        value={recFilter}
        onChange={e => setRecFilter(e.target.value)}
        placeholder="Filter recommended models..."
        style={{
          width: '100%', padding: '8px 12px', marginBottom: '10px',
          borderRadius: '8px', border: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.bg, color: COLORS.text,
          fontSize: '12px', fontFamily: 'system-ui, sans-serif',
          outline: 'none', boxSizing: 'border-box',
        }}
      />

      {/* ── Recommended Section ── */}
      <div style={{
        fontSize: '10px', color: COLORS.textDim, marginBottom: '6px',
        fontFamily: 'system-ui, sans-serif', textTransform: 'uppercase',
        letterSpacing: '0.8px', fontWeight: 600,
      }}>
        Recommended for Docent
      </div>
      {filteredRecommended.length > 0 ? (
        <div style={{
          display: 'flex', flexDirection: 'column', gap: '1px',
          marginBottom: '12px',
        }}>
          {filteredRecommended.map(m => (
            <ModelRow
              key={m.id}
              model={m}
              selected={selectedModel === m.id}
              onSelect={() => onSelect(m.id)}
            />
          ))}
        </div>
      ) : recFilter ? (
        <div style={{
          padding: '12px', textAlign: 'center', marginBottom: '12px',
          color: COLORS.textDim, fontSize: '12px',
          fontFamily: 'system-ui, sans-serif',
        }}>
          No recommended models match &ldquo;{recFilter}&rdquo;
        </div>
      ) : null}

      {/* ── All models (toggle + filter) ── */}
      {others.length > 0 && (
        <>
          <button
            onClick={() => setShowAll(s => !s)}
            style={{
              width: '100%', padding: '8px', border: `1px solid ${COLORS.border}`,
              borderRadius: '8px', backgroundColor: 'transparent',
              color: COLORS.textMuted, cursor: 'pointer', fontSize: '12px',
              fontFamily: 'system-ui, sans-serif', textAlign: 'center',
            }}
          >
            {showAll ? 'Hide' : 'Show'} all {others.length} models {showAll ? '\u25B2' : '\u25BC'}
          </button>

          {showAll && (
            <>
              {/* Filter for all models */}
              <input
                type="text"
                value={allFilter}
                onChange={e => setAllFilter(e.target.value)}
                placeholder="Filter all models..."
                style={{
                  width: '100%', padding: '8px 12px', marginTop: '8px', marginBottom: '6px',
                  borderRadius: '8px', border: `1px solid ${COLORS.border}`,
                  backgroundColor: COLORS.bg, color: COLORS.text,
                  fontSize: '12px', fontFamily: 'system-ui, sans-serif',
                  outline: 'none', boxSizing: 'border-box',
                }}
              />

              {filteredOthers.length > 0 ? (
                <div style={{
                  maxHeight: '240px', overflowY: 'auto',
                  display: 'flex', flexDirection: 'column', gap: '1px',
                }}>
                  {filteredOthers.map(m => (
                    <ModelRow
                      key={m.id}
                      model={m}
                      selected={selectedModel === m.id}
                      onSelect={() => onSelect(m.id)}
                    />
                  ))}
                </div>
              ) : (
                <div style={{
                  padding: '16px', textAlign: 'center',
                  color: COLORS.textDim, fontSize: '12px',
                  fontFamily: 'system-ui, sans-serif',
                }}>
                  No models match &ldquo;{allFilter}&rdquo;
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* No models at all */}
      {models.length === 0 && !loading && (
        <div style={{
          padding: '16px', textAlign: 'center', color: COLORS.textDim,
          fontSize: '12px', fontFamily: 'system-ui, sans-serif',
        }}>
          No models available. Enter your OpenRouter API key above.
        </div>
      )}
    </div>
  );
}
