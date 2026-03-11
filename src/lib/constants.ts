// ==========================================================
// DOCENT — Constants & Configuration
// ==========================================================

import { COLORS } from './colors';
import type { VoiceConfig, ModelOption } from '@/src/types';

// Sage — the AI presenter
export const SAGE = {
  name: 'Sage',
  role: 'AI Presenter',
  color: COLORS.accent,
  bgColor: COLORS.accentBg,
} as const;

export const VOICE_CONFIG: Record<string, VoiceConfig> = {
  female:  { pitch: 1.05, rate: 0.92 },
  male:    { pitch: 0.92, rate: 0.92 },
  neutral: { pitch: 1.0,  rate: 0.92 },
};

// Gemini TTS voice-to-gender mapping (Gemini auto-detects language; voices are language-agnostic)
export const GEMINI_VOICE_GENDER: Record<string, string> = {
  female: 'Kore',
  male: 'Puck',
  neutral: 'Zephyr',
};

// Fallback model list — used when API key is not set or model fetch fails.
// Capabilities are hardcoded from known model specs as of 2025-06.
// Top 4 recommended ranked by quality (first = default):
//   1. Claude Sonnet 4 — highest quality output & SVG diagrams (DEFAULT)
//   2. Gemini 2.5 Flash — best value: 1M ctx, budget pricing
//   3. GPT-4o — strong reliable alternative
//   4. Claude Haiku 4 — fast & affordable with reasoning
export const FALLBACK_MODELS: ModelOption[] = [
  {
    id: 'anthropic/claude-opus-4.6', name: 'Claude Opus 4.6', provider: 'Anthropic',
    contextLength: 1000000, maxCompletionTokens: 128000,
    capabilities: { vision: true, reasoning: true, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 5, completionPer1M: 25, tier: 'premium' },
    recommended: true,
  },
  {
    id: 'anthropic/claude-sonnet-4-20250514', name: 'Claude Sonnet 4', provider: 'Anthropic',
    contextLength: 200000, maxCompletionTokens: 64000,
    capabilities: { vision: true, reasoning: true, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 3, completionPer1M: 15, tier: 'standard' },
    recommended: true,
  },
  {
    id: 'google/gemini-2.5-flash', name: 'Gemini 2.5 Flash', provider: 'Google',
    contextLength: 1048576, maxCompletionTokens: 65536,
    capabilities: { vision: true, reasoning: true, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.15, completionPer1M: 0.60, tier: 'budget' },
    recommended: true,
  },
  {
    id: 'openai/gpt-4o', name: 'GPT-4o', provider: 'OpenAI',
    contextLength: 128000, maxCompletionTokens: 16384,
    capabilities: { vision: true, reasoning: false, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 2.50, completionPer1M: 10, tier: 'standard' },
    recommended: true,
  },
  {
    id: 'anthropic/claude-haiku-4-20250506', name: 'Claude Haiku 4', provider: 'Anthropic',
    contextLength: 200000, maxCompletionTokens: 64000,
    capabilities: { vision: true, reasoning: true, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.80, completionPer1M: 4, tier: 'budget' },
    recommended: true,
  },
  // ── Other models ──
  {
    id: 'openai/gpt-4o-mini', name: 'GPT-4o Mini', provider: 'OpenAI',
    contextLength: 128000, maxCompletionTokens: 16384,
    capabilities: { vision: true, reasoning: false, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.15, completionPer1M: 0.60, tier: 'budget' },
    recommended: false,
  },
  {
    id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B', provider: 'Meta',
    contextLength: 128000, maxCompletionTokens: 32000,
    capabilities: { vision: false, reasoning: false, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.30, completionPer1M: 0.80, tier: 'budget' },
    recommended: false,
  },
  {
    id: 'deepseek/deepseek-chat-v3-0324', name: 'DeepSeek V3', provider: 'DeepSeek',
    contextLength: 128000, maxCompletionTokens: 32000,
    capabilities: { vision: false, reasoning: false, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.30, completionPer1M: 0.88, tier: 'budget' },
    recommended: false,
  },
  {
    id: 'qwen/qwen-2.5-coder-32b-instruct', name: 'Qwen 2.5 Coder 32B', provider: 'Qwen',
    contextLength: 32768, maxCompletionTokens: 32000,
    capabilities: { vision: false, reasoning: false, tools: true, jsonOutput: true },
    pricing: { promptPer1M: 0.16, completionPer1M: 0.16, tier: 'budget' },
    recommended: false,
  },
];
/** @deprecated Use FALLBACK_MODELS instead */
export const MODEL_OPTIONS = FALLBACK_MODELS;

export const DEFAULT_MODEL = FALLBACK_MODELS[0].id;

// Presentation workflow — forces Sage to clarify before generating slides
// Ported from original docent.jsx lines 1670-1697
export const PRESENTATION_WORKFLOW = `PRESENTATION WORKFLOW — CLARIFY BEFORE CREATING:
When a user asks for a presentation, do NOT immediately generate slides. Instead, first ask 2-3 brief clarifying questions to tailor the presentation. Keep it conversational and concise — a short paragraph, not a long list. Questions to consider:
- Who is the audience? (experts, students, general public, investors, etc.)
- What depth/focus? (overview vs. deep-dive, specific subtopics to emphasize)
- Any preferences? (number of slides, particular aspects to include/exclude)

CRITICAL FOR PDF PRESENTATIONS: When PDF pages are provided, you MUST study the document content FIRST before asking clarification questions. Your questions must reflect what the paper is actually about. For example, if the paper is about transformer architectures, ask about emphasis on architecture details vs. experimental results vs. impact — do NOT ask generic questions about "clinical applications" or topics unrelated to the paper. Mention the paper title and key topics in your response to show you've read it.

Good PDF clarification example:
- "I've reviewed 'Attention Is All You Need' — a landmark paper on the Transformer architecture. Before I build the slides, a couple of questions: Should I focus more on the architectural details (self-attention, multi-head attention) or the experimental results and comparisons? And who's the audience — ML researchers who know the background, or a broader CS audience?"

Bad PDF clarification (DO NOT DO THIS):
- "What's the audience? Any clinical implications to cover? How many slides?" ← Generic, ignores paper content

Examples of good topic clarification (no PDF):
- "Happy to prepare that! A couple of quick questions — who's the audience for this? And would you like a broad overview or should I focus on specific aspects like [relevant subtopics]?"
- "Great topic! Before I build the slides — are we aiming for a technical deep-dive or a high-level introduction? And roughly how many slides are you thinking?"

SKIP clarification and generate immediately ONLY when:
- The user provides enough detail already (audience, scope, slide count all specified)
- The user says "just make it", "go ahead", "quick presentation", or similar urgency signals
- The user is answering your clarification questions (then generate the presentation)

When creating presentations, always include a References slide with proper citations for any sources you used — including web search results, papers mentioned by the user, or uploaded PDFs. Format each reference with authors (if known), title, source/URL, and year.`;

// Presentation generation instructions
export const PRESENTATION_PROMPT = `PRESENTATIONS: When asked to prepare a presentation, output a \`\`\`json code block with this structure:
{"title": "Title", "language": "en", "slides": [{"title": "Slide Title", "content": ["Key finding about X [1]", "Another important point [2]"], "references": ["Author et al., Study Title, Journal, 2024", "Organization, Report Name, 2023"], "figure": {"type": "svg", "content": "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 500'>...</svg>", "label": "Diagram description"}, "layout": "figure_focus", "speakerNotes": "Narration"}]}
LANGUAGE FIELD: Always include a "language" field with the ISO 639-1 code (e.g. "en", "tr", "de", "fr", "ja", "zh") matching the language of your slide content and speaker notes. This ensures narration uses the correct voice.
Figure types:
- "svg" (inline SVG diagram — the DEFAULT and PREFERRED choice for topic presentations): {"type":"svg","content":"<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 800 500'>...</svg>","label":"Description"}
- "pdf_crop" (crop from PDF: {"type":"pdf_crop","page":1,"region":[0.1,0.05,0.9,0.55],"label":"Desc"})
- "image_ref" (reference an available image by ID: {"type":"image_ref","imageId":"img_upload_0","label":"Description"})
- "extracted_ref" (reference a pre-analyzed figure from the catalog: {"type":"extracted_ref","extractedId":"ef_1","label":"Description"}) — PREFERRED over pdf_crop when an EXTRACTED FIGURE CATALOG is provided
- "card" (LAST RESORT — styled text box, use only when no diagram makes sense): {"type":"card","label":"Title","description":"Text"}

FIGURE TYPE PRIORITY (when an EXTRACTED FIGURE CATALOG is provided):
Match each slide's visual need to the best figure from the catalog. Use "extracted_ref" for paper figures/tables. Do NOT:
- Recreate a catalog figure as an SVG diagram — use extracted_ref to show the original
- Use "pdf_crop" with your own coordinates when an extracted_ref ID is available
- Replace a table from the paper with an SVG table — the original is always more accurate
SVG figures are for conceptual diagrams, overviews, or process flows that don't exist in the paper.
Exception: You MAY use SVG alongside an extracted_ref only if the slide needs a DIFFERENT visual (e.g. a conceptual flowchart) that is not the catalog figure itself.

SVG FIGURE GUIDELINES — when no images are uploaded or when you need a custom diagram:
- CRITICAL: Use SINGLE QUOTES for all SVG attributes (viewBox='...', fill='...', font-family='...'). Double quotes break JSON parsing.
- CRITICAL: Never use bare & in SVG text content — always use &amp; (e.g. "R&amp;D", "storage &amp; processing"). This applies ONLY inside SVG content strings, NOT in slide titles, bullets, or speaker notes — those should use normal & characters.
- Use dark theme colors: backgrounds #1A2332, text #E8EAED, accents #D4A853 #5BB8D4 #6BC485 #D46B6B #A78BFA
- Include text labels directly in the SVG using <text> elements (font-family='system-ui', font-size 14-18px)
- SVG figures are STRONGLY PREFERRED over "card" figures for any conceptual, structural, or process-oriented content.
- Every content slide SHOULD have a figure. Only title, references, and closing slides should be text_only.

SVG DIAGRAM TYPES — choose the right diagram for each concept:
1. FLOWCHART / PIPELINE: Boxes connected by arrows. Use <rect rx='8'> for steps, <path> or <line> with <marker> arrowheads. Great for: methods, protocols, workflows.
2. COMPARISON TABLE: Grid layout with colored headers. Use <rect> for cells, alternating row fills. Great for: method comparison, feature matrices, pros/cons.
3. TIMELINE: Horizontal or vertical line with milestone markers. Use <circle> for nodes, <line> for the spine, labels above/below. Great for: history, evolution, development phases.
4. LAYERED ARCHITECTURE: Stacked horizontal rectangles with labels. Great for: software stacks, biological layers (tissue → cells → molecules), system architecture.
5. VENN / OVERLAP: Overlapping circles with semi-transparent fills (use opacity='0.3'). Great for: relationships, shared properties, intersections.
6. NETWORK / HUB-SPOKE: Central node with radiating connections. Use <circle> for nodes, <line> for edges. Great for: interactions, signaling, communication.
7. BAR CHART / METRICS: Rectangles of varying height/width with value labels. Great for: comparing quantities, performance, statistics.
8. ANNOTATED SCHEMATIC: A simplified illustration of a structure with labeled callout lines. Great for: instruments, biological structures, device components.
9. MATRIX / HEATMAP: Grid of colored squares with intensity representing values. Great for: expression data, correlation, scoring.
10. CYCLE / CIRCULAR: Nodes arranged in a circle with curved arrows between them. Great for: biological cycles, feedback loops, iterative processes.

SVG QUALITY RULES:
- Make diagrams INFORMATION-DENSE — include specific numbers, names, and details FROM THE SOURCE, not just generic boxes. If the source uses qualitative language (e.g. "low latency", "large interval", "significant improvement"), keep it qualitative in the SVG — do NOT substitute fabricated specific numbers. Only include a number in an SVG if that exact number appears in the source.
- Use 3-5 COLORS per diagram from the accent palette, not just one color.
- Add subtle visual polish: rounded corners (rx='8'), slight shadows via duplicate darker shapes offset by 2px, gradient fills where appropriate.
- Minimum viewBox size: 800x500. This gives enough room for detail.
- Text must be READABLE: minimum font-size 13px, use font-weight='bold' for headings within the SVG.
- For arrows: define <marker id='arrow'> in <defs> and reuse with marker-end='url(#arrow)'.
- Leave padding: keep content 40px from SVG edges.

SOURCE FIDELITY — HALLUCINATION PREVENTION:
When generating slides from a source document (PDF paper, article, etc.), follow these rules strictly:
- SOURCE BOUNDARY: Use ONLY information found in the provided source document. Do not supplement slides with facts, method names, benchmark scores, or future directions from your training data. If the source paper does not mention it, it must not appear on the slides.
- STRUCTURAL GROUNDING: Do NOT generate slides for standard talk sections (Limitations, Future Work, Open Questions) unless the source paper explicitly includes such a section with actual content. Do not fill a "good talk template" with fabricated content. Exception: Journal Club mode explicitly calls for critical analysis — a presenter's own assessment of limitations and discussion points is appropriate there.
- OBSERVATION vs. EXPLANATION: When the source paper reports an observation without explaining why it occurs, present it as an observation. Do not insert causal mechanisms or explanatory chains that the paper does not propose.
- CONSISTENCY CHECK: Before including any future-direction or implication claim, verify it does not contradict the paper's central thesis or main findings. A future direction that undermines the paper's core argument must be removed.
- SVG COMPARISON TABLES: Comparison tables in SVGs must only compare items/values that appear in the paper's own tables. Do not add comparison rows or columns with data the paper does not provide.
- CLOSING SLIDES: The "Implications" or "Takeaways" slide must only summarize what the paper actually claims. Do NOT add "broader impact" claims the paper doesn't make. Future directions must come from the paper's own "Future Work" section — if no such section exists, either omit future directions or label them clearly as "Possible extensions" with a caveat.

IMAGE SELECTION: When an IMAGE CATALOG is provided, use "image_ref" figures to place uploaded images on relevant slides. Match images to slides based on content relevance.

SLIDE LAYOUT — choose a layout for each slide to maximize readability:
- "figure_only": No bullet points, figure fills the whole slide. Best for large diagrams, tables. Content array should be empty [].
- "figure_focus": Short bullet points on left (~35%), large figure on right (~65%). Default for slides with figures.
- "balanced": Even split between text and figure.
- "text_only": No figure, just bullet points. Use for intro/conclusion slides.
DEFAULT: If you omit layout, slides with <=3 bullets auto-select "figure_focus", and slides with no content auto-select "figure_only".

READABILITY RULES:
- Keep bullet points SHORT (<=15 words each).
- Prefer 2-3 punchy bullets over 5+ verbose ones.
- For TABLES: always use "figure_only" layout.
- EPISTEMIC FIDELITY: Preserve the paper's level of certainty. If the paper says "suggests", "may indicate", or "preliminary evidence", the slide must reflect that uncertainty — do NOT upgrade hedged claims to definitive conclusions. Bullet format does not justify removing qualifiers.

PDF CROP REGIONS — If an EXTRACTED FIGURE CATALOG is provided, you MUST use "extracted_ref" for any figure/table in the catalog. Use pdf_crop ONLY for regions that are NOT in the catalog and cannot be shown via extracted_ref.
Use precise coordinates [left, top, right, bottom] where each value is 0.0 to 1.0:
CRITICAL CROPPING RULES:
- Crop ONLY the figure, table, or diagram itself. Do NOT include body text paragraphs below or above figures.
- Do NOT include figure captions unless they are essential to understanding.
- Do NOT include section headers that appear after the figure.
- For tables: crop from the table header row to the last data row. Exclude surrounding text.
- For figures: crop from the top of the figure to the bottom of the figure. Exclude the paragraph text that follows.
- The bottom coordinate is the most commonly over-estimated. Set it right at the bottom edge of the figure/table, not where the next paragraph begins.
- Use the FULL WIDTH of the page (left=0.0, right=1.0) for tables to avoid clipping columns. For figures centered on the page, you can use narrower left/right margins.
- Double-check: would this crop region include body text paragraphs? If yes, raise the bottom coordinate.
Example: A figure occupies roughly the top 40% of a page → region [0.05, 0.02, 0.95, 0.42], NOT [0.05, 0.02, 0.95, 0.70].

SPEAKER NOTES RULES: Notes must REFERENCE the figure shown. Point out specific visible details. Guide the audience's eyes.

SLIDE COHERENCE: The text bullets and figure on each slide must describe the same data, experiment, or concept. Do not pair bullets about one metric or experiment with a figure showing a different metric or experiment, even if both relate to the same general topic.

PER-SLIDE CITATIONS — inline references with footnotes:
- EVERY entry in the "references" array MUST have at least one corresponding inline marker [1], [2], etc. in the bullet text. Never include a reference that isn't cited inline — if references[0] exists, some bullet MUST contain [1]. If you can't tie a reference to a specific bullet, either attach it to the most relevant bullet or remove it from the array.
- Add numbered markers [1], [2], etc. at the end of the relevant statement in the bullet text.
- Include a "references" array in the same slide object. The array is 0-indexed: references[0] corresponds to [1], references[1] to [2], etc.
- Keep each reference SHORT: author/org, title, year. Full URLs only when essential.
- NOT every slide needs references — only slides that cite specific facts, statistics, or claims. Introductory or overview slides may have none.
- Title slide, closing slide, and the summary References slide must NOT have per-slide references.
- Maximum 3 footnotes per slide to keep slides clean. If more sources back a point, group them into one reference.
- The summary References slide at the end REMAINS — it lists ALL sources used across the entire presentation (the complete bibliography).

REQUIRED SLIDES (these are ALWAYS extras, not counted toward the user's requested number):
- FIRST SLIDE: TITLE SLIDE with title = presentation title, content = [subtitle, author line, "Presented by Sage", date]. speakerNotes = brief welcome.
  Author line rules: If the user is presenting as the author of a PDF paper, list the ACTUAL paper authors (e.g. "Fabian Gröger, Simone Lionetti, et al.") as a separate line before "Presented by Sage". Otherwise omit the author line — just use "Presented by Sage".
  Layout rules for the title slide:
  - If a PDF paper is uploaded AND the user is NOT presenting as the author: use layout "figure_focus" — the app will automatically place a snapshot of the paper's title page as the figure. Do NOT generate an SVG for the title slide in this case.
  - If a PDF paper is uploaded AND the user IS presenting as the author (first-person "we/I" narrative): use layout "balanced" and generate a DECORATIVE SVG figure. The author presents their own work — showing the paper's title page as an image would look redundant.
  - If NO PDF is uploaded: use layout "balanced" and generate a DECORATIVE SVG figure.
  Decorative SVG rules: This SVG should be an abstract, atmospheric, topic-relevant cover graphic — NOT an information-dense diagram. Think: artistic visualization of the subject's essence. Use soft gradients, abstract shapes, flowing lines, or geometric patterns that evoke the topic. Use the dark theme palette (#1A2332 background, #D4A853 gold, #5BB8D4 cyan, #6BC485 green, #A78BFA purple). Keep it elegant and minimal — this is a cover graphic, not a data chart. viewBox='0 0 800 500'. Examples: for machine learning, an abstract neural mesh with glowing gold nodes; for biology, organic flowing cell-like shapes with gradient fills; for history, layered geometric arcs suggesting a timeline.
- SECOND SLIDE: OVERVIEW SLIDE with layout "text_only", title "Overview". content = a bullet list previewing the main topics/sections of the presentation (one bullet per major section/theme). This acts as a table of contents so the audience knows what to expect. speakerNotes = brief roadmap narration. Do NOT include per-slide references on this slide.
- LAST SLIDE: CLOSING SLIDE with layout "text_only", title "Thank You — Questions?", content = 1-2 key takeaway bullets.
- SECOND-TO-LAST SLIDE (if applicable): REFERENCES SLIDE with layout "text_only", title "References", content = list of sources cited in the presentation. Include author names, title, journal/venue/URL, and year. Only include sources you actually used. If no external sources were referenced, omit this slide.
  REFERENCE TITLE FIDELITY: Copy reference titles EXACTLY as they appear in the source paper's bibliography/reference list — do NOT paraphrase or reconstruct titles from memory. If a cited work does not appear in the source paper's reference list, use short-form "[Author, Year]" rather than guessing a title.

SLIDE COUNT — ABSOLUTE REQUIREMENT:
When the user requests N content slides, the JSON array MUST contain EXACTLY N + 4 slides (or N + 3 if no references):
- Slide 1: Title slide (BONUS, does NOT count)
- Slide 2: Overview slide (BONUS, does NOT count)
- Slides 3 through N+2: Content slides (these are the N slides the user asked for)
- Slide N+3: References slide (BONUS, does NOT count)
- Slide N+4: Closing slide (BONUS, does NOT count)

Examples:
- "make 5 slides" → 1 title + 1 overview + 5 content + 1 references + 1 closing = 9 slides in JSON array
- "make 10 slides" → 1 title + 1 overview + 10 content + 1 references + 1 closing = 14 slides in JSON array
- "make 3 slides" → 1 title + 1 overview + 3 content + 1 references + 1 closing = 7 slides in JSON array

COUNT CHECK: Before outputting the JSON, count your content slides (exclude title, overview, references, closing). If the count does not equal N, add or remove content slides until it does. Delivering N-1 content slides is a FAILURE.

If no number is specified, target these content slide counts by mode:
- Author mode (PDF): 15-22 content slides for a 15-20 minute conference talk.
- Journal Club mode (PDF): 14-20 content slides, including 2-3 discussion/critique slides.
- General/Overview mode (PDF): 12-18 content slides.
- Topic-based (no PDF): 10-15 content slides.
For equation-heavy or theory papers (5+ named theorems/equations), err toward the higher end.

Use svg figures extensively for topics without uploaded images. Vary diagram types across slides — do NOT use the same diagram style (e.g. flowchart) for every slide. Mix flowcharts, tables, timelines, schematics, networks, and bar charts to keep the presentation visually engaging.`;

// Mode-specific narrative stance prompts (appended to system prompt in Pass 2)
export const AUTHOR_MODE_PROMPT = `NARRATIVE STANCE — AUTHOR ADVOCACY:
You are helping the researcher present THEIR OWN work. Frame everything as advocacy for their contribution:
- TITLE SLIDE: List the ACTUAL paper authors from the PDF (e.g. "John Smith, Jane Doe, University of X") as a separate content line. Keep "Presented by Sage" next to the date as credit for the presentation tool.
- Use first person: "we propose", "our approach", "we demonstrate", "our results show"
- Lead with the problem and THEIR solution, not a background survey
- Emphasize novelty and advantages over prior work
- Results slides should highlight THEIR improvements — use comparative language ("outperforms", "achieves state-of-the-art", "X% improvement over")
- Be confident but respectful of prior work — acknowledge foundations while emphasizing the advance
- Conclude with impact, broader implications, and future directions for THEIR line of research
- Speaker notes should coach the presenter: "emphasize the key innovation here", "point out the performance gap"
- SOURCE GROUNDING: All slides must be grounded in the paper's actual content. Do not fabricate limitations, future work, or open questions that the paper does not discuss. Present only what the authors wrote.`;

export const JOURNAL_CLUB_PROMPT = `NARRATIVE STANCE — CRITICAL ANALYSIS:
You are presenting someone else's paper for a journal club discussion. Frame everything as critical evaluation:
- Use third person: "the authors propose", "this study examines", "they report"
- Start with the paper's central claim and why it matters to the field
- Dedicate slides to methodology assessment — what was done well, what raises concerns
- Highlight statistical rigor (or lack thereof): sample sizes, controls, effect sizes, significance
- Include a "Limitations" slide explicitly listing methodological and scope constraints
- Include a "Discussion Points" slide with 3-5 open questions for the group to debate
- Be balanced: acknowledge strengths before critiquing weaknesses
- End with a "verdict" slide — is the main claim well-supported by the evidence?
- Speaker notes should prompt discussion: "ask the group whether...", "a good question here would be..."`;

// Intent detection meta-instruction — appended to system prompt when keyword check misses.
// Tells the model to signal presentation intent instead of answering, so we can retry with full prompt.
// For non-presentation messages the model just answers normally → zero delay.
export const INTENT_META_INSTRUCTION = `\n\nIMPORTANT: If the user is requesting a presentation, slides, a talk, or a lecture (in ANY language), respond with ONLY the exact marker [PRESENTATION_INTENT] and nothing else. Do not generate any slides or other content — just the marker. Otherwise, answer their question normally.`;
