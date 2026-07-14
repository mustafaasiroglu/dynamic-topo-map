import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, {
  type GeoJSONSource,
  type Map as MapLibreMap,
  type RasterTileSource,
} from 'maplibre-gl'
import './App.css'
import {
  buildRouteSamples,
  distanceBetween,
  routeDistances,
  routePointDistances,
  walkingDistance,
  type Coordinate,
} from './measurement'
import { PALETTES, getPalette } from './palettes'
import { TerrainClient } from './terrainClient'
import { lngLatToTile, visibleTiles } from './tileMath'
import type { ElevationRange, LayerMode, PaletteId } from './types'

const HOME_VIEW = { center: [28.9784, 41.0082] as [number, number], zoom: 10 }
const SOURCE_ID = 'dynamic-terrain'
const LAYER_ID = 'dynamic-terrain'
const MEASUREMENT_SOURCE_ID = 'measurement-route'
const MEASUREMENT_LINE_ID = 'measurement-line'
const MEASUREMENT_PREVIEW_LINE_ID = 'measurement-preview-line'
const MEASUREMENT_POINTS_ID = 'measurement-points'
const MIN_POINT_DISTANCE_METERS = 1
const PREVIEW_DEBOUNCE_MS = 80
const LOCATION_MARKER_COLOR = '#1d6f42'

const LAYERS: readonly { id: LayerMode; label: string }[] = [
  { id: 'dynamic', label: 'Dynamic elevation' },
  { id: 'hillshade', label: 'Hillshade' },
  { id: 'combined', label: 'Elevation + hillshade' },
  { id: 'slope', label: 'Slope' },
  { id: 'aspect', label: 'Aspect' },
]

function formatElevation(value: number | null) {
  if (value === null || !Number.isFinite(value)) return '—'
  return `${Math.round(value).toLocaleString()} m`
}

function formatDistance(value: number) {
  if (value < 1000) return `${Math.round(value)} m`
  return `${(value / 1000).toFixed(value < 10_000 ? 2 : 1)} km`
}

interface ProfileSample {
  distance: number
  elevation: number | null
}

async function sampleElevationProfile(
  client: TerrainClient,
  points: readonly Coordinate[],
  zoom: number,
  sampleCount?: number,
) {
  return Promise.all(
    buildRouteSamples(points, sampleCount).map(async (sample) => {
      const tile = lngLatToTile(
        sample.coordinate[0],
        sample.coordinate[1],
        zoom,
      )
      try {
        const elevation = await client.sample(tile, tile.pixelX, tile.pixelY)
        return { distance: sample.distance, elevation }
      } catch {
        return { distance: sample.distance, elevation: null }
      }
    }),
  )
}

function terrainTileUrl(
  palette: PaletteId,
  mode: LayerMode,
  range: ElevationRange,
) {
  const query = new URLSearchParams({
    palette,
    mode,
    min: String(range.min),
    max: String(range.max),
  })
  return `dynamic-dem://tiles/{z}/{x}/{y}?${query}`
}

function App() {
  const mapContainer = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | null>(null)
  const clientRef = useRef<TerrainClient | null>(null)
  const locationMarkerRef = useRef<maplibregl.Marker | null>(null)
  const analysisSequence = useRef(0)
  const sampleSequence = useRef(0)
  const profileSequence = useRef(0)
  const previewProfileSequence = useRef(0)
  const measuringRef = useRef(false)
  const [palette, setPalette] = useState<PaletteId>('basic')
  const [mode, setMode] = useState<LayerMode>('dynamic')
  const [range, setRange] = useState<ElevationRange>({ min: 0, max: 4000 })
  const [cursorElevation, setCursorElevation] = useState<number | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [controlsOpen, setControlsOpen] = useState(true)
  const [locationStatus, setLocationStatus] = useState<
    'idle' | 'loading' | 'error'
  >('idle')
  const [measuring, setMeasuring] = useState(false)
  const [measurementPoints, setMeasurementPoints] = useState<Coordinate[]>([])
  const [previewPoint, setPreviewPoint] = useState<Coordinate | null>(null)
  const [profile, setProfile] = useState<ProfileSample[]>([])
  const [profileLoading, setProfileLoading] = useState(false)
  const [previewProfile, setPreviewProfile] = useState<ProfileSample[]>([])
  const [previewProfileLoading, setPreviewProfileLoading] = useState(false)
  const settingsRef = useRef({ palette, mode })
  settingsRef.current = { palette, mode }
  const activePalette = useMemo(() => getPalette(palette), [palette])
  const legend = useMemo(() => {
    if (mode === 'hillshade') {
      return { stops: ['#101315', '#f7f7f4'], low: 'Shadow', high: 'Lit' }
    }
    if (mode === 'slope') {
      return { stops: activePalette.stops, low: '0°', high: '60°+' }
    }
    if (mode === 'aspect') {
      return { stops: activePalette.stops, low: '0°', high: '360°' }
    }
    return {
      stops: activePalette.zeroColor
        ? [activePalette.zeroColor, ...activePalette.stops]
        : activePalette.stops,
      low: formatElevation(range.min),
      high: formatElevation(range.max),
    }
  }, [activePalette.stops, activePalette.zeroColor, mode, range.max, range.min])
  const measuredDistances = useMemo(
    () => routeDistances(measurementPoints),
    [measurementPoints],
  )
  const measuredWalkingDistance = useMemo(() => walkingDistance(profile), [profile])
  const hasPreviewSegment = useMemo(() => {
    const lastPoint = measurementPoints.at(-1)
    return Boolean(
      lastPoint &&
        previewPoint &&
        distanceBetween(lastPoint, previewPoint) >= MIN_POINT_DISTANCE_METERS,
    )
  }, [measurementPoints, previewPoint])
  const liveDistances = useMemo(
    () =>
      routeDistances(
        hasPreviewSegment
          ? [...measurementPoints, previewPoint!]
          : measurementPoints,
      ),
    [hasPreviewSegment, measurementPoints, previewPoint],
  )
  const liveWalkingDistance = useMemo(
    () => measuredWalkingDistance + walkingDistance(previewProfile),
    [measuredWalkingDistance, previewProfile],
  )
  const chartGeometry = useMemo(() => {
    const committedSamples = profile.filter(
      (sample): sample is { distance: number; elevation: number } =>
        sample.elevation !== null && Number.isFinite(sample.elevation),
    )
    const previewSamples = previewProfile
      .filter(
        (sample): sample is { distance: number; elevation: number } =>
          sample.elevation !== null && Number.isFinite(sample.elevation),
      )
      .map((sample) => ({
        ...sample,
        distance: measuredDistances.total + sample.distance,
      }))
    const samples = [...committedSamples, ...previewSamples]
    if (samples.length < 2) {
      return { committed: '', preview: '', polygon: '', markers: [] }
    }
    const elevations = samples.map(({ elevation }) => elevation)
    const min = Math.min(...elevations)
    const max = Math.max(...elevations)
    const span = Math.max(1, max - min)
    const distance = Math.max(1, samples.at(-1)!.distance)
    const toPoint = (sample: { distance: number; elevation: number }) =>
      `${(sample.distance / distance) * 600},${92 - ((sample.elevation - min) / span) * 82}`
    const committed = committedSamples.map(toPoint).join(' ')
    const preview = previewSamples.map(toPoint).join(' ')
    const pointDistances = routePointDistances(measurementPoints)
    const markers = pointDistances.flatMap((pointDistance, index) => {
      let nearest = samples[0]
      for (const sample of samples) {
        if (
          Math.abs(sample.distance - pointDistance) <
          Math.abs(nearest.distance - pointDistance)
        ) {
          nearest = sample
        }
      }
      return [
        {
          id: `${measurementPoints[index][0]}:${measurementPoints[index][1]}:${index}`,
          x: (pointDistance / distance) * 600,
          y: 92 - ((nearest.elevation - min) / span) * 82,
        },
      ]
    })
    return {
      committed,
      preview,
      polygon:
        committedSamples.length >= 2
          ? `0,100 ${committed} ${(committedSamples.at(-1)!.distance / distance) * 600},100`
          : '',
      markers,
    }
  }, [measuredDistances.total, measurementPoints, previewProfile, profile])

  const updateTerrainSource = useCallback(
    (
      nextRange: ElevationRange,
      nextPalette?: PaletteId,
      nextMode?: LayerMode,
    ) => {
      const source = mapRef.current?.getSource(SOURCE_ID) as
        | RasterTileSource
        | undefined
      source?.setTiles([
        terrainTileUrl(
          nextPalette ?? settingsRef.current.palette,
          nextMode ?? settingsRef.current.mode,
          nextRange,
        ),
      ])
    },
    [],
  )

  const analyzeViewport = useCallback(async () => {
    const map = mapRef.current
    const client = clientRef.current
    if (!map || !client || !map.isStyleLoaded()) return
    const sequence = ++analysisSequence.current
    const bounds = map.getBounds()
    const tiles = visibleTiles(
      {
        west: bounds.getWest(),
        south: bounds.getSouth(),
        east: bounds.getEast(),
        north: bounds.getNorth(),
      },
      map.getZoom(),
    )
    setStatus('loading')

    try {
      const nextRange = await client.analyze(tiles)
      if (sequence !== analysisSequence.current) return
      const paddedRange =
        nextRange.min === nextRange.max
          ? {
              min: Math.max(0, nextRange.min - 1),
              max: nextRange.max + 1,
            }
          : { min: Math.max(0, nextRange.min), max: Math.max(0, nextRange.max) }
      setRange(paddedRange)
      updateTerrainSource(paddedRange)
      setStatus('ready')
    } catch {
      if (sequence === analysisSequence.current) setStatus('error')
    }
  }, [updateTerrainSource])

  useEffect(() => {
    if (!mapContainer.current) return
    const client = new TerrainClient()
    clientRef.current = client

    maplibregl.addProtocol('dynamic-dem', async (request, abortController) => {
      const url = new URL(request.url)
      const [z, x, y] = url.pathname.split('/').filter(Boolean).map(Number)
      if ([z, x, y].some((value) => !Number.isInteger(value))) {
        throw new Error('Invalid terrain tile address')
      }
      const renderPromise = client.render(
        { z, x, y },
        (url.searchParams.get('palette') ?? 'basic') as PaletteId,
        (url.searchParams.get('mode') ?? 'dynamic') as LayerMode,
        {
          min: Number(url.searchParams.get('min') ?? 0),
          max: Number(url.searchParams.get('max') ?? 1),
        },
      )
      if (abortController.signal.aborted) throw new DOMException('Aborted', 'AbortError')
      return { data: await renderPromise }
    })

    const map = new maplibregl.Map({
      container: mapContainer.current,
      style: 'https://tiles.openfreemap.org/styles/liberty',
      center: HOME_VIEW.center,
      zoom: HOME_VIEW.zoom,
      minZoom: 2,
      maxZoom: 15,
      attributionControl: false,
      cooperativeGestures: false,
    })
    mapRef.current = map
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      'bottom-right',
    )
    map.addControl(
      new maplibregl.AttributionControl({ compact: true }),
      'bottom-right',
    )

    map.on('load', () => {
      map.addSource(SOURCE_ID, {
        type: 'raster',
        tiles: [terrainTileUrl('basic', 'dynamic', { min: 0, max: 4000 })],
        tileSize: 256,
        minzoom: 0,
        maxzoom: 13,
        attribution:
          'Elevation: <a href="https://registry.opendata.aws/terrain-tiles/" target="_blank">AWS Terrain Tiles</a>',
      })
      const labelsLayer = map
        .getStyle()
        .layers.find((layer) => layer.type === 'symbol')?.id
      map.addLayer(
        {
          id: LAYER_ID,
          type: 'raster',
          source: SOURCE_ID,
          paint: {
            'raster-opacity': 0.9,
            'raster-fade-duration': 180,
          },
        },
        labelsLayer,
      )
      map.addSource(MEASUREMENT_SOURCE_ID, {
        type: 'geojson',
        data: { type: 'FeatureCollection', features: [] },
      })
      map.addLayer({
        id: MEASUREMENT_LINE_ID,
        type: 'line',
        source: MEASUREMENT_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'route'],
        paint: {
          'line-color': '#173f2b',
          'line-width': 4,
          'line-opacity': 0.9,
        },
      })
      map.addLayer({
        id: MEASUREMENT_PREVIEW_LINE_ID,
        type: 'line',
        source: MEASUREMENT_SOURCE_ID,
        filter: ['==', ['get', 'kind'], 'preview'],
        paint: {
          'line-color': '#173f2b',
          'line-width': 3,
          'line-opacity': 0.8,
          'line-dasharray': [2, 2],
        },
      })
      map.addLayer({
        id: MEASUREMENT_POINTS_ID,
        type: 'circle',
        source: MEASUREMENT_SOURCE_ID,
        filter: ['==', ['geometry-type'], 'Point'],
        paint: {
          'circle-radius': 6,
          'circle-color': '#ffffff',
          'circle-stroke-color': '#173f2b',
          'circle-stroke-width': 3,
        },
      })
      void analyzeViewport()
    })
    map.on('move', () => {
      if (measuringRef.current) {
        const center = map.getCenter()
        setPreviewPoint([center.lng, center.lat])
      }
    })
    map.on('moveend', analyzeViewport)
    map.on('mousemove', (event) => {
      const zoom = Math.min(13, Math.max(0, Math.floor(map.getZoom())))
      const tile = lngLatToTile(event.lngLat.lng, event.lngLat.lat, zoom)
      const sequence = ++sampleSequence.current
      void client
        .sample(tile, tile.pixelX, tile.pixelY)
        .then((value) => {
          if (sequence === sampleSequence.current) setCursorElevation(value)
        })
        .catch(() => {
          if (sequence === sampleSequence.current) setCursorElevation(null)
        })
    })
    map.on('mouseout', () => setCursorElevation(null))

    return () => {
      analysisSequence.current += 1
      sampleSequence.current += 1
      profileSequence.current += 1
      previewProfileSequence.current += 1
      locationMarkerRef.current?.remove()
      map.remove()
      mapRef.current = null
      client.destroy()
      clientRef.current = null
      maplibregl.removeProtocol('dynamic-dem')
    }
  }, [analyzeViewport])

  useEffect(() => {
    updateTerrainSource(range, palette, mode)
  }, [mode, palette, range, updateTerrainSource])

  useEffect(() => {
    const source = mapRef.current?.getSource(
      MEASUREMENT_SOURCE_ID,
    ) as GeoJSONSource | undefined
    if (!source) return
    const pointFeatures = measurementPoints.map(
      (coordinate, index) => ({
        type: 'Feature' as const,
        properties: { index },
        geometry: { type: 'Point' as const, coordinates: coordinate },
      }),
    )
    const lineFeatures =
      measurementPoints.length > 1
        ? [
            {
              type: 'Feature' as const,
              properties: { kind: 'route' },
              geometry: {
                type: 'LineString' as const,
                coordinates: measurementPoints,
              },
            },
          ]
        : []
    const lastPoint = measurementPoints.at(-1)
    if (
      lastPoint &&
      previewPoint &&
      distanceBetween(lastPoint, previewPoint) >= MIN_POINT_DISTANCE_METERS
    ) {
      lineFeatures.push({
        type: 'Feature' as const,
        properties: { kind: 'preview' },
        geometry: {
          type: 'LineString' as const,
          coordinates: [lastPoint, previewPoint],
        },
      })
    }
    source.setData({
      type: 'FeatureCollection',
      features: [...lineFeatures, ...pointFeatures],
    })
  }, [measurementPoints, previewPoint])

  useEffect(() => {
    const client = clientRef.current
    const samples = buildRouteSamples(measurementPoints)
    const sequence = ++profileSequence.current
    if (!client || samples.length < 2) {
      setProfile([])
      setProfileLoading(false)
      return
    }
    setProfileLoading(true)
    const zoom = Math.min(
      13,
      Math.max(0, Math.floor(mapRef.current?.getZoom() ?? HOME_VIEW.zoom)),
    )
    void sampleElevationProfile(client, measurementPoints, zoom).then((nextProfile) => {
      if (sequence !== profileSequence.current) return
      setProfile(nextProfile)
      setProfileLoading(false)
    })
  }, [measurementPoints])

  useEffect(() => {
    const client = clientRef.current
    const lastPoint = measurementPoints.at(-1)
    const sequence = ++previewProfileSequence.current
    if (!client || !lastPoint || !previewPoint || !hasPreviewSegment) {
      setPreviewProfile([])
      setPreviewProfileLoading(false)
      return
    }
    setPreviewProfileLoading(true)
    const timeout = window.setTimeout(() => {
      const zoom = Math.min(
        13,
        Math.max(0, Math.floor(mapRef.current?.getZoom() ?? HOME_VIEW.zoom)),
      )
      void sampleElevationProfile(client, [lastPoint, previewPoint], zoom, 24).then(
        (nextProfile) => {
          if (sequence !== previewProfileSequence.current) return
          setPreviewProfile(nextProfile)
          setPreviewProfileLoading(false)
        },
      )
    }, PREVIEW_DEBOUNCE_MS)
    return () => window.clearTimeout(timeout)
  }, [hasPreviewSegment, measurementPoints, previewPoint])

  const resetView = () => {
    mapRef.current?.easeTo({ ...HOME_VIEW, duration: 900 })
  }

  const locateUser = () => {
    if (!navigator.geolocation || locationStatus === 'loading') return
    setLocationStatus('loading')
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        const coordinate: Coordinate = [coords.longitude, coords.latitude]
        const map = mapRef.current
        if (!map) return
        locationMarkerRef.current?.remove()
        locationMarkerRef.current = new maplibregl.Marker({
          color: LOCATION_MARKER_COLOR,
        })
          .setLngLat(coordinate)
          .addTo(map)
        map.easeTo({ center: coordinate, zoom: Math.max(map.getZoom(), 13), duration: 900 })
        setLocationStatus('idle')
      },
      () => setLocationStatus('error'),
      { enableHighAccuracy: true, timeout: 10_000 },
    )
  }

  const startMeasurement = () => {
    const center = mapRef.current?.getCenter()
    if (!center) return
    measuringRef.current = true
    setMeasuring(true)
    setMeasurementPoints([])
    setPreviewPoint([center.lng, center.lat])
  }

  const addMeasurementPoint = () => {
    const center = mapRef.current?.getCenter()
    if (!center) return
    const coordinate: Coordinate = [center.lng, center.lat]
    setMeasurementPoints((points) => {
      const last = points.at(-1)
      return !last || distanceBetween(last, coordinate) >= MIN_POINT_DISTANCE_METERS
        ? [...points, coordinate]
        : points
    })
    setPreviewProfile([])
    setPreviewPoint(coordinate)
  }

  const undoMeasurementPoint = () => {
    setMeasurementPoints((points) => points.slice(0, -1))
  }

  const stopMeasurement = () => {
    measuringRef.current = false
    setMeasuring(false)
    setMeasurementPoints([])
    setPreviewPoint(null)
    setProfile([])
    setPreviewProfile([])
  }

  const toggleFullscreen = async () => {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen()
    else await document.exitFullscreen()
  }

  return (
    <main className="app-shell">
      <div ref={mapContainer} className="map" aria-label="Interactive terrain map" />

      <header className="brand">
        <div className="brand-mark" aria-hidden="true">
          <svg viewBox="0 0 48 48">
            <path d="M5 36 17 13l7 12 5-8 14 19H5Z" />
            <path d="M7 39c9-4 25-4 34 0M11 43c8-3 18-3 26 0" />
          </svg>
        </div>
        <div>
          <h1>TopoScope</h1>
          <p>Dynamic terrain explorer</p>
        </div>
      </header>

      <div className="map-tools">
        <button
          className={`map-tool-button ${locationStatus}`}
          type="button"
          aria-label="Go to current location"
          title={
            locationStatus === 'error'
              ? 'Current location unavailable'
              : 'Go to current location'
          }
          onClick={locateUser}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3m0 14v3M2 12h3m14 0h3" />
            <circle cx="12" cy="12" r="8" />
          </svg>
        </button>
        <button
          className={`map-tool-button ${measuring ? 'active' : ''}`}
          type="button"
          aria-label={measuring ? 'Close distance measurement' : 'Measure distance'}
          aria-pressed={measuring}
          title={measuring ? 'Close distance measurement' : 'Measure distance'}
          onClick={measuring ? stopMeasurement : startMeasurement}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 17 13-13 3 3L7 20H4v-3Z" />
            <path d="m13 8 3 3M9 12l2 2M17 4l3 3" />
          </svg>
        </button>
      </div>

      {measuring && <div className="measurement-reticle" aria-hidden="true" />}

      <section className={`control-panel ${controlsOpen ? '' : 'collapsed'}`}>
        <button
          className="panel-toggle"
          type="button"
          aria-expanded={controlsOpen}
          aria-label={controlsOpen ? 'Hide map controls' : 'Show map controls'}
          onClick={() => setControlsOpen((open) => !open)}
        >
          <span>Map controls</span>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m6 9 6 6 6-6" />
          </svg>
        </button>
        <div className="panel-content">
          <label>
            <span>Visualization</span>
            <select
              value={mode}
              onChange={(event) => setMode(event.target.value as LayerMode)}
            >
              {LAYERS.map((layer) => (
                <option key={layer.id} value={layer.id}>
                  {layer.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Color palette</span>
            <select
              value={palette}
              onChange={(event) => setPalette(event.target.value as PaletteId)}
            >
              {PALETTES.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
          </label>
          <div className="action-row">
            <button type="button" onClick={resetView}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M4 11a8 8 0 1 0 2-5.3M4 4v7h7" />
              </svg>
              Reset view
            </button>
            <button type="button" onClick={() => void toggleFullscreen()}>
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M8 3H3v5m13-5h5v5M8 21H3v-5m13 5h5v-5" />
              </svg>
              Fullscreen
            </button>
          </div>
        </div>
      </section>

      <section className="elevation-card" aria-live="polite">
        <div>
          <span>Cursor elevation</span>
          <strong>{formatElevation(cursorElevation)}</strong>
        </div>
        <div className="range-stat">
          <span>Visible range</span>
          <strong>
            {formatElevation(range.min)} <i>to</i> {formatElevation(range.max)}
          </strong>
        </div>
        <div
          className={`status-dot ${status}`}
          title={
            status === 'error'
              ? 'Terrain data unavailable'
              : status === 'loading'
                ? 'Updating terrain'
                : 'Terrain is current'
          }
        />
      </section>

      {measuring && (
        <section className="measurement-card" aria-live="polite">
          <button
            className="measurement-close"
            type="button"
            aria-label="Close distance measurement"
            onClick={stopMeasurement}
          >
            ×
          </button>
          <div className="measurement-heading">
            <div>
              <span>As-the-crow-flies</span>
              <div className="measurement-values">
                <strong>{formatDistance(measuredDistances.total)}</strong>
                {hasPreviewSegment && (
                  <em>{formatDistance(liveDistances.total)}</em>
                )}
              </div>
            </div>
            <div>
              <span>Walking distance</span>
              <div className="measurement-values">
                <strong>
                  {profileLoading
                    ? '…'
                    : formatDistance(measuredWalkingDistance)}
                </strong>
                {hasPreviewSegment && (
                  <em>
                    {profileLoading || previewProfileLoading
                      ? '…'
                      : formatDistance(liveWalkingDistance)}
                  </em>
                )}
              </div>
            </div>
            <small>
              {measurementPoints.length}{' '}
              {measurementPoints.length === 1 ? 'point' : 'points'} · Move the map
              to position the next point
            </small>
          </div>
          <div className="profile-chart">
            {chartGeometry.committed || chartGeometry.preview ? (
              <svg
                viewBox="0 0 600 100"
                role="img"
                aria-label="Elevation profile for the measured route"
                preserveAspectRatio="none"
              >
                {chartGeometry.polygon && (
                  <polygon points={chartGeometry.polygon} />
                )}
                {chartGeometry.committed && (
                  <polyline
                    className="profile-line"
                    points={chartGeometry.committed}
                  />
                )}
                {chartGeometry.preview && (
                  <polyline
                    className="profile-preview-line"
                    points={chartGeometry.preview}
                  />
                )}
                {chartGeometry.markers.map((marker) => (
                  <circle
                    className="profile-marker"
                    cx={marker.x}
                    cy={marker.y}
                    key={marker.id}
                    r="5"
                  />
                ))}
              </svg>
            ) : profileLoading || previewProfileLoading ? (
              <span>Loading elevation profile…</span>
            ) : (
              <span>Add at least two points to see the elevation profile</span>
            )}
          </div>
          <div className="measurement-actions">
            <button
              className="undo-point"
              type="button"
              aria-label="Undo last point"
              title="Undo last point"
              disabled={measurementPoints.length === 0}
              onClick={undoMeasurementPoint}
            >
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M9 7 4 12l5 5" />
                <path d="M5 12h8a6 6 0 0 1 6 6" />
              </svg>
            </button>
            <button
              className="add-point"
              type="button"
              onClick={addMeasurementPoint}
            >
              <span aria-hidden="true">+</span> Add point
            </button>
          </div>
        </section>
      )}

      <section className="legend" aria-label={`${activePalette.label} elevation legend`}>
        <div
          className="gradient"
          style={{
            background: `linear-gradient(90deg, ${legend.stops.join(', ')})`,
          }}
        />
        <div>
          <span>{legend.low}</span>
          <strong>{mode === 'aspect' ? 'Orientation' : LAYERS.find((l) => l.id === mode)?.label}</strong>
          <span>{legend.high}</span>
        </div>
      </section>
    </main>
  )
}

export default App
