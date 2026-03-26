# Docent — Human-AI Symbiotic Loop from Research to Understanding

<p align="center">
  <img src="https://github.com/symbiont-ai/docent/releases/download/v1.0.0/demo-hires.gif" alt="Docent Demo — From PDF to Narrated Presentation to Assessment" width="800">
  <br>
  <a href="https://www.youtube.com/watch?v=jfRvhzEwCqY&list=PL-S7LfHfYqcfcV0CEtRyz_5IzC--QH6KG&index=2">📺 Watch the full demo on YouTube</a>
</p>

**Docent** is an open-source, browser-based platform that connects document understanding, research curation, and educational delivery into a single conversational pipeline. Its AI persona **Sage** engages users in a *symbiotic loop* — an iterative cycle of bidirectional questioning between human and AI — spanning the full arc from research to learning.

Given a research paper, technical report, or free-form topic, Sage curates knowledge through vision-based document analysis and web-grounded research, synthesizes structured slide presentations with custom SVG diagrams and extracted figures, delivers narrated lectures, and supports post-presentation Q&A for comprehension reinforcement.

## The Symbiotic Loop

Docent treats the research-to-learning pipeline not as a batch process but as an interactive dialogue across five stages:

1. **Research & Comprehension** — Vision-based PDF analysis (every page rendered as high-res image for LLM context) or web search curation with optional deep thinking / extended reasoning
2. **Structured Synthesis** — Slide presentations with custom SVG diagrams, precisely cropped PDF figures, configurable layouts, and speaker notes — streamed incrementally as the LLM generates them
3. **Narrated Delivery** — Dual TTS pipeline (browser-native Web Speech API + optional Google Gemini neural TTS) with cross-slide prefetch buffering and auto-advance
4. **Conversational Refinement** — Users shape presentations through iterative dialogue, editing plans, adjusting content, and requesting changes
5. **Interactive Assessment** — Bidirectional Q&A where Sage probes understanding and users ask questions, propose corrections, or debate interpretations

Two governance concerns are asymmetrically assigned: **hallucination prevention** is the AI's structural responsibility (ensuring content fidelity before delivery), while **assessment of understanding** is the AI's pedagogical role (verifying that learning has occurred).

## Key Features

### Interaction & Research
- **Conversational refinement** — Edit and reshape presentations through natural dialogue
- **Web search** — Sage curates knowledge from current web sources
- **Deep thinking / extended reasoning** — Allocate up to 40,000 reasoning tokens for complex analysis
- **Post-generation Q&A** — Ask Sage anything about the presented content, grounded in full slide context

### Content Generation
- **Custom SVG diagrams** — 10 diagram types: flowcharts, timelines, comparison tables, network diagrams, layered architecture, Venn/overlap, bar charts, annotated schematics, matrix/heatmap, and cycle diagrams
- **Vision-guided PDF figure extraction** — LLM-predicted normalized bounding-box coordinates with automatic whitespace trimming
- **AI image generation** — Generate images via Gemini/Nano Banana through OpenRouter
- **Real photo search** — Find and embed relevant photographs

### Architecture & Flexibility
- **Multi-model BYOK** — Bring your own key: Claude Sonnet 4, GPT-4o, Gemini 2.5 Flash, Llama 3.3, DeepSeek V3, Qwen 2.5, and more via OpenRouter
- **Streaming generation** — First slide appears within seconds; slides render incrementally as the LLM produces them
- **Browser-only / zero install** — Runs entirely in the browser; deploy on Vercel or run locally
- **Multi-language** — Generate presentations and narration in any language
- **Open source** — MIT License

### Presentation & Delivery
- **Speaker notes + dual TTS** — Browser-native (free) and Google Gemini neural quality narration
- **PPTX export** — Download as PowerPoint
- **HTML export** — Print-to-PDF or standalone HTML
- **Session management** — Save and restore conversations with full state (PDF, slides, chat history, narrative arc)
- **Memory system** — Sage remembers key insights across sessions via `[NOTE:]` tags

## Quick Start

### Prerequisites

- Node.js 18+
- An [OpenRouter](https://openrouter.ai/) API key

### Installation

```bash
git clone https://github.com/symbiont-ai/docent.git
cd docent
npm install
```

### Development

```bash
npm run dev
```

Open [http://localhost:3000](http://localhost:3000) and enter your OpenRouter API key in Settings.

### Production Build

```bash
npm run build
npm start
```

## Deploy on Vercel

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/symbiont-ai/docent)

Optionally set `OPENROUTER_API_KEY` as an environment variable for a shared hosted instance.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OPENROUTER_API_KEY` | No | Default API key for the hosted instance. Users can also enter their own key in Settings. |
| `GOOGLE_API_KEY` | No | Google API key for Gemini neural TTS (optional; users can enter their own in Settings). |

## Technology Stack

| Component | Technology | Purpose |
|-----------|-----------|---------|
| Framework | Next.js / React 19 | Application shell, routing, API routes |
| Language | TypeScript | Type-safe development |
| PDF Processing | pdfjs-dist | PDF parsing, rendering, figure cropping |
| PPTX Export | PptxGenJS | PowerPoint file generation |
| Storage | idb-keyval / IndexedDB | Browser-local session persistence |
| Charts | Recharts | Optional data visualization |
| Speech (free) | Web Speech API | Browser-native TTS narration |
| Speech (neural) | Google Gemini API | High-quality neural TTS |
| LLM Gateway | OpenRouter API | Multi-model LLM access |

## Architecture

```
src/
  app/            # Next.js App Router (layout, page, API routes)
  components/     # React components (AppShell, ChatPanel, SlideViewer, etc.)
  hooks/          # Custom React hooks (useChat, usePresentation, usePDF, useTTS, useSessions, useMemory)
  lib/            # Utilities (API client, storage, presentation parsing, figure extraction, export)
  types/          # TypeScript type definitions
```

Six React hooks compose the client-side state:

| Hook | Responsibility |
|------|---------------|
| `useChat` | Message flow, file uploads, API calls, generation coordinator |
| `usePresentation` | Slide state, navigation, figure resolution |
| `usePDF` | PDF loading, page rendering, thumbnails, figure cropping |
| `useTTS` | Dual speech synthesis, voice selection, chunked playback, prefetch buffering |
| `useMemory` | Cross-session notes via `[NOTE:]` tags |
| `useSessions` | Complete session serialization to/from IndexedDB |

## Acknowledgments

Poster generation feature inspired by [posterskill](https://github.com/ethanweber/posterskill).

## License

MIT License. See [LICENSE](LICENSE) for details.

## Citation

If you use Docent in your research, please cite:

```bibtex
@article{docent2026,
  title={Docent: Human--AI Symbiotic Loop from Research to Understanding},
  author={Symbiont-AI Cognitive Labs},
  year={2026},
  url={https://github.com/symbiont-ai/docent}
}
```

---

Built by [Symbiont-AI Cognitive Labs](https://github.com/symbiont-ai)
