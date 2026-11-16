/**
 * The Orca build of Plannotator: marks for the agents Orca runs as native chats that Plannotator draws no mark for,
 * so a `mark:<host>` face (an Orca chat drawn as the agent it runs) is never the neutral glyph.
 *
 * GitHub Copilot and OMP: from Orca (stablyai/orca src/renderer/src/components/agent/icons/agent-icon-glyphs.tsx),
 * MIT License, Copyright (c) 2026 Lovecast Inc. Ported as single-colour shapes.
 * Antigravity and Kimi: Orca ships these as raster images only, so they are drawn here as plain letters, like
 * Plannotator's own Grok Build and DeepSeek Harness glyphs.
 */
import type React from 'react';

/** Outline glyphs on a 24-unit grid, drawn as `ib-glyph` (stroked in the muted colour, as Plannotator's). */
const OUTLINE: Partial<Record<string, string>> = {
  antigravity: 'M4.5 20 12 4l7.5 16 M7.4 14h9.2',
  kimi: 'M7 4v16 M17.5 4 7 13.5 M10.6 10.3 17.5 20',
};

function Filled({ viewBox, children }: { viewBox: string; children: React.ReactNode }) {
  return (
    <svg viewBox={viewBox} aria-hidden="true" focusable="false" xmlns="http://www.w3.org/2000/svg">
      {children}
    </svg>
  );
}

/** The mark this module draws for a host, or null when it draws none (Plannotator's own marks come first). */
export function orcaExtraMark(host: string | null | undefined): React.ReactNode | null {
  if (!host) return null;
  const d = OUTLINE[host];
  if (d)
    return (
      <svg className="ib-glyph" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
        <path d={d} />
      </svg>
    );
  if (host === 'copilot')
    return (
      <Filled viewBox="0 0 16 16">
        <path
          fill="currentColor"
          d="M7.998 15.035c-4.562 0-7.873-2.914-7.998-3.749V9.338c.085-.628.677-1.686 1.588-2.065.013-.07.024-.143.036-.218.029-.183.06-.384.126-.612-.201-.508-.254-1.084-.254-1.656 0-.87.128-1.769.693-2.484.579-.733 1.494-1.124 2.724-1.261 1.206-.134 2.262.034 2.944.765.05.053.096.108.139.165.044-.057.094-.112.143-.165.682-.731 1.738-.899 2.944-.765 1.23.137 2.145.528 2.724 1.261.566.715.693 1.614.693 2.484 0 .572-.053 1.148-.254 1.656.066.228.098.429.126.612.012.076.024.148.037.218.924.385 1.522 1.471 1.591 2.095v1.872c0 .766-3.351 3.795-8.002 3.795Zm0-1.485c2.28 0 4.584-1.11 5.002-1.433V7.862l-.023-.116c-.49.21-1.075.291-1.727.291-1.146 0-2.059-.327-2.71-.991A3.222 3.222 0 0 1 8 6.303a3.24 3.24 0 0 1-.544.743c-.65.664-1.563.991-2.71.991-.652 0-1.236-.081-1.727-.291l-.023.116v4.255c.419.323 2.722 1.433 5.002 1.433ZM6.762 2.83c-.193-.206-.637-.413-1.682-.297-1.019.113-1.479.404-1.713.7-.247.312-.369.789-.369 1.554 0 .793.129 1.171.308 1.371.162.181.519.379 1.442.379.853 0 1.339-.235 1.638-.54.315-.322.527-.827.617-1.553.117-.935-.037-1.395-.241-1.614Zm4.155-.297c-1.044-.116-1.488.091-1.681.297-.204.219-.359.679-.242 1.614.091.726.303 1.231.618 1.553.299.305.784.54 1.638.54.922 0 1.28-.198 1.442-.379.179-.2.308-.578.308-1.371 0-.765-.123-1.242-.37-1.554-.233-.296-.693-.587-1.713-.7Z"
        />
        <path fill="currentColor" d="M6.25 9.037a.75.75 0 0 1 .75.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 .75-.75Zm4.25.75v1.501a.75.75 0 0 1-1.5 0V9.787a.75.75 0 0 1 1.5 0Z" />
      </Filled>
    );
  if (host === 'omp')
    return (
      <Filled viewBox="0 0 64 64">
        <path fill="#8a5cf6" d="M10 14h44v9H43v33h-9V23h-9v22h-9V23H10z" />
      </Filled>
    );
  return null;
}

/** Every Orca native-chat agent id and the `mark:<host>` face the Orca plugin gives its chats. */
export const ORCA_AGENT_MARKS: Readonly<Record<string, string>> = {
  claude: 'mark:claude-code',
  codex: 'mark:codex',
  pi: 'mark:pi',
  opencode: 'mark:opencode',
  opencode2: 'mark:opencode',
  cursor: 'mark:cursor',
  grok: 'mark:grok',
  antigravity: 'mark:antigravity',
  copilot: 'mark:copilot',
  kimi: 'mark:kimi',
  omp: 'mark:omp',
};
