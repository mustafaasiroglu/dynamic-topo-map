import type { Palette } from './types'

export const PALETTES: readonly Palette[] = [
  {
    id: 'terrain',
    label: 'Terrain',
    stops: ['#163a2d', '#43855a', '#b8c66a', '#a66f45', '#f3eee2'],
  },
  {
    id: 'viridis',
    label: 'Viridis',
    stops: ['#440154', '#3b528b', '#21918c', '#5ec962', '#fde725'],
  },
  {
    id: 'turbo',
    label: 'Turbo',
    stops: ['#30123b', '#466be3', '#27c9af', '#f9e721', '#f45d2f', '#7a0403'],
  },
  {
    id: 'inferno',
    label: 'Inferno',
    stops: ['#000004', '#420a68', '#932667', '#dd513a', '#fca50a', '#fcffa4'],
  },
  {
    id: 'grayscale',
    label: 'Grayscale',
    stops: ['#101315', '#555b5d', '#a6aaab', '#f7f7f4'],
  },
  {
    id: 'earth',
    label: 'Earth',
    stops: ['#233d35', '#68895b', '#b9a66b', '#8e644d', '#d9d0c1'],
  },
  {
    id: 'accessible',
    label: 'Colorblind friendly',
    stops: ['#352a87', '#0363e1', '#00a6ca', '#7ac7c4', '#f9d057', '#f29e2e'],
  },
] as const

export function getPalette(id: string): Palette {
  return PALETTES.find((palette) => palette.id === id) ?? PALETTES[0]
}
