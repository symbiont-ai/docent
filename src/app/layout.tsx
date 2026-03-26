import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Docent — Your AI Presenter',
  description: 'AI-powered presentation generation and delivery platform. Upload papers, describe topics, and let Sage create professional presentations with diagrams, narration, and export.',
  keywords: ['AI presenter', 'presentation generator', 'slides', 'PDF analysis', 'SVG diagrams', 'text-to-speech'],
  authors: [{ name: 'Symbiont-AI Cognitive Labs' }],
  openGraph: {
    title: 'Docent — Your AI Presenter',
    description: 'Generate professional presentations from papers, topics, or ideas using AI.',
    type: 'website',
  },
};

const themeScript = `
(function(){
  try {
    var t = localStorage.getItem('docent-theme') || 'dark';
    if (t === 'system') {
      t = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', t);
  } catch(e) {}
})();
`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1" />
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
