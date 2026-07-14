import type { TileCoordinate } from './types'

const MAX_LATITUDE = 85.051129

function clampLatitude(latitude: number) {
  return Math.max(-MAX_LATITUDE, Math.min(MAX_LATITUDE, latitude))
}

export function lngLatToTile(
  longitude: number,
  latitude: number,
  zoom: number,
): TileCoordinate & { pixelX: number; pixelY: number } {
  const scale = 2 ** zoom
  const wrappedLongitude = ((longitude + 180) % 360 + 360) % 360 - 180
  const x = ((wrappedLongitude + 180) / 360) * scale
  const latRadians = (clampLatitude(latitude) * Math.PI) / 180
  const y =
    ((1 - Math.asinh(Math.tan(latRadians)) / Math.PI) / 2) * scale
  const tileX = Math.min(scale - 1, Math.max(0, Math.floor(x)))
  const tileY = Math.min(scale - 1, Math.max(0, Math.floor(y)))

  return {
    z: zoom,
    x: tileX,
    y: tileY,
    pixelX: Math.min(255, Math.max(0, Math.floor((x - tileX) * 256))),
    pixelY: Math.min(255, Math.max(0, Math.floor((y - tileY) * 256))),
  }
}

interface BoundsLike {
  west: number
  south: number
  east: number
  north: number
}

function tileSpan(
  bounds: BoundsLike,
  zoom: number,
  limit: number,
): TileCoordinate[] | null {
  const scale = 2 ** zoom
  const northWest = lngLatToTile(bounds.west, bounds.north, zoom)
  const southEast = lngLatToTile(bounds.east, bounds.south, zoom)
  const crossesDateLine = bounds.east < bounds.west
  const xValues: number[] = []

  if (crossesDateLine) {
    for (let x = northWest.x; x < scale; x += 1) xValues.push(x)
    for (let x = 0; x <= southEast.x; x += 1) xValues.push(x)
  } else {
    for (let x = northWest.x; x <= southEast.x; x += 1) xValues.push(x)
  }

  const rowCount = southEast.y - northWest.y + 1
  if (xValues.length * rowCount > limit) return null

  const tiles: TileCoordinate[] = []
  for (let y = northWest.y; y <= southEast.y; y += 1) {
    for (const x of xValues) tiles.push({ z: zoom, x, y })
  }
  return tiles
}

export function visibleTiles(
  bounds: BoundsLike,
  mapZoom: number,
  maxTiles = 48,
): TileCoordinate[] {
  let zoom = Math.min(13, Math.max(0, Math.floor(mapZoom)))
  let tiles = tileSpan(bounds, zoom, maxTiles)

  while (!tiles && zoom > 0) {
    zoom -= 1
    tiles = tileSpan(bounds, zoom, maxTiles)
  }
  return tiles ?? [{ z: 0, x: 0, y: 0 }]
}

export function tileKey(tile: TileCoordinate) {
  return `${tile.z}/${tile.x}/${tile.y}`
}
