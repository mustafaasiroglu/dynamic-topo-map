/// <reference lib="webworker" />

import { getPalette } from './palettes'
import { tileKey } from './tileMath'
import type {
  ElevationRange,
  LayerMode,
  PaletteId,
  TileCoordinate,
} from './types'

const TILE_SIZE = 256
const CACHE_LIMIT = 64
const cache = new Map<string, Float32Array>()
const pendingTiles = new Map<string, Promise<Float32Array>>()

type RequestMessage =
  | { id: number; type: 'analyze'; tiles: TileCoordinate[] }
  | {
      id: number
      type: 'render'
      tile: TileCoordinate
      palette: PaletteId
      mode: LayerMode
      range: ElevationRange
    }
  | {
      id: number
      type: 'sample'
      tile: TileCoordinate
      pixelX: number
      pixelY: number
    }

function remember(key: string, elevations: Float32Array) {
  cache.delete(key)
  cache.set(key, elevations)
  if (cache.size > CACHE_LIMIT) {
    const oldest = cache.keys().next().value
    if (oldest) cache.delete(oldest)
  }
}

async function fetchTile(key: string) {
  const response = await fetch(
    `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${key}.png`,
  )
  if (!response.ok) throw new Error(`Terrain tile unavailable (${response.status})`)
  const bitmap = await createImageBitmap(await response.blob())
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const context = canvas.getContext('2d', { willReadFrequently: true })
  if (!context) throw new Error('Canvas rendering is not supported')
  context.drawImage(bitmap, 0, 0)
  bitmap.close()
  const pixels = context.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data
  const elevations = new Float32Array(TILE_SIZE * TILE_SIZE)

  for (let index = 0; index < elevations.length; index += 1) {
    const offset = index * 4
    elevations[index] =
      pixels[offset] * 256 + pixels[offset + 1] + pixels[offset + 2] / 256 - 32768
  }
  remember(key, elevations)
  return elevations
}

async function loadTile(tile: TileCoordinate) {
  const key = tileKey(tile)
  const cached = cache.get(key)
  if (cached) {
    remember(key, cached)
    return cached
  }
  const pending = pendingTiles.get(key)
  if (pending) return pending

  const request = fetchTile(key)
  pendingTiles.set(key, request)
  try {
    return await request
  } finally {
    pendingTiles.delete(key)
  }
}

async function analyze(tiles: TileCoordinate[]) {
  const datasets = await Promise.all(tiles.map(loadTile))
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY

  for (const elevations of datasets) {
    for (let index = 0; index < elevations.length; index += 4) {
      const elevation = elevations[index]
      if (elevation < min) min = elevation
      if (elevation > max) max = elevation
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) {
    throw new Error('No elevation samples found')
  }
  return { min: Math.round(min), max: Math.round(max) }
}

function hexToRgb(hex: string) {
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ]
}

function paletteColor(stops: number[][], value: number) {
  const position = Math.min(1, Math.max(0, value)) * (stops.length - 1)
  const lower = Math.floor(position)
  const upper = Math.min(stops.length - 1, lower + 1)
  const amount = position - lower
  const start = stops[lower]
  const end = stops[upper]
  return start.map((channel, index) =>
    Math.round(channel + (end[index] - channel) * amount),
  )
}

function terrainGradient(elevations: Float32Array, x: number, y: number) {
  const left = elevations[y * TILE_SIZE + Math.max(0, x - 1)]
  const right = elevations[y * TILE_SIZE + Math.min(TILE_SIZE - 1, x + 1)]
  const top = elevations[Math.max(0, y - 1) * TILE_SIZE + x]
  const bottom = elevations[Math.min(TILE_SIZE - 1, y + 1) * TILE_SIZE + x]
  return { dx: (right - left) / 2, dy: (bottom - top) / 2 }
}

function relief(
  elevations: Float32Array,
  x: number,
  y: number,
  tile: TileCoordinate,
) {
  const { dx, dy } = terrainGradient(elevations, x, y)
  const latitude =
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * (tile.y + 0.5)) / 2 ** tile.z))) *
      180) /
    Math.PI
  const metersPerPixel =
    (Math.cos((latitude * Math.PI) / 180) * 40_075_016.686) /
    (TILE_SIZE * 2 ** tile.z)
  const gx = dx / Math.max(0.01, metersPerPixel)
  const gy = dy / Math.max(0.01, metersPerPixel)
  const slope = Math.atan(Math.hypot(gx, gy))
  const aspect = Math.atan2(gy, -gx)
  const azimuth = (315 * Math.PI) / 180
  const altitude = (45 * Math.PI) / 180
  const illumination =
    Math.sin(altitude) * Math.cos(slope) +
    Math.cos(altitude) * Math.sin(slope) * Math.cos(azimuth - aspect)
  return {
    slope: (slope * 180) / Math.PI,
    aspect: ((aspect * 180) / Math.PI + 360) % 360,
    shade: Math.min(1, Math.max(0, (illumination + 0.25) / 1.25)),
  }
}

async function render(
  tile: TileCoordinate,
  paletteId: PaletteId,
  mode: LayerMode,
  range: ElevationRange,
) {
  const elevations = await loadTile(tile)
  const palette = getPalette(paletteId)
  const stops = palette.stops.map(hexToRgb)
  const zeroColor = palette.zeroColor ? hexToRgb(palette.zeroColor) : null
  const image = new ImageData(TILE_SIZE, TILE_SIZE)
  const gradientStart = zeroColor ? Math.max(0, range.min) : range.min
  const span = Math.max(1, range.max - gradientStart)

  for (let y = 0; y < TILE_SIZE; y += 1) {
    for (let x = 0; x < TILE_SIZE; x += 1) {
      const index = y * TILE_SIZE + x
      const offset = index * 4
      const elevation = elevations[index]
      const normalized = (elevation - gradientStart) / span
      const terrain = relief(elevations, x, y, tile)
      let color: number[]

      if (mode === 'hillshade') {
        const gray = Math.round(terrain.shade * 255)
        color = [gray, gray, gray]
      } else if (mode === 'slope') {
        color = paletteColor(stops, terrain.slope / 60)
      } else if (mode === 'aspect') {
        color = paletteColor(stops, terrain.aspect / 360)
      } else if (zeroColor && elevation <= 0) {
        color = zeroColor
      } else {
        color = paletteColor(stops, normalized)
        if (mode === 'combined') {
          const light = 0.35 + terrain.shade * 0.75
          color = color.map((channel) => Math.min(255, Math.round(channel * light)))
        }
      }

      image.data[offset] = color[0]
      image.data[offset + 1] = color[1]
      image.data[offset + 2] = color[2]
      image.data[offset + 3] = 238
    }
  }

  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE)
  const context = canvas.getContext('2d')
  if (!context) throw new Error('Canvas rendering is not supported')
  context.putImageData(image, 0, 0)
  return (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer()
}

self.onmessage = async ({ data }: MessageEvent<RequestMessage>) => {
  try {
    let result: unknown
    if (data.type === 'analyze') result = await analyze(data.tiles)
    if (data.type === 'render') {
      result = await render(data.tile, data.palette, data.mode, data.range)
    }
    if (data.type === 'sample') {
      const elevations = await loadTile(data.tile)
      result = elevations[data.pixelY * TILE_SIZE + data.pixelX]
    }
    const transfer = result instanceof ArrayBuffer ? [result] : []
    self.postMessage({ id: data.id, result }, { transfer })
  } catch (error) {
    self.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : 'Terrain processing failed',
    })
  }
}

export {}
