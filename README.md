# Docent — Your AI Presenter

**Docent** is an AI-powered presentation creation and delivery platform. Its AI agent **Sage** generates professional slide decks from natural language descriptions or uploaded academic papers, complete with SVG diagrams, narration, and export capabilities.

## Features

- **AI Slide Generation** — Describe a topic or upload a PDF, and Sage creates a full presentation with structured slides, SVG diagrams, and speaker notes
- **PDF Analysis** — Upload academic papers; Sage reads every page and creates presentations with precisely cropped figures and tables
- **SVG Diagrams** — AI-generated flowcharts, timelines, comparison tables, network diagrams, and more in a dark academic theme
- **Text-to-Speech Narration** — Sage narrates presentations with configurable voice (female, male, neutral) and auto-advance
- **Export** — Download as PPTX (PowerPoint) or HTML (print-to-PDF)
- **Session Management** — Save and restore conversations with full state (PDF, slides, chat history)
- **Memory System** — Sage remembers key insights across sessions
- **Multi-Model Support** — Choose from Claude, GPT-4o, Gemini, Llama, DeepSeek, and more via OpenRouter

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

## Architecture

```
src/
  app/            # Next.js App Router (layout, page, API route)
  components/     # React components (AppShell, ChatPanel, SlideViewer, etc.)
  hooks/          # Custom React hooks (useChat, usePresentation, usePDF, etc.)
  lib/            # Utilities (API client, storage, presentation parsing, export)
  types/          # TypeScript type definitions
```

**Tech Stack**: Next.js 14+, React 19, TypeScript, IndexedDB (idb-keyval), pdfjs-dist, pptxgenjs, recharts

## How It Works

1. **User Input** — Describe a topic or upload a PDF paper
2. **AI Generation** — Sage analyzes the content and generates a structured JSON presentation
3. **Rendering** — Slides are rendered with SVG diagrams, PDF figure crops, and styled layouts
4. **Delivery** — Navigate slides with keyboard, narrate with TTS, or export to PPTX/HTML

## License

MIT License. See [LICENSE](LICENSE) for details.

## Citation

If you use Docent in your research, please cite:

```bibtex
@article{docent2025,
  title={Docent: AI-Driven Presentation Generation and Delivery from Multimodal Sources},
  author={Symbiont-AI Cognitive Labs},
  year={2025},
  url={https://github.com/symbiont-ai/docent}
}
```

---

Built by [Symbiont-AI Cognitive Labs](https://github.com/symbiont-ai)
