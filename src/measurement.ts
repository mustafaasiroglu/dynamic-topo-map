export type Coordinate = [longitude: number, latitude: number]

export interface RouteSample {
  coordinate: Coordinate
  distance: number
}

const EARTH_RADIUS = 6_371_000

function radians(value: number) {
  return (value * Math.PI) / 180
}

export function distanceBetween(a: Coordinate, b: Coordinate) {
  const latitudeDelta = radians(b[1] - a[1])
  const longitudeDelta = radians(b[0] - a[0])
  const latitudeA = radians(a[1])
  const latitudeB = radians(b[1])
  const haversine =
    Math.sin(latitudeDelta / 2) ** 2 +
    Math.cos(latitudeA) *
      Math.cos(latitudeB) *
      Math.sin(longitudeDelta / 2) ** 2
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(haversine))
}

export function routeDistances(points: readonly Coordinate[]) {
  let total = 0
  for (let index = 1; index < points.length; index += 1) {
    total += distanceBetween(points[index - 1], points[index])
  }
  return {
    total,
    direct:
      points.length > 1 ? distanceBetween(points[0], points.at(-1)!) : 0,
  }
}

export function buildRouteSamples(
  points: readonly Coordinate[],
  sampleCount = 72,
): RouteSample[] {
  if (points.length < 2) return []
  const segmentLengths = points
    .slice(1)
    .map((point, index) => distanceBetween(points[index], point))
  const total = segmentLengths.reduce((sum, length) => sum + length, 0)
  if (total === 0) return [{ coordinate: points[0], distance: 0 }]

  const count = Math.max(2, sampleCount)
  return Array.from({ length: count }, (_, sampleIndex) => {
    const distance = (total * sampleIndex) / (count - 1)
    let segment = 0
    let segmentStart = 0
    while (
      segment < segmentLengths.length - 1 &&
      segmentStart + segmentLengths[segment] < distance
    ) {
      segmentStart += segmentLengths[segment]
      segment += 1
    }
    const progress =
      segmentLengths[segment] === 0
        ? 0
        : (distance - segmentStart) / segmentLengths[segment]
    const start = points[segment]
    const end = points[segment + 1]
    return {
      coordinate: [
        start[0] + (end[0] - start[0]) * progress,
        start[1] + (end[1] - start[1]) * progress,
      ],
      distance,
    }
  })
}
