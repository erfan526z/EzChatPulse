/**
 * Theme + accent.
 *
 * The accent is stored per account as a tiny declarative string ("#rrggbb" or
 * "grad:<preset>") so nothing user-supplied ever reaches a style attribute: the
 * client maps a preset id to its CSS here. The light/dark choice is a per-device
 * preference, so it lives in localStorage.
 */

export interface AccentPreset {
  /** stable id — this is exactly what gets stored on the account */
  id: string;
  label: string;
  /** the solid colour: used directly, and as the gradient's fallback */
  css: string;
  gradient?: string;
  /** text colour that sits on top of the accent */
  on: string;
}

export const ACCENT_PRESETS: AccentPreset[] = [
  { id: '#34d399', label: 'Mint', css: '#34d399', on: '#04140c' },
  { id: '#7aa2ff', label: 'Blue', css: '#7aa2ff', on: '#061027' },
  { id: '#a78bfa', label: 'Violet', css: '#a78bfa', on: '#100a24' },
  { id: '#f0b46a', label: 'Amber', css: '#f0b46a', on: '#1d1204' },
  { id: '#fb7185', label: 'Rose', css: '#fb7185', on: '#26050c' },
  { id: 'grad:sunset', label: 'Sunset', css: '#f97316', gradient: 'linear-gradient(135deg, #f97316, #ef4444)', on: '#fff5ee' },
  { id: 'grad:ocean', label: 'Ocean', css: '#0ea5e9', gradient: 'linear-gradient(135deg, #22d3ee, #6366f1)', on: '#f0fbff' },
  { id: 'grad:aurora', label: 'Aurora', css: '#22c55e', gradient: 'linear-gradient(135deg, #34d399, #22d3ee)', on: '#04140c' },
  { id: 'grad:candy', label: 'Candy', css: '#ec4899', gradient: 'linear-gradient(135deg, #f472b6, #a78bfa)', on: '#26031a' },
];

const DEFAULT_ACCENT = ACCENT_PRESETS[0] as AccentPreset;
const THEME_KEY = 'chatpulse.theme';

export type Theme = 'dark' | 'light';

/** "#34d399" + 0.16 → "rgba(52, 211, 153, 0.16)" */
function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  if (h.length !== 6) return `rgba(52, 211, 153, ${alpha})`;
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/** Resolve a stored accent id to a preset (falls back to the default). */
export function accentPreset(id: string | null | undefined): AccentPreset {
  if (!id) return DEFAULT_ACCENT;
  const known = ACCENT_PRESETS.find((p) => p.id === id);
  if (known) return known;
  // a custom hex the palette does not list still applies as a solid colour
  if (/^#[0-9a-fA-F]{6}$/.test(id)) {
    return { id, label: 'Custom', css: id, on: '#04140c' };
  }
  return DEFAULT_ACCENT;
}

/** Push an accent into the token layer. Every component reads --accent*. */
export function applyAccent(id: string | null | undefined): void {
  const preset = accentPreset(id);
  const root = document.documentElement;
  root.style.setProperty('--accent', preset.css);
  root.style.setProperty('--accent-press', preset.css);
  root.style.setProperty('--accent-soft', withAlpha(preset.gradient ? preset.css : preset.css, 0.16));
  root.style.setProperty('--accent-image', preset.gradient ?? 'none');
  root.style.setProperty('--text-on-accent', preset.on);
}

export function currentTheme(): Theme {
  return localStorage.getItem(THEME_KEY) === 'light' ? 'light' : 'dark';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem(THEME_KEY, theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#eef1f7' : '#0b0e1a');
}

/** Called once at startup, before anything is painted. */
export function initTheme(): void {
  applyTheme(currentTheme());
  applyAccent(null);
}
