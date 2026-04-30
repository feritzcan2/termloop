export const colors = {
  bg: '#07080b',
  bgInk: '#0b0d12',
  bgElev: '#0f1218',
  line: 'rgba(255,255,255,0.055)',
  lineStrong: 'rgba(255,255,255,0.12)',
  ink1: '#e6e7ea',
  ink2: '#a8acb6',
  ink3: '#6b707d',
  ink4: '#434752',

  cyan: '#7de3ff',
  cyanHot: '#22d3ee',

  sel: '#3d6dff',
  selEdge: '#7aa0ff',
  selGlow: 'rgba(61,109,255,0.55)',
  selFillEnd: 'rgba(61,109,255,0.88)',

  phos: '#6af29a',
  amber: '#ffb454',
  rose: '#ff6b8a',
  violet: '#b794ff',

  white: '#ffffff',
  onSelDim: '#c7dcff',
  onSelWarm: '#ffe0b3',
} as const;

export const font = {
  mono: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
  monoSemi: 'JetBrainsMono_600SemiBold',
  monoBold: 'JetBrainsMono_700Bold',
} as const;

export const type = {
  tabLabel: { fontFamily: font.monoSemi, fontSize: 10.5, letterSpacing: 2.8 },
  workspaceName: { fontFamily: font.monoSemi, fontSize: 11, letterSpacing: 3.2 },
  epicName: { fontFamily: font.monoSemi, fontSize: 11.5, letterSpacing: 2.4 },
  epicCount: { fontFamily: font.monoMedium, fontSize: 10.5 },
  featureTitle: { fontFamily: font.monoSemi, fontSize: 14, letterSpacing: -0.1 },
  featureStatus: { fontFamily: font.monoMedium, fontSize: 11 },
  featurePath: { fontFamily: font.mono, fontSize: 11 },
  shellPrompt: { fontFamily: font.mono, fontSize: 12 },
  cmdLabel: { fontFamily: font.monoSemi, fontSize: 11, letterSpacing: 2.6 },
} as const;

export const status = {
  run: { color: colors.cyan, icon: '⚡', label: 'Running' },
  input: { color: colors.amber, icon: '!', label: 'Needs input' },
  err: { color: colors.rose, icon: '×', label: 'Setup' },
  idle: { color: colors.ink3, icon: '○', label: 'Idle' },
} as const;

export type FeatureStatus = keyof typeof status;
