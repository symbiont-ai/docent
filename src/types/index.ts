// ==========================================================
// DOCENT — Type Definitions
// ==========================================================

export interface UploadedFile {
  name: string;
  mediaType: string;
  dataURL: string;
  size: number;
}

export interface MessageAttachment {
  mediaType: string;
  dataURL: string;
  name?: string;
}

export interface Message {
  id: number;
  sender: 'user' | 'sage' | 'system';
  text: string;
  isThinking?: boolean;
  attachments?: MessageAttachment[] | null;
  language?: string;  // ISO 639-1 code, detected from response content
}

export type FigureType = 'svg' | 'pdf_crop' | 'image_ref' | 'image' | 'card' | 'extracted_ref';

export interface Figure {
  type: FigureType;
  content?: string;        // SVG content
  page?: number;           // pdf_crop page number
  region?: number[] | string; // pdf_crop region [l,t,r,b] or preset name
  label?: string;
  description?: string;
  croppedDataURL?: string; // pdf_crop rendered result
  src?: string;            // image src (data URL)
  imageId?: string;        // image_ref ID
  extractedId?: string;    // extracted_ref ID (references ExtractedFigure.id)
  caption?: string;        // Attribution/credit shown below the image
  imagePrompt?: string;    // The prompt used to generate/find this image
}

/** A figure/table/equation located by the extraction pass (Pass 1). */
export interface ExtractedFigure {
  id: string;                                    // "ef_1", "ef_2", ...
  kind: 'figure' | 'table' | 'equation' | 'diagram' | 'chart' | 'photo' | 'algorithm';
  page: number;                                  // 1-indexed
  region: [number, number, number, number];      // [left, top, right, bottom] normalized 0-1
  label?: string;                                // "Figure 3", "Table 1"
  description: string;                           // AI-generated brief description
  croppedDataURL?: string;                       // Populated after pre-cropping (high-res for display)
  apiDataURL?: string;                            // Compressed JPEG for API use (max 800px, 70% quality)
}

/** Result of the extraction pass (Pass 1). */
export interface ExtractionResult {
  figures: ExtractedFigure[];
  model: string;
  extractedAt: number;
  mainBodyPages: number;              // Pages analyzed (before supplementary cutoff)
  supplementaryStartPage?: number;    // First page of supplementary material (if detected)
}

// ── Assessment (Socratic) ─────────────────────────────────

export type AssessmentTier = 1 | 2 | 3;  // Recall, Application, Synthesis
export type AssessmentPhase = 'idle' | 'active' | 'report';

export interface AssessmentQuestion {
  questionNumber: number;
  tier: AssessmentTier;
  question: string;
  slideContext: string;    // slide title / concept being tested
}

export interface AssessmentAnswer {
  questionNumber: number;
  userAnswer: string;
  score: number;           // 0 | 0.5 | 1.0
  acknowledgment: string;
  tier: AssessmentTier;
  slideContext: string;    // concept that was tested (copied from question)
}

export interface AssessmentState {
  phase: AssessmentPhase;
  theta: number;                    // -1.0 to +1.0, starts 0
  currentQuestionNumber: number;    // 1-indexed, 0 when idle
  questions: AssessmentQuestion[];
  answers: AssessmentAnswer[];
  consecutiveT3Correct: number;
  consecutiveT1Incorrect: number;
  offeredThisPresentation: boolean;
}

/** Persisted subset of assessment — saved in Session */
export interface SessionAssessment {
  theta: number;
  questions: AssessmentQuestion[];
  answers: AssessmentAnswer[];
  completedAt?: string;
}

// ── Presentation modes ─────────────────────────────────────

/** Presentation generation mode — determines narrative stance and plan visibility. */
export type PresentationMode = 'general' | 'author' | 'journal_club';

/** A single entry in the narrative arc (slide plan from Pass 1). */
export interface NarrativeArcEntry {
  slide_number: number;
  title: string;
  element_ids: string[];   // refs to ExtractedFigure.id (e.g. "ef_1")
  purpose: string;         // one-line description of what this slide accomplishes
}

/** Pending presentation plan — bridges Pass 1 and Pass 2 for Author/Journal Club modes. */
export interface PresentationPlan {
  mode: PresentationMode;
  narrative_arc: NarrativeArcEntry[];
  paper_summary: string;
  figures: ExtractedFigure[];  // cropped figures from Pass 1
  userText: string;            // original user request (needed for Pass 2)
}

export type SlideLayout = 'figure_only' | 'figure_focus' | 'balanced' | 'text_only';

export interface Slide {
  title: string;
  content?: string[];
  figure?: Figure;
  originalFigure?: Figure;            // Backup of original figure before AI image replacement
  originalSpeakerNotes?: string;      // Backup of speaker notes before AI image replacement
  originalReferences?: string[];      // Backup of references before AI image replacement
  layout?: SlideLayout;
  speakerNotes?: string;
  references?: string[];  // Per-slide footnotes: references[0] = [1], references[1] = [2], etc.
}

export interface PresentationData {
  title: string;
  language?: string;  // ISO 639-1 code (e.g. "en", "tr")
  slides: Slide[];
}

export interface PresentationState {
  slides: Slide[];
  currentSlide: number;
  title: string;
  language: string;  // ISO 639-1, defaults to 'en'
  isPresenting: boolean;
  autoAdvance: boolean;
  speakerNotesVisible: boolean;
}

export interface SessionFileMeta {
  name: string;
  mediaType: string;
  size: number;
  storageKey: string;
  chunks: number;
}

export interface SessionTokenUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Session {
  id: string;
  title: string;
  selectedModel?: string;
  messages: Pick<Message, 'id' | 'sender' | 'text' | 'language'>[];
  filesMeta: SessionFileMeta[];
  presentation: {
    slides: Slide[];
    title: string;
    language: string;
    currentSlide: number;
  } | null;
  pdfViewer: {
    page: number;
    zoom: number;
  } | null;
  tokenUsage: SessionTokenUsage | null;
  assessment: SessionAssessment | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface MemoryNote {
  text: string;
  timestamp: string;
}

export type VoiceGender = 'female' | 'male' | 'neutral';
export type TTSEngine = 'browser' | 'gemini';

export interface VoiceConfig {
  pitch: number;
  rate: number;
  preferredVoice: string[];
}

export interface ModelCapabilities {
  vision: boolean;
  reasoning: boolean;
  tools: boolean;
  jsonOutput: boolean;
}

export type PricingTier = 'free' | 'budget' | 'standard' | 'premium';

export interface ModelPricing {
  promptPer1M: number;
  completionPer1M: number;
  tier: PricingTier;
}

export interface ModelOption {
  id: string;
  name: string;
  provider: string;
  contextLength: number;
  maxCompletionTokens: number;
  capabilities: ModelCapabilities;
  pricing: ModelPricing;
  recommended: boolean;
}

export interface ImageCatalogEntry {
  id: string;
  description: string;
  dataURL: string | null;
}

export interface ChatApiRequest {
  messages: Array<{
    role: 'system' | 'user' | 'assistant';
    content: string | Array<{ type: string; text?: string; image_url?: { url: string } }>;
  }>;
  model: string;
  max_tokens: number;
  system: string;
  timeout?: number;
  options?: {
    search?: boolean;
    thinking?: boolean;
    thinkingBudget?: number;
  };
}

export type ActiveTab = 'chat' | 'pdf' | 'slides';
export type SidebarTab = 'sessions' | 'memory';
