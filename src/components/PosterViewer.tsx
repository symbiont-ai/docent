'use client';

// ==========================================================
// DOCENT — PosterViewer Component
// Interactive academic poster editor with draggable dividers,
// click-to-swap cards, font scaling, and print-ready A1 output.
// Adapted from posterskill by Ethan Weber.
// ==========================================================

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import type { PosterState, PosterCard, PosterColumn, Figure, ExtractedFigure } from '@/src/types';
import '@/src/app/poster.css';

// mm → px conversion factor (CSS reference pixel)
const MM = 3.7795275591;
const POSTER_W_MM = 841;
const POSTER_H_MM = 594;

interface PosterViewerProps {
  posterState: PosterState;
  setPosterState: React.Dispatch<React.SetStateAction<PosterState | null>>;
  extractedFigures?: ExtractedFigure[];
  onClear?: () => void;
}

// Preprocess SVG for responsive display (same as SlideRenderer)
function preprocessSvg(html: string): string {
  return html.replace(/<svg\b([^>]*)>/i, (_match, attrs: string) => {
    const wMatch = attrs.match(/\bwidth\s*=\s*["']([^"']+)["']/i);
    const hMatch = attrs.match(/\bheight\s*=\s*["']([^"']+)["']/i);
    let newAttrs = attrs;
    if (!/viewBox/i.test(attrs) && wMatch && hMatch) {
      newAttrs += ` viewBox="0 0 ${wMatch[1]} ${hMatch[1]}"`;
    }
    newAttrs = newAttrs.replace(/\b(?:width|height)\s*=\s*["'][^"']*["']/gi, '');
    if (!/preserveAspectRatio/i.test(newAttrs)) {
      newAttrs += ' preserveAspectRatio="xMidYMid meet"';
    }
    const css = 'display:block;width:100%;height:100%;max-width:100%;max-height:100%';
    const styleMatch = newAttrs.match(/\bstyle\s*=\s*["']([^"']*)["']/i);
    if (styleMatch) {
      const cleaned = styleMatch[1].replace(/\b(?:width|height)\s*:[^;]+;?/gi, '').replace(/;?\s*$/, '');
      newAttrs = newAttrs.replace(/\bstyle\s*=\s*["'][^"']*["']/i, `style="${cleaned ? cleaned + ';' : ''}${css}"`);
    } else {
      newAttrs += ` style="${css}"`;
    }
    return `<svg ${newAttrs.trim()}>`;
  });
}

// Render a figure element
function FigureRenderer({ figure, extractedFigures }: { figure: Figure; extractedFigures?: ExtractedFigure[] }) {
  if (figure.type === 'svg' && figure.content) {
    const processed = preprocessSvg(figure.content);
    return (
      <div className="poster-fig">
        <div className="poster-fig-wrap" dangerouslySetInnerHTML={{ __html: processed }} />
        {figure.label && <div className="poster-cap"><b>{figure.label}</b></div>}
        {figure.caption && <div className="poster-cap">{figure.caption}</div>}
      </div>
    );
  }

  if (figure.type === 'extracted_ref' && figure.extractedId) {
    // Try live extractedFigures first (available during the session that created the poster)
    const ef = extractedFigures?.find(f => f.id === figure.extractedId);
    // Fall back to embedded croppedDataURL (persisted with the session)
    const imgSrc = ef?.croppedDataURL || figure.croppedDataURL;
    if (imgSrc) {
      return (
        <div className="poster-fig">
          <div className="poster-fig-wrap">
            <img src={imgSrc} alt={figure.label || ef?.description || ''} />
          </div>
          {(figure.label || ef?.label) && <div className="poster-cap"><b>{figure.label || ef?.label}</b></div>}
          {figure.caption && <div className="poster-cap">{figure.caption}</div>}
        </div>
      );
    }
  }

  if (figure.type === 'image' && figure.src) {
    return (
      <div className="poster-fig">
        <div className="poster-fig-wrap">
          <img src={figure.src} alt={figure.label || ''} />
        </div>
        {figure.label && <div className="poster-cap"><b>{figure.label}</b></div>}
        {figure.caption && <div className="poster-cap">{figure.caption}</div>}
      </div>
    );
  }

  if (figure.type === 'pdf_crop' && figure.croppedDataURL) {
    return (
      <div className="poster-fig">
        <div className="poster-fig-wrap">
          <img src={figure.croppedDataURL} alt={figure.label || ''} />
        </div>
        {figure.label && <div className="poster-cap"><b>{figure.label}</b></div>}
      </div>
    );
  }

  return null;
}

export default function PosterViewer({
  posterState,
  setPosterState,
  extractedFigures,
  onClear,
}: PosterViewerProps) {
  const [selectedCard, setSelectedCard] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [fontScale, setFontScale] = useState(1.3);
  const currentScaleRef = useRef(1);
  const posterRootRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  // Fit poster to viewport
  const fit = useCallback(() => {
    if (!viewportRef.current || !posterRootRef.current) return;
    const vw = viewportRef.current.clientWidth;
    const vh = viewportRef.current.clientHeight;
    const pW = POSTER_W_MM * MM;
    const pH = POSTER_H_MM * MM;
    const scale = Math.min(vw / pW, vh / pH) * 0.98; // 2% padding
    currentScaleRef.current = scale;
    const left = (vw - pW * scale) / 2;
    const top = (vh - pH * scale) / 2;
    posterRootRef.current.style.transform = `translate(${left}px, ${top}px) scale(${scale})`;
  }, []);

  useEffect(() => {
    fit();
    // ResizeObserver catches sidebar collapse/expand (not a window resize event)
    const el = viewportRef.current;
    if (el && typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(() => fit());
      ro.observe(el);
      return () => ro.disconnect();
    }
    // Fallback for environments without ResizeObserver
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);

  // Re-fit when poster state changes
  useEffect(() => { fit(); }, [posterState, fit]);

  // Apply font scale as CSS variable
  useEffect(() => {
    if (posterRootRef.current) {
      posterRootRef.current.style.setProperty('--poster-font-scale', String(fontScale));
    }
  }, [fontScale]);

  // Click outside to deselect
  useEffect(() => {
    function handler(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (selectedCard && !target.closest('.poster-swap-handle') && !target.closest('.poster-drop-zone')) {
        setSelectedCard(null);
      }
    }
    document.addEventListener('click', handler);
    return () => document.removeEventListener('click', handler);
  }, [selectedCard]);

  // ── Layout manipulation ──
  const cloneColumns = useCallback((cols: PosterColumn[]) => {
    return cols.map(c => ({ id: c.id, widthMm: c.widthMm, cards: [...c.cards] }));
  }, []);

  const swapCards = useCallback((id1: string, id2: string) => {
    if (id1 === id2) return;
    setPosterState(prev => {
      if (!prev) return prev;
      const cols = cloneColumns(prev.columns);
      let loc1: { col: PosterColumn; idx: number } | null = null;
      let loc2: { col: PosterColumn; idx: number } | null = null;
      for (const c of cols) {
        const i1 = c.cards.indexOf(id1);
        if (i1 !== -1) loc1 = { col: c, idx: i1 };
        const i2 = c.cards.indexOf(id2);
        if (i2 !== -1) loc2 = { col: c, idx: i2 };
      }
      if (!loc1 || !loc2) return prev;
      loc1.col.cards[loc1.idx] = id2;
      loc2.col.cards[loc2.idx] = id1;
      return { ...prev, columns: cols };
    });
  }, [setPosterState, cloneColumns]);

  const moveCard = useCallback((cardId: string, targetColId: string, position: number) => {
    setPosterState(prev => {
      if (!prev) return prev;
      const cols = cloneColumns(prev.columns);
      for (const c of cols) {
        const i = c.cards.indexOf(cardId);
        if (i !== -1) { c.cards.splice(i, 1); break; }
      }
      const tc = cols.find(c => c.id === targetColId);
      if (!tc) return prev;
      tc.cards.splice(Math.max(0, Math.min(position, tc.cards.length)), 0, cardId);
      return { ...prev, columns: cols };
    });
  }, [setPosterState, cloneColumns]);

  const handleSwapClick = useCallback((cardId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedCard) setSelectedCard(cardId);
    else if (selectedCard === cardId) setSelectedCard(null);
    else { swapCards(selectedCard, cardId); setSelectedCard(null); }
  }, [selectedCard, swapCards]);

  const handleDropZone = useCallback((targetColId: string, position: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!selectedCard) return;
    moveCard(selectedCard, targetColId, position);
    setSelectedCard(null);
  }, [selectedCard, moveCard]);

  // ── Card (row) resize ──
  const handleRowResize = useCallback((cardId: string, _colId: string, e: React.MouseEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('active');
    const startY = e.clientY;
    const scale = currentScaleRef.current;
    const cardEl = document.querySelector(`.poster-card[data-id="${cardId}"]`) as HTMLElement | null;
    const startH = cardEl ? cardEl.getBoundingClientRect().height / scale : 100;

    const onMove = (ev: MouseEvent) => {
      const dy = (ev.clientY - startY) / scale;
      const newHpx = Math.max(20 * MM, startH + dy); // min 20mm
      const newHmm = Math.round(newHpx / MM);
      setPosterState(prev => {
        if (!prev) return prev;
        const card = prev.cards[cardId];
        if (!card) return prev;
        return {
          ...prev,
          cards: { ...prev.cards, [cardId]: { ...card, heightMm: newHmm, grow: false } },
        };
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'row-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [setPosterState]);

  // ── Column resize ──
  const handleColResize = useCallback((dividerIdx: number, e: React.MouseEvent) => {
    e.preventDefault();
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add('active');

    // Resize the column on the left side of this divider
    const targetColIdx = dividerIdx;
    const startX = e.clientX;
    const scale = currentScaleRef.current;

    // Get current column width from its rendered size
    const colEl = document.getElementById(posterState.columns[targetColIdx]?.id || '');
    const startW = colEl ? colEl.getBoundingClientRect().width / scale : 250 * MM;

    const onMove = (ev: MouseEvent) => {
      const dx = (ev.clientX - startX) / scale;
      const newW = Math.max(120, (startW + dx) / MM);
      setPosterState(prev => {
        if (!prev) return prev;
        const cols = cloneColumns(prev.columns);
        if (cols[targetColIdx]) cols[targetColIdx].widthMm = Math.round(newW);
        return { ...prev, columns: cols };
      });
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      handle.classList.remove('active');
      document.body.style.cursor = '';
    };
    document.body.style.cursor = 'col-resize';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [posterState.columns, setPosterState, cloneColumns]);

  // ── Determine which cards should grow ──
  const growingCards = useMemo(() => {
    const growing = new Set<string>();
    for (const col of posterState.columns) {
      const hasGrower = col.cards.some(cid => posterState.cards[cid]?.grow);
      if (hasGrower) {
        col.cards.forEach(cid => {
          if (posterState.cards[cid]?.grow) growing.add(cid);
        });
      } else if (col.cards.length > 0) {
        // Last card in column grows by default if no explicit grower
        growing.add(col.cards[col.cards.length - 1]);
      }
    }
    return growing;
  }, [posterState.columns, posterState.cards]);

  // ── Render a card ──
  const renderCard = (cardId: string) => {
    const card = posterState.cards[cardId];
    if (!card) return null;

    const classes = ['poster-card'];
    if (growingCards.has(cardId)) classes.push('grow');
    if (selectedCard === cardId) classes.push('swap-selected');

    const style: React.CSSProperties = card.heightMm
      ? { height: `${card.heightMm}mm`, flex: '0 0 auto' }
      : {};

    return (
      <div key={cardId} className={classes.join(' ')} data-id={cardId} data-color={card.color || 'blue'} style={style}>
        {!preview && (
          <button className="poster-swap-handle" onClick={(e) => handleSwapClick(cardId, e)}>
            &#x2725;
          </button>
        )}
        <h2>{card.title}</h2>

        {/* Highlights */}
        {card.highlights?.map((hl, i) => (
          <div key={`hl-${i}`} className="poster-hl"><p>{hl}</p></div>
        ))}

        {/* Bullets */}
        {card.bullets && card.bullets.length > 0 && (
          <ul>
            {card.bullets.map((b, i) => <li key={i}>{b}</li>)}
          </ul>
        )}

        {/* Figure */}
        {card.figure && <FigureRenderer figure={card.figure} extractedFigures={extractedFigures} />}

        {/* Table */}
        {card.table && (
          <table>
            <thead>
              <tr>{card.table.headers.map((h, i) => <th key={i}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {card.table.rows.map((row, ri) => (
                <tr key={ri}>
                  {row.map((cell, ci) => <td key={ci}>{cell}</td>)}
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {/* Equation */}
        {card.equation && (
          <div className="poster-eq">{card.equation}</div>
        )}
      </div>
    );
  };

  // ── Render drop zone ──
  const renderDropZone = (colId: string, position: number) => {
    const visible = selectedCard !== null;
    return (
      <div
        key={`dz-${colId}-${position}`}
        className={`poster-drop-zone${visible ? ' visible' : ''}`}
        onClick={(e) => handleDropZone(colId, position, e)}
      >
        {visible && <div className="poster-drop-zone-inner" />}
      </div>
    );
  };

  // ── Render column ──
  const renderColumn = (col: PosterColumn) => {
    const style: React.CSSProperties = col.widthMm != null
      ? { flex: `0 0 ${col.widthMm}mm` }
      : { flex: '1.5' };

    return (
      <div key={col.id} className="poster-col" id={col.id} style={style}>
        {!preview && renderDropZone(col.id, 0)}
        {col.cards.map((cardId, i) => (
          <React.Fragment key={cardId}>
            {renderCard(cardId)}
            {!preview && i < col.cards.length - 1 && (
              <div
                className="poster-divider poster-row-resize"
                onMouseDown={(e) => handleRowResize(cardId, col.id, e)}
              />
            )}
            {!preview && renderDropZone(col.id, i + 1)}
          </React.Fragment>
        ))}
      </div>
    );
  };

  // Empty state
  if (!posterState || Object.keys(posterState.cards).length === 0) {
    return (
      <div className="poster-empty">
        <div className="poster-empty-icon">📋</div>
        <div className="poster-empty-title">No Poster Yet</div>
        <div className="poster-empty-text">
          Upload a PDF and ask Sage to &ldquo;make a poster&rdquo;, or request a poster on any topic.
        </div>
      </div>
    );
  }

  return (
    <div className="poster-viewport" ref={viewportRef}>
      {/* Toolbar */}
      <div className="poster-toolbar">
        <button
          className={preview ? 'active' : ''}
          onClick={() => setPreview(!preview)}
        >
          {preview ? '✏️ Edit' : '👁️ Preview'}
        </button>
        {!preview && (
          <>
            <button onClick={() => setFontScale(s => Math.max(0.8, s - 0.1))}>A−</button>
            <button onClick={() => setFontScale(s => s + 0.1)}>A+</button>
          </>
        )}
        <button onClick={() => window.print()}>🖨️ Print</button>
        {onClear && <button onClick={onClear}>🗑️ Clear</button>}
      </div>

      {/* Poster */}
      <div
        ref={posterRootRef}
        className={`poster-root${preview ? ' preview' : ''}`}
      >
        {/* Header */}
        <div className="poster-header">
          <div className="poster-header-left">
            <h1>{posterState.title}</h1>
            {posterState.authors && <div className="poster-authors">{posterState.authors}</div>}
            {posterState.affiliations && <div className="poster-affiliations">{posterState.affiliations}</div>}
          </div>
        </div>

        {/* Body columns */}
        <div className="poster-body" id="poster-body">
          {posterState.columns.map((col, colIdx) => (
            <React.Fragment key={col.id}>
              {colIdx > 0 && !preview && (
                <div
                  className="poster-divider poster-col-resize"
                  onMouseDown={(e) => handleColResize(colIdx - 1, e)}
                />
              )}
              {renderColumn(col)}
            </React.Fragment>
          ))}
        </div>
      </div>
    </div>
  );
}
