import { describe, expect, it } from 'vitest'
import {
  buildRouteSamples,
  distanceBetween,
  routeDistances,
  routePointDistances,
  walkingDistance,
  type Coordinate,
} from './measurement'

describe('route measurement', () => {
  it('calculates route and direct distances', () => {
    const points: Coordinate[] = [
      [0, 0],
      [0, 1],
      [1, 1],
    ]
    const distances = routeDistances(points)

    expect(distances.total).toBeGreaterThan(distances.direct)
    expect(distanceBetween([0, 0], [0, 1])).toBeCloseTo(111_195, -1)
  })

  it('builds evenly spaced samples including both endpoints', () => {
    const points: Coordinate[] = [
      [28, 41],
      [29, 41],
      [29, 42],
    ]
    const samples = buildRouteSamples(points, 5)

    expect(samples).toHaveLength(5)
    expect(samples[0].coordinate).toEqual(points[0])
    expect(samples.at(-1)?.coordinate).toEqual(points.at(-1))
    expect(samples.at(-1)?.distance).toBeCloseTo(routeDistances(points).total)
  })

  it('returns the cumulative distance of each added point', () => {
    const points: Coordinate[] = [
      [0, 0],
      [0, 1],
      [1, 1],
    ]

    expect(routePointDistances([])).toEqual([])
    expect(routePointDistances(points)).toEqual([
      0,
      distanceBetween(points[0], points[1]),
      routeDistances(points).total,
    ])
  })

  it('does not sample an unfinished route', () => {
    expect(buildRouteSamples([[28, 41]])).toEqual([])
  })

  it('includes elevation changes in walking distance', () => {
    expect(
      walkingDistance([
        { distance: 0, elevation: 10 },
        { distance: 30, elevation: 50 },
        { distance: 60, elevation: null },
      ]),
    ).toBe(80)
  })
})
