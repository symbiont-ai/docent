'use client';

import React, { useState } from 'react';
import { COLORS } from '@/src/lib/colors';
import type { Session, MemoryNote, SidebarTab } from '@/src/types';

interface SidebarProps {
  show: boolean;
  savedSessions: Session[];
  currentSessionId: string | null;
  loadingSessions: boolean;
  sageMemory: MemoryNote[];
  onLoadSession: (session: Session) => void;
  onDeleteSession: (sessionId: string) => void;
  onNewSession: () => void;
  onClearAllSessions: () => void;
  onDeleteMemoryNote: (index: number) => void;
  onClearAllMemory: () => void;
  sessionBusy: string;
}

function formatDate(dateStr: string): string {
  if (!dateStr) return '';
  try {
    const d = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - d.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return 'just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours}h ago`;
    const diffDays = Math.floor(diffHours / 24);
    if (diffDays < 7) return `${diffDays}d ago`;
    return d.toLocaleDateString();
  } catch {
    return dateStr;
  }
}

export default function Sidebar({
  show,
  savedSessions,
  currentSessionId,
  loadingSessions,
  sageMemory,
  onLoadSession,
  onDeleteSession,
  onNewSession,
  onClearAllSessions,
  onDeleteMemoryNote,
  onClearAllMemory,
  sessionBusy,
}: SidebarProps) {
  const [sidebarTab, setSidebarTab] = useState<SidebarTab>('sessions');
  const [confirmClearSessions, setConfirmClearSessions] = useState(false);
  const [confirmClearMemory, setConfirmClearMemory] = useState(false);

  if (!show) return null;

  return (
    <div className="print-hide sidebar-panel" style={{
      width: '280px', borderRight: `1px solid ${COLORS.border}`,
      display: 'flex', flexDirection: 'column',
      backgroundColor: COLORS.surface, flexShrink: 0,
    }}>
      {/* Sidebar tabs */}
      <div style={{ display: 'flex', borderBottom: `1px solid ${COLORS.border}` }}>
        <button
          onClick={() => setSidebarTab('sessions')}
          style={{
            flex: 1, padding: '10px',
            backgroundColor: sidebarTab === 'sessions' ? COLORS.surfaceHover : 'transparent',
            border: 'none',
            color: sidebarTab === 'sessions' ? COLORS.accent : COLORS.textDim,
            cursor: 'pointer', fontSize: '12px', fontWeight: 500,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\uD83D\uDCC1'} Sessions
        </button>
        <button
          onClick={() => setSidebarTab('memory')}
          style={{
            flex: 1, padding: '10px',
            backgroundColor: sidebarTab === 'memory' ? COLORS.surfaceHover : 'transparent',
            border: 'none',
            color: sidebarTab === 'memory' ? COLORS.purple : COLORS.textDim,
            cursor: 'pointer', fontSize: '12px', fontWeight: 500,
            fontFamily: 'system-ui, sans-serif',
          }}
        >
          {'\uD83E\uDDE0'} Memory
        </button>
      </div>

      {/* ===== Sessions tab ===== */}
      {sidebarTab === 'sessions' && (
        <div style={{
          flex: 1, overflowY: 'auto', padding: '8px',
          display: 'flex', flexDirection: 'column', gap: '2px',
        }}>
          {/* New Session */}
          <button
            onClick={() => !sessionBusy && onNewSession()}
            style={{
              padding: '10px 12px', marginBottom: '4px', borderRadius: '8px',
              border: `1px dashed ${COLORS.accent}`,
              backgroundColor: COLORS.accentBg, color: COLORS.accent,
              cursor: sessionBusy ? 'wait' : 'pointer',
              fontSize: '13px', fontWeight: 500, fontFamily: 'system-ui, sans-serif',
              textAlign: 'left', opacity: sessionBusy ? 0.6 : 1,
            }}
          >
            + New Session
          </button>

          {/* Clear all sessions */}
          {savedSessions.length > 0 && (
            confirmClearSessions ? (
              <div style={{
                padding: '8px', marginBottom: '4px', borderRadius: '8px',
                border: `1px solid ${COLORS.red}`, backgroundColor: COLORS.redBg,
                display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{
                  fontSize: '12px', color: COLORS.red, fontFamily: 'system-ui, sans-serif',
                }}>
                  Delete all {savedSessions.length} sessions?
                </span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => { onClearAllSessions(); setConfirmClearSessions(false); }}
                    style={{
                      padding: '4px 10px', fontSize: '11px', borderRadius: '4px',
                      border: 'none', backgroundColor: COLORS.red, color: 'white',
                      cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                    }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmClearSessions(false)}
                    style={{
                      padding: '4px 10px', fontSize: '11px', borderRadius: '4px',
                      border: `1px solid ${COLORS.border}`, backgroundColor: 'transparent',
                      color: COLORS.textMuted, cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                    }}
                  >
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClearSessions(true)}
                style={{
                  padding: '6px 12px', marginBottom: '4px', borderRadius: '8px',
                  border: `1px solid ${COLORS.border}`,
                  backgroundColor: 'transparent', color: COLORS.textDim,
                  cursor: 'pointer', fontSize: '11px', fontFamily: 'system-ui, sans-serif',
                  textAlign: 'left',
                }}
              >
                Clear All Sessions
              </button>
            )
          )}

          {/* Sessions list */}
          {loadingSessions ? (
            <p style={{
              color: COLORS.textDim, padding: '8px', fontSize: '13px',
              fontFamily: 'system-ui, sans-serif',
            }}>
              Loading...
            </p>
          ) : savedSessions.length === 0 ? (
            <p style={{
              color: COLORS.textDim, padding: '8px', fontSize: '13px',
              fontFamily: 'system-ui, sans-serif',
            }}>
              No saved sessions yet
            </p>
          ) : (
            savedSessions.map(session => {
              const isActive = currentSessionId === session.id;
              const hasPres = !!session.presentation;
              const pdfMeta = session.filesMeta?.find(f => f.mediaType === 'application/pdf');
              const subtitle = [
                `${session.messageCount || session.messages?.length || 0} msgs`,
                hasPres ? '\uD83D\uDCCA' : null,
                pdfMeta
                  ? `\uD83D\uDCC4 ${pdfMeta.name}`
                  : session.filesMeta?.length > 0
                    ? `\uD83D\uDCCE ${session.filesMeta.length} file(s)`
                    : null,
              ].filter(Boolean).join(' \u00B7 ');

              return (
                <div
                  key={session.id}
                  onClick={() => !sessionBusy && onLoadSession(session)}
                  style={{
                    padding: '10px 12px', borderRadius: '8px',
                    cursor: sessionBusy ? 'wait' : 'pointer',
                    backgroundColor: isActive ? COLORS.surfaceHover : 'transparent',
                    border: isActive ? `1px solid ${COLORS.accentBorder}` : '1px solid transparent',
                    opacity: sessionBusy ? 0.6 : 1,
                    display: 'flex', alignItems: 'flex-start', gap: '6px',
                    overflow: 'hidden',
                  }}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); onDeleteSession(session.id); }}
                    style={{
                      padding: '2px 4px', fontSize: '10px', flexShrink: 0,
                      backgroundColor: 'transparent', color: COLORS.red,
                      border: 'none', cursor: 'pointer', opacity: 0.6,
                      lineHeight: 1,
                    }}
                  >
                    {'\u2715'}
                  </button>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{
                      fontSize: '13px', fontWeight: 500, color: COLORS.text,
                      marginBottom: '2px', overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      fontFamily: 'system-ui, sans-serif',
                    }}>
                      {session.title}
                    </div>
                    <div style={{
                      fontSize: '11px', color: COLORS.textDim,
                      fontFamily: 'system-ui, sans-serif',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {subtitle} {'\u00B7'} {formatDate(session.updatedAt)}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ===== Memory tab ===== */}
      {sidebarTab === 'memory' && (
        <div style={{ flex: 1, overflowY: 'auto', padding: '12px' }}>
          <div style={{
            display: 'flex', justifyContent: 'space-between', alignItems: 'center',
            marginBottom: '12px',
          }}>
            <h3 style={{
              margin: 0, fontSize: '13px', color: COLORS.purple,
              textTransform: 'uppercase', letterSpacing: '0.5px',
              fontFamily: 'system-ui, sans-serif',
            }}>
              {'\uD83C\uDF3F'} Sage&apos;s Notes
            </h3>
            <span style={{
              fontSize: '11px', color: COLORS.textDim, fontFamily: 'system-ui, sans-serif',
            }}>
              {sageMemory.length}
            </span>
          </div>

          <p style={{
            fontSize: '11px', color: COLORS.textDim, margin: '0 0 12px 0',
            lineHeight: '1.5', fontFamily: 'system-ui, sans-serif',
          }}>
            Sage remembers key insights across sessions. Notes are extracted automatically
            or when Sage uses [NOTE: ...] tags.
          </p>

          {sageMemory.length === 0 ? (
            <p style={{
              fontSize: '12px', color: COLORS.textDim, fontStyle: 'italic',
              fontFamily: 'system-ui, sans-serif',
            }}>
              No memories yet. Start a conversation and Sage will remember important details.
            </p>
          ) : (
            sageMemory.map((mem, i) => (
              <div key={i} style={{
                padding: '8px 10px', marginBottom: '6px',
                backgroundColor: COLORS.surfaceHover, borderRadius: '6px',
                fontSize: '12px', color: COLORS.text, borderLeft: '3px solid #A78BFA',
                position: 'relative', fontFamily: 'system-ui, sans-serif', lineHeight: '1.5',
              }}>
                <button
                  onClick={() => onDeleteMemoryNote(i)}
                  style={{
                    position: 'absolute', top: '4px', right: '4px',
                    padding: '2px 6px', fontSize: '10px',
                    backgroundColor: 'transparent', border: 'none',
                    color: COLORS.textDim, cursor: 'pointer', opacity: 0.6,
                  }}
                  title="Delete note"
                >
                  {'\u2715'}
                </button>
                {mem.text}
                <div style={{
                  fontSize: '10px', color: COLORS.textDim, marginTop: '4px',
                }}>
                  {formatDate(mem.timestamp)}
                </div>
              </div>
            ))
          )}

          {/* Clear all memory */}
          {sageMemory.length > 0 && (
            confirmClearMemory ? (
              <div style={{
                marginTop: '12px', padding: '8px', borderRadius: '8px',
                border: `1px solid ${COLORS.red}`, backgroundColor: COLORS.redBg,
                display: 'flex', gap: '6px', alignItems: 'center', justifyContent: 'space-between',
              }}>
                <span style={{
                  fontSize: '12px', color: COLORS.red, fontFamily: 'system-ui, sans-serif',
                }}>
                  Erase all {sageMemory.length} notes?
                </span>
                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    onClick={() => { onClearAllMemory(); setConfirmClearMemory(false); }}
                    style={{
                      padding: '4px 10px', fontSize: '11px', borderRadius: '4px',
                      border: 'none', backgroundColor: COLORS.red, color: 'white',
                      cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                    }}
                  >
                    Yes
                  </button>
                  <button
                    onClick={() => setConfirmClearMemory(false)}
                    style={{
                      padding: '4px 10px', fontSize: '11px', borderRadius: '4px',
                      border: `1px solid ${COLORS.border}`, backgroundColor: 'transparent',
                      color: COLORS.textMuted, cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                    }}
                  >
                    No
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => setConfirmClearMemory(true)}
                style={{
                  marginTop: '12px', padding: '6px 12px', fontSize: '11px',
                  borderRadius: '6px', border: `1px solid ${COLORS.red}`,
                  backgroundColor: 'transparent', color: COLORS.red,
                  cursor: 'pointer', fontFamily: 'system-ui, sans-serif',
                }}
              >
                Clear All Memory
              </button>
            )
          )}
        </div>
      )}
    </div>
  );
}
