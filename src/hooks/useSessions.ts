'use client';

// ==========================================================
// DOCENT — Sessions Hook
// Session persistence via IndexedDB with file chunking
// ==========================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import { storage } from '@/src/lib/storage';
import type {
  Session,
  SessionFileMeta,
  SessionTokenUsage,
  Message,
  UploadedFile,
  PresentationState,
  Slide,
} from '@/src/types';

const SESSION_PREFIX = 'docent:session:';
const FILE_CHUNK_PREFIX = 'docent:filechunk:';
const CHUNK_SIZE = 4 * 1024 * 1024; // 4MB per chunk for IndexedDB

/** Callbacks pattern — keeps the hook decoupled from other hooks. */
export interface SessionCallbacks {
  setMessages: (msgs: Message[]) => void;
  setUploadedFiles: (files: UploadedFile[]) => void;
  setPresentationState?: (state: PresentationState) => void;
  setPdfPage?: (page: number) => void;
  setPdfZoom?: (zoom: number) => void;
  loadPdf?: (dataURL: string) => Promise<unknown>;
  removePdf?: () => void;
  setLoadingMsg?: (msg: string) => void;
  setLastTokenUsage?: (usage: SessionTokenUsage | null) => void;
  setSelectedModel?: (model: string) => void;
}

export function useSessions() {
  const [savedSessions, setSavedSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionBusy, setSessionBusy] = useState('');

  const savingRef = useRef(false);
  const justClearedRef = useRef(false);

  /**
   * Load list of all saved sessions from IndexedDB.
   */
  const loadSavedSessions = useCallback(async () => {
    setLoadingSessions(true);
    try {
      const { keys: sessionKeys } = await storage.list(SESSION_PREFIX);
      const sessions: Session[] = [];

      for (const key of sessionKeys) {
        try {
          const { value } = await storage.get(key);
          if (value) {
            sessions.push(JSON.parse(value));
          }
        } catch (e) {
          console.warn('Failed to parse session:', key, e);
        }
      }

      // Sort by updatedAt descending (most recent first)
      sessions.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
      setSavedSessions(sessions);
    } catch (e) {
      console.error('Failed to load sessions:', e);
    } finally {
      setLoadingSessions(false);
    }
  }, []);

  /**
   * Split a large data URL into chunks for IndexedDB storage.
   */
  const chunkDataURL = useCallback((dataURL: string): string[] => {
    const chunks: string[] = [];
    for (let i = 0; i < dataURL.length; i += CHUNK_SIZE) {
      chunks.push(dataURL.slice(i, i + CHUNK_SIZE));
    }
    return chunks;
  }, []);

  /**
   * Reassemble a chunked data URL from IndexedDB.
   */
  const reassembleChunks = useCallback(async (storageKey: string, numChunks: number): Promise<string> => {
    let result = '';
    for (let i = 0; i < numChunks; i++) {
      const { value } = await storage.get(`${storageKey}:${i}`);
      result += value || '';
    }
    return result;
  }, []);

  /**
   * Save the current session.
   * Generates a title from the first message or presentation title.
   * Stores files as chunked data in IndexedDB.
   */
  const saveSession = useCallback(async (
    msgs: Message[],
    existingSessionId?: string,
    uploadedFiles?: UploadedFile[],
    presentationState?: PresentationState | null,
    pdfPage?: number,
    pdfZoom?: number,
    tokenUsage?: SessionTokenUsage | null,
    selectedModel?: string,
  ): Promise<string | null> => {
    // Prevent concurrent saves
    if (savingRef.current) {
      console.warn('[Sessions] Save skipped: already saving');
      return null;
    }
    // Prevent ghost saves after clear
    if (justClearedRef.current) {
      console.warn('[Sessions] Save skipped: just cleared');
      justClearedRef.current = false;
      return null;
    }

    if (msgs.length === 0) {
      console.warn('[Sessions] Save skipped: no messages');
      return null;
    }

    savingRef.current = true;

    try {
      const sessionId = existingSessionId || `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const now = new Date().toISOString();

      // Generate title from first user message or presentation title
      let title = 'Untitled Session';
      if (presentationState?.slides?.length && presentationState.title) {
        title = presentationState.title;
      } else {
        const firstUserMsg = msgs.find(m => m.sender === 'user');
        if (firstUserMsg) {
          title = firstUserMsg.text.substring(0, 60) + (firstUserMsg.text.length > 60 ? '...' : '');
        }
      }

      // Store files as chunks
      const filesMeta: SessionFileMeta[] = [];
      if (uploadedFiles) {
        for (let i = 0; i < uploadedFiles.length; i++) {
          const file = uploadedFiles[i];
          const storageKey = `${FILE_CHUNK_PREFIX}${sessionId}:file_${i}`;
          const chunks = chunkDataURL(file.dataURL);

          for (let c = 0; c < chunks.length; c++) {
            await storage.set(`${storageKey}:${c}`, chunks[c]);
          }

          filesMeta.push({
            name: file.name,
            mediaType: file.mediaType,
            size: file.size,
            storageKey,
            chunks: chunks.length,
          });
        }
      }

      // Build session object (strip attachments from messages to save space)
      const session: Session = {
        id: sessionId,
        title,
        selectedModel: selectedModel || undefined,
        messages: msgs
          .filter(m => !m.isThinking)
          .map(m => ({ id: m.id, sender: m.sender, text: m.text, language: m.language })),
        filesMeta,
        presentation: presentationState?.slides?.length
          ? {
              slides: presentationState.slides,
              title: presentationState.title,
              language: presentationState.language || 'en',
              currentSlide: presentationState.currentSlide,
            }
          : null,
        pdfViewer: pdfPage != null
          ? { page: pdfPage, zoom: pdfZoom || 1.0 }
          : null,
        tokenUsage: tokenUsage || null,
        messageCount: msgs.filter(m => !m.isThinking).length,
        createdAt: existingSessionId
          ? (savedSessions.find(s => s.id === sessionId)?.createdAt || now)
          : now,
        updatedAt: now,
      };

      await storage.set(`${SESSION_PREFIX}${sessionId}`, JSON.stringify(session));
      setCurrentSessionId(sessionId);

      // Refresh session list
      await loadSavedSessions();

      return sessionId;
    } catch (e) {
      console.error('Failed to save session:', e);
      return null;
    } finally {
      savingRef.current = false;
    }
  }, [savedSessions, chunkDataURL, loadSavedSessions]);

  /**
   * Load a saved session, restoring messages, files, and presentation state.
   */
  const loadSession = useCallback(async (
    session: Session,
    callbacks: SessionCallbacks,
  ): Promise<void> => {
    setSessionBusy('Loading session...');

    try {
      // ─── Clear all current state before restoring ───
      // This ensures no stale assets (slides, PDF) bleed from the previous session.
      // Mirrors what newSession() does — always start with a clean slate.
      callbacks.setPresentationState?.({
        slides: [], currentSlide: 0, title: '', language: 'en',
        isPresenting: false, autoAdvance: false, speakerNotesVisible: false,
      });
      callbacks.removePdf?.();

      // Restore messages
      const messages: Message[] = session.messages.map(m => ({
        ...m,
        attachments: null,
      }));
      callbacks.setMessages(messages);

      // Restore files
      const files: UploadedFile[] = [];
      for (const meta of session.filesMeta) {
        try {
          callbacks.setLoadingMsg?.(`Restoring file: ${meta.name}...`);
          const dataURL = await reassembleChunks(meta.storageKey, meta.chunks);
          const file: UploadedFile = {
            name: meta.name,
            mediaType: meta.mediaType,
            dataURL,
            size: meta.size,
          };
          files.push(file);

          // If it's a PDF, reload it
          if (meta.mediaType === 'application/pdf' && callbacks.loadPdf) {
            await callbacks.loadPdf(dataURL);
          }
        } catch (e) {
          console.warn(`Failed to restore file ${meta.name}:`, e);
        }
      }
      callbacks.setUploadedFiles(files);

      // Restore presentation (isPresenting=false until user clicks Narrate, matching loadPresentation behavior)
      if (session.presentation && callbacks.setPresentationState) {
        callbacks.setPresentationState({
          slides: session.presentation.slides as Slide[],
          title: session.presentation.title,
          language: (session.presentation as { language?: string }).language || 'en',
          currentSlide: session.presentation.currentSlide,
          isPresenting: false,
          autoAdvance: true,
          speakerNotesVisible: true,
        });
      }

      // Restore PDF viewer state
      if (session.pdfViewer) {
        callbacks.setPdfPage?.(session.pdfViewer.page);
        callbacks.setPdfZoom?.(session.pdfViewer.zoom);
      }

      // Restore token usage (or clear it for old sessions without this field)
      callbacks.setLastTokenUsage?.(session.tokenUsage || null);

      // Restore selected model
      if (session.selectedModel && callbacks.setSelectedModel) {
        callbacks.setSelectedModel(session.selectedModel);
      }

      setCurrentSessionId(session.id);
      callbacks.setLoadingMsg?.('');
    } catch (e) {
      console.error('Failed to load session:', e);
    } finally {
      setSessionBusy('');
    }
  }, [reassembleChunks]);

  /**
   * Delete a single session and its associated file chunks.
   */
  const deleteSession = useCallback(async (
    sessionId: string,
    callbacks?: SessionCallbacks,
  ): Promise<void> => {
    setSessionBusy('Deleting...');

    try {
      // Find the session to get file storage keys
      const { value } = await storage.get(`${SESSION_PREFIX}${sessionId}`);
      if (value) {
        const session: Session = JSON.parse(value);
        // Delete all file chunks
        for (const meta of session.filesMeta) {
          for (let i = 0; i < meta.chunks; i++) {
            await storage.delete(`${meta.storageKey}:${i}`);
          }
        }
      }

      // Delete the session itself
      await storage.delete(`${SESSION_PREFIX}${sessionId}`);

      // If this was the current session, clear state
      if (currentSessionId === sessionId) {
        setCurrentSessionId(null);
        if (callbacks) {
          callbacks.setMessages([]);
          callbacks.setUploadedFiles([]);
          callbacks.setPresentationState?.({
            slides: [], currentSlide: 0, title: '', language: 'en',
            isPresenting: false, autoAdvance: false, speakerNotesVisible: false,
          });
          callbacks.removePdf?.();
        }
      }

      await loadSavedSessions();
    } catch (e) {
      console.error('Failed to delete session:', e);
    } finally {
      setSessionBusy('');
    }
  }, [currentSessionId, loadSavedSessions]);

  /**
   * Clear all saved sessions and their file data.
   */
  const clearAllSessions = useCallback(async (
    callbacks?: SessionCallbacks,
  ): Promise<void> => {
    setSessionBusy('Clearing all sessions...');
    justClearedRef.current = true;

    try {
      // Delete all session data
      const { keys: sessionKeys } = await storage.list(SESSION_PREFIX);
      for (const key of sessionKeys) {
        try {
          const { value } = await storage.get(key);
          if (value) {
            const session: Session = JSON.parse(value);
            for (const meta of session.filesMeta) {
              for (let i = 0; i < meta.chunks; i++) {
                await storage.delete(`${meta.storageKey}:${i}`);
              }
            }
          }
        } catch { /* best effort */ }
        await storage.delete(key);
      }

      // Also clean up orphaned file chunks
      const { keys: chunkKeys } = await storage.list(FILE_CHUNK_PREFIX);
      for (const key of chunkKeys) {
        await storage.delete(key);
      }

      setSavedSessions([]);
      setCurrentSessionId(null);

      if (callbacks) {
        callbacks.setMessages([]);
        callbacks.setUploadedFiles([]);
        callbacks.setPresentationState?.({
          slides: [], currentSlide: 0, title: '', language: 'en',
          isPresenting: false, autoAdvance: false, speakerNotesVisible: false,
        });
        callbacks.removePdf?.();
      }
    } catch (e) {
      console.error('Failed to clear sessions:', e);
    } finally {
      setSessionBusy('');
    }
  }, []);

  /**
   * Start a new, clean session.
   */
  const newSession = useCallback((callbacks: SessionCallbacks) => {
    // Don't set justClearedRef here — it would block the first save in the
    // new session. justClearedRef is only needed after clearAllSessions to
    // prevent ghost saves from stale re-renders.
    setCurrentSessionId(null);
    callbacks.setMessages([]);
    callbacks.setUploadedFiles([]);
    callbacks.setPresentationState?.({
      slides: [],
      currentSlide: 0,
      title: '',
      language: 'en',
      isPresenting: false,
      autoAdvance: false,
      speakerNotesVisible: false,
    });
    callbacks.removePdf?.();
    callbacks.setLoadingMsg?.('');
    callbacks.setLastTokenUsage?.(null);
  }, []);

  // Load sessions on mount
  useEffect(() => {
    loadSavedSessions();
  }, [loadSavedSessions]);

  return {
    // State
    savedSessions,
    currentSessionId,
    loadingSessions,
    sessionBusy,

    // Setters
    setCurrentSessionId,

    // Refs
    savingRef,
    justClearedRef,

    // Functions
    loadSavedSessions,
    saveSession,
    loadSession,
    deleteSession,
    clearAllSessions,
    newSession,
  };
}
