import { describe, expect, it } from 'vitest'
import { lngLatToTile, tileKey, visibleTiles } from './tileMath'

describe('lngLatToTile', () => {
  it('converts the prime meridian to a Web Mercator tile', () => {
    expect(lngLatToTile(0, 0, 2)).toEqual({
      z: 2,
      x: 2,
      y: 2,
      pixelX: 0,
      pixelY: 0,
    })
  })

  it('wraps longitude and clamps polar latitudes', () => {
    const wrapped = lngLatToTile(190, 90, 3)
    expect(wrapped.x).toBe(0)
    expect(wrapped.y).toBe(0)
    expect(tileKey(wrapped)).toBe('3/0/0')
  })
})

describe('visibleTiles', () => {
  it('includes tiles on both sides of the date line', () => {
    const tiles = visibleTiles(
      { west: 170, south: -10, east: -170, north: 10 },
      2,
    )
    expect(new Set(tiles.map(({ x }) => x))).toEqual(new Set([0, 3]))
  })

  it('reduces analysis zoom to keep work bounded', () => {
    const tiles = visibleTiles(
      { west: -170, south: -70, east: 170, north: 70 },
      13,
      12,
    )
    expect(tiles.length).toBeLessThanOrEqual(12)
    expect(tiles[0].z).toBeLessThan(13)
  })
})
