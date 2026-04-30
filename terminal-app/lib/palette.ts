/**
 * Shared app palette. Warm dark base with pastel accents — used across Hosts,
 * connection detail (Active Agents), and termloop reply. Intentionally avoids
 * pure #000 or saturated iOS system colors.
 */
export const palette = {
  // Surfaces
  bg: '#14121a',
  bgSoft: '#1a1822',
  card: 'rgba(255,255,255,0.05)',
  cardHi: 'rgba(255,255,255,0.07)',
  border: 'rgba(255,255,255,0.08)',
  divider: 'rgba(255,255,255,0.06)',

  // Ink
  ink1: '#eeecf3',
  ink2: '#a29fae',
  ink3: '#6b6878',
  ink4: '#44414c',

  // Pastel accents
  blue: '#b8ccff',        // user prompts, live indicators
  blueSoft: 'rgba(184,204,255,0.14)',
  mint: '#9fe5c8',        // connected / completed / success
  mintSoft: 'rgba(159,229,200,0.15)',
  amber: '#ffd08a',       // running
  amberSoft: 'rgba(255,208,138,0.15)',
  rose: '#ffb5c5',        // needs input / attention
  roseSoft: 'rgba(255,181,197,0.15)',
  peach: '#ffc4a3',       // system / warnings
  peachSoft: 'rgba(255,196,163,0.12)',
  lilac: '#d5c3ff',       // secondary accent

  // On-accent ink (text on solid accent backgrounds)
  onAccent: '#1b1624',
} as const;
