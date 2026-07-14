import { describe, expect, it } from 'vitest'
import {
  buildRouteSamples,
  distanceBetween,
  routeDistances,
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

  it('does not sample an unfinished route', () => {
    expect(buildRouteSamples([[28, 41]])).toEqual([])
  })
})
