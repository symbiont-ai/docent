'use client';

// ==========================================================
// DOCENT — Memory Notes Hook
// Sage's persistent memory system for cross-session context
// ==========================================================

import { useState, useEffect, useCallback } from 'react';
import { storage } from '@/src/lib/storage';
import type { MemoryNote } from '@/src/types';

const STORAGE_KEY = 'sage:memory';

export function useMemory() {
  const [sageMemory, setSageMemory] = useState<MemoryNote[]>([]);

  const loadMemory = useCallback(async () => {
    try {
      const { value } = await storage.get(STORAGE_KEY);
      if (value) {
        const parsed = JSON.parse(value);
        if (Array.isArray(parsed)) {
          setSageMemory(parsed);
        }
      }
    } catch (e) {
      console.error('Failed to load memory:', e);
    }
  }, []);

  const persistMemory = useCallback(async (notes: MemoryNote[]) => {
    try {
      await storage.set(STORAGE_KEY, JSON.stringify(notes));
    } catch (e) {
      console.error('Failed to persist memory:', e);
    }
  }, []);

  const saveMemoryNote = useCallback(async (text: string) => {
    const note: MemoryNote = {
      text,
      timestamp: new Date().toISOString(),
    };
    const updated = [...sageMemory, note];
    setSageMemory(updated);
    await persistMemory(updated);
  }, [sageMemory, persistMemory]);

  const deleteMemoryNote = useCallback(async (index: number) => {
    const updated = sageMemory.filter((_, i) => i !== index);
    setSageMemory(updated);
    await persistMemory(updated);
  }, [sageMemory, persistMemory]);

  const clearAllMemory = useCallback(async () => {
    setSageMemory([]);
    try {
      await storage.delete(STORAGE_KEY);
    } catch (e) {
      console.error('Failed to clear memory:', e);
    }
  }, []);

  /**
   * Extracts [NOTE: ...] tags from the AI's response text,
   * saves them as memory notes, and returns the cleaned text.
   */
  const extractMemoryFromResponse = useCallback(async (
    responseText: string,
    userQuery: string,
  ): Promise<string> => {
    const noteRegex = /\[NOTE:\s*(.*?)\]/g;
    const notes: string[] = [];
    let match;

    while ((match = noteRegex.exec(responseText)) !== null) {
      notes.push(match[1].trim());
    }

    if (notes.length > 0) {
      const newNotes: MemoryNote[] = notes.map(text => ({
        text: `${text} (from: "${userQuery.substring(0, 50)}${userQuery.length > 50 ? '...' : ''}")`,
        timestamp: new Date().toISOString(),
      }));

      const updated = [...sageMemory, ...newNotes];
      setSageMemory(updated);
      await persistMemory(updated);
    }

    // Remove [NOTE: ...] tags from the visible response
    const cleaned = responseText.replace(/\[NOTE:\s*.*?\]/g, '').replace(/\n{3,}/g, '\n\n').trim();
    return cleaned;
  }, [sageMemory, persistMemory]);

  /**
   * Builds a context string from all stored memory notes
   * for injection into the system prompt.
   */
  const getMemoryContext = useCallback((): string => {
    if (sageMemory.length === 0) return '';

    const lines = sageMemory.map((n, i) =>
      `${i + 1}. ${n.text} (saved: ${new Date(n.timestamp).toLocaleDateString()})`
    );

    return `\n\nSAGE'S MEMORY NOTES (things you remembered about this user):\n${lines.join('\n')}\nUse these notes to personalize responses. You can save new notes with [NOTE: your observation here].`;
  }, [sageMemory]);

  // Load memory on mount
  useEffect(() => {
    loadMemory();
  }, [loadMemory]);

  return {
    sageMemory,
    loadMemory,
    saveMemoryNote,
    deleteMemoryNote,
    clearAllMemory,
    extractMemoryFromResponse,
    getMemoryContext,
  };
}
