export type PaletteId =
  | 'terrain'
  | 'viridis'
  | 'turbo'
  | 'inferno'
  | 'grayscale'
  | 'earth'
  | 'accessible'

export type LayerMode =
  | 'dynamic'
  | 'hillshade'
  | 'combined'
  | 'slope'
  | 'aspect'

export interface TileCoordinate {
  z: number
  x: number
  y: number
}

export interface ElevationRange {
  min: number
  max: number
}

export interface Palette {
  id: PaletteId
  label: string
  stops: readonly string[]
}
