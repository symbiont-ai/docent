// ==========================================================
// DOCENT — Markdown Renderer (pure React, no dependencies)
// ==========================================================

import React from 'react';
import { COLORS } from './colors';

interface TextBlock {
  type: 'text' | 'code' | 'svg';
  content: string;
  lang?: string;
}

let blockKey = 0;

// Parse inline formatting (bold, italic, code, links)
function parseInline(str: string, keyPrefix: string): React.ReactNode {
  const inlineRegex = /(`[^`]+`)|(\[([^\]]+)\]\(([^)]+)\))|(\*\*(.+?)\*\*)|(\*(.+?)\*)/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let inlineMatch;

  while ((inlineMatch = inlineRegex.exec(str)) !== null) {
    if (inlineMatch.index > last) {
      parts.push(str.slice(last, inlineMatch.index));
    }
    if (inlineMatch[1]) {
      const codeText = inlineMatch[1].slice(1, -1);
      parts.push(
        <code key={`${keyPrefix}-c${inlineMatch.index}`} style={{
          background: COLORS.surface, padding: '2px 6px', borderRadius: '3px',
          fontSize: '13px', color: COLORS.accent, fontFamily: 'monospace',
        }}>{codeText}</code>
      );
    } else if (inlineMatch[2]) {
      parts.push(
        <a key={`${keyPrefix}-a${inlineMatch.index}`} href={inlineMatch[4]}
          target="_blank" rel="noopener noreferrer"
          style={{ color: COLORS.cyan, textDecoration: 'underline', textUnderlineOffset: '2px' }}
        >{inlineMatch[3]}</a>
      );
    } else if (inlineMatch[5]) {
      parts.push(<strong key={`${keyPrefix}-b${inlineMatch.index}`} style={{ color: COLORS.text, fontWeight: 600 }}>{inlineMatch[6]}</strong>);
    } else if (inlineMatch[7]) {
      parts.push(<em key={`${keyPrefix}-i${inlineMatch.index}`}>{inlineMatch[8]}</em>);
    }
    last = inlineMatch.index + inlineMatch[0].length;
  }

  if (last < str.length) {
    parts.push(str.slice(last));
  }
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : parts;
}

// Parse a text block into structured React elements
function renderTextBlock(content: string): React.ReactNode[] {
  const paragraphs = content.split(/\n\n+/);
  const elements: React.ReactNode[] = [];

  for (const para of paragraphs) {
    if (!para.trim()) continue;
    const lines = para.split('\n');
    let i = 0;

    while (i < lines.length) {
      const trimmed = lines[i].trim();
      const bk = blockKey++;

      // Horizontal rule
      if (/^(-{3,}|_{3,}|\*{3,})$/.test(trimmed)) {
        elements.push(<hr key={`hr-${bk}`} style={{ border: 'none', borderTop: `1px solid ${COLORS.border}`, margin: '12px 0' }} />);
        i++;
        continue;
      }

      // Headers
      const headerMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
      if (headerMatch) {
        const level = headerMatch[1].length as 1 | 2 | 3 | 4;
        const sizes: Record<number, string> = { 1: '20px', 2: '17px', 3: '15px', 4: '14px' };
        const margins: Record<number, string> = { 1: '16px 0 8px 0', 2: '14px 0 6px 0', 3: '12px 0 4px 0', 4: '10px 0 4px 0' };
        elements.push(
          <div key={`h-${bk}`} style={{
            fontSize: sizes[level], fontWeight: 600, margin: margins[level],
            color: level <= 2 ? COLORS.accent : COLORS.text, lineHeight: '1.4',
          }}>{parseInline(headerMatch[2], `h-${bk}`)}</div>
        );
        i++;
        continue;
      }

      // Blockquote
      if (trimmed.startsWith('> ') || trimmed === '>') {
        const quoteLines: string[] = [];
        while (i < lines.length && (lines[i].trim().startsWith('> ') || lines[i].trim() === '>')) {
          quoteLines.push(lines[i].trim().replace(/^>\s?/, ''));
          i++;
        }
        elements.push(
          <div key={`bq-${bk}`} style={{
            borderLeft: `3px solid ${COLORS.accent}`, paddingLeft: '12px',
            margin: '8px 0', color: COLORS.textMuted, fontStyle: 'italic', lineHeight: '1.6',
          }}>{parseInline(quoteLines.join('\n'), `bq-${bk}`)}</div>
        );
        continue;
      }

      // Unordered list
      if (/^[-*]\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
          i++;
        }
        elements.push(
          <ul key={`ul-${bk}`} style={{ margin: '6px 0', paddingLeft: '20px', lineHeight: '1.6' }}>
            {items.map((item, j) => (
              <li key={j} style={{ margin: '3px 0', color: COLORS.text }}>{parseInline(item, `ul-${bk}-${j}`)}</li>
            ))}
          </ul>
        );
        continue;
      }

      // Ordered list
      if (/^\d+\.\s+/.test(trimmed)) {
        const items: string[] = [];
        while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
          items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
          i++;
        }
        elements.push(
          <ol key={`ol-${bk}`} style={{ margin: '6px 0', paddingLeft: '20px', lineHeight: '1.6' }}>
            {items.map((item, j) => (
              <li key={j} style={{ margin: '3px 0', color: COLORS.text }}>{parseInline(item, `ol-${bk}-${j}`)}</li>
            ))}
          </ol>
        );
        continue;
      }

      // Markdown table: header row + delimiter row + data rows
      if (/^\|.+\|$/.test(trimmed) && i + 1 < lines.length && /^\|[\s:|-]+\|$/.test(lines[i + 1].trim())) {
        const headerCells = trimmed.split('|').slice(1, -1).map(c => c.trim());
        const delimiterCells = lines[i + 1].trim().split('|').slice(1, -1).map(c => c.trim());

        // Parse alignment from delimiter row
        const aligns: ('left' | 'center' | 'right')[] = delimiterCells.map(d => {
          if (d.startsWith(':') && d.endsWith(':')) return 'center';
          if (d.endsWith(':')) return 'right';
          return 'left';
        });

        // Collect data rows
        i += 2; // skip header + delimiter
        const dataRows: string[][] = [];
        while (i < lines.length && /^\|.+\|$/.test(lines[i].trim())) {
          dataRows.push(lines[i].trim().split('|').slice(1, -1).map(c => c.trim()));
          i++;
        }

        const cellBorder = `1px solid ${COLORS.border}`;
        elements.push(
          <div key={`tbl-${bk}`} style={{ margin: '8px 0', overflowX: 'auto', borderRadius: '8px', border: cellBorder }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '14px' }}>
              <thead>
                <tr>
                  {headerCells.map((cell, ci) => (
                    <th key={ci} style={{
                      padding: '8px 12px', textAlign: aligns[ci] || 'left',
                      fontWeight: 600, color: COLORS.accent,
                      backgroundColor: COLORS.surface, borderBottom: `2px solid ${COLORS.accent}`,
                      borderRight: ci < headerCells.length - 1 ? cellBorder : undefined,
                      whiteSpace: 'nowrap',
                    }}>{parseInline(cell, `th-${bk}-${ci}`)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {dataRows.map((row, ri) => (
                  <tr key={ri} style={{ backgroundColor: ri % 2 === 1 ? COLORS.surface + '60' : 'transparent' }}>
                    {row.map((cell, ci) => (
                      <td key={ci} style={{
                        padding: '7px 12px', textAlign: aligns[ci] || 'left',
                        borderBottom: cellBorder,
                        borderRight: ci < row.length - 1 ? cellBorder : undefined,
                        color: COLORS.text, lineHeight: '1.5',
                      }}>{parseInline(cell, `td-${bk}-${ri}-${ci}`)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // Regular paragraph
      elements.push(
        <p key={`p-${bk}`} style={{ margin: '4px 0', lineHeight: '1.6' }}>{parseInline(trimmed, `p-${bk}`)}</p>
      );
      i++;
    }
  }
  return elements;
}

// Main render function: markdown text → React elements
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;

  // Phase 1: Split into blocks (code blocks, SVG blocks, and text)
  const blocks: TextBlock[] = [];
  const blockRegex = /```(\w*)\n([\s\S]*?)```|(<svg[\s\S]*?<\/svg>)/g;
  let lastIndex = 0;
  let match;

  while ((match = blockRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      blocks.push({ type: 'text', content: text.slice(lastIndex, match.index) });
    }
    if (match[3]) {
      blocks.push({ type: 'svg', content: match[3] });
    } else if (match[1] === 'svg') {
      blocks.push({ type: 'svg', content: match[2].trim() });
    } else {
      blocks.push({ type: 'code', lang: match[1] || '', content: match[2].replace(/\n$/, '') });
    }
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) {
    blocks.push({ type: 'text', content: text.slice(lastIndex) });
  }
  if (blocks.length === 0) return null;

  // Phase 2: Render blocks
  blockKey = 0;
  return blocks.map((block, bi) => {
    if (block.type === 'svg') {
      return (
        <div key={`svg-${bi}`} style={{
          margin: '12px 0', padding: '16px', borderRadius: '12px',
          backgroundColor: COLORS.surface, border: `1px solid ${COLORS.border}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          overflow: 'hidden',
        }}>
          <div style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            ref={(el: HTMLDivElement | null) => {
              if (el) {
                const svg = el.querySelector('svg');
                if (svg) {
                  svg.style.width = '100%';
                  svg.style.height = 'auto';
                  if (!svg.getAttribute('viewBox') && svg.getAttribute('width') && svg.getAttribute('height')) {
                    svg.setAttribute('viewBox', `0 0 ${svg.getAttribute('width')} ${svg.getAttribute('height')}`);
                  }
                  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
                }
              }
            }}
            dangerouslySetInnerHTML={{ __html: block.content }}
          />
        </div>
      );
    }
    if (block.type === 'code') {
      return (
        <div key={`cb-${bi}`} style={{ margin: '8px 0', borderRadius: '8px', overflow: 'hidden', border: `1px solid ${COLORS.border}` }}>
          {block.lang && (
            <div style={{
              padding: '4px 12px', backgroundColor: COLORS.border, fontSize: '11px',
              color: COLORS.textMuted, fontFamily: 'monospace', textTransform: 'lowercase',
            }}>{block.lang}</div>
          )}
          <pre style={{
            margin: 0, padding: '12px', backgroundColor: '#0A0F14',
            overflowX: 'auto', fontSize: '13px', lineHeight: '1.5', fontFamily: 'monospace',
          }}>
            <code style={{ color: COLORS.text }}>{block.content}</code>
          </pre>
        </div>
      );
    }
    return <React.Fragment key={`tb-${bi}`}>{renderTextBlock(block.content)}</React.Fragment>;
  });
}
