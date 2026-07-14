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
const MEASUREMENT_POINTS_ID = 'measurement-points'

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
  const [measurePrompt, setMeasurePrompt] = useState<{
    coordinate: Coordinate
    x: number
    y: number
  } | null>(null)
  const [measuring, setMeasuring] = useState(false)
  const [measurementPoints, setMeasurementPoints] = useState<Coordinate[]>([])
  const [previewPoint, setPreviewPoint] = useState<Coordinate | null>(null)
  const [profile, setProfile] = useState<ProfileSample[]>([])
  const [profileLoading, setProfileLoading] = useState(false)
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
  const displayedMeasurementPoints = useMemo(() => {
    if (!previewPoint) return measurementPoints
    const last = measurementPoints.at(-1)
    if (last && distanceBetween(last, previewPoint) < 1) return measurementPoints
    return [...measurementPoints, previewPoint]
  }, [measurementPoints, previewPoint])
  const measuredDistances = useMemo(
    () => routeDistances(displayedMeasurementPoints),
    [displayedMeasurementPoints],
  )
  const profilePolyline = useMemo(() => {
    const samples = profile.filter(
      (sample): sample is { distance: number; elevation: number } =>
        sample.elevation !== null && Number.isFinite(sample.elevation),
    )
    if (samples.length < 2) return ''
    const elevations = samples.map(({ elevation }) => elevation)
    const min = Math.min(...elevations)
    const max = Math.max(...elevations)
    const span = Math.max(1, max - min)
    const distance = Math.max(1, samples.at(-1)!.distance)
    return samples
      .map(
        (sample) =>
          `${(sample.distance / distance) * 600},${92 - ((sample.elevation - min) / span) * 82}`,
      )
      .join(' ')
  }, [profile])

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
          ? { min: nextRange.min - 1, max: nextRange.max + 1 }
          : nextRange
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
        filter: ['==', ['geometry-type'], 'LineString'],
        paint: {
          'line-color': '#173f2b',
          'line-width': 4,
          'line-opacity': 0.9,
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

    const canvas = map.getCanvas()
    let longPressTimer: ReturnType<typeof setTimeout> | undefined
    let pressStart: { x: number; y: number } | null = null
    let drawingPointer: number | null = null

    const cancelLongPress = () => {
      if (longPressTimer) clearTimeout(longPressTimer)
      longPressTimer = undefined
      pressStart = null
    }
    const coordinateAt = (event: PointerEvent): Coordinate => {
      const bounds = canvas.getBoundingClientRect()
      const point = map.unproject([
        event.clientX - bounds.left,
        event.clientY - bounds.top,
      ])
      return [point.lng, point.lat]
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      if (measuringRef.current) {
        event.preventDefault()
        drawingPointer = event.pointerId
        canvas.setPointerCapture(event.pointerId)
        setPreviewPoint(coordinateAt(event))
        return
      }
      pressStart = { x: event.clientX, y: event.clientY }
      longPressTimer = setTimeout(() => {
        if (!pressStart) return
        const bounds = canvas.getBoundingClientRect()
        const coordinate = map.unproject([
          pressStart.x - bounds.left,
          pressStart.y - bounds.top,
        ])
        map.stop()
        setMeasurePrompt({
          coordinate: [coordinate.lng, coordinate.lat],
          x: Math.min(bounds.width - 180, Math.max(12, pressStart.x - bounds.left)),
          y: Math.min(bounds.height - 60, Math.max(12, pressStart.y - bounds.top)),
        })
        cancelLongPress()
      }, 1000)
    }
    const onPointerMove = (event: PointerEvent) => {
      if (drawingPointer === event.pointerId && measuringRef.current) {
        event.preventDefault()
        setPreviewPoint(coordinateAt(event))
        return
      }
      if (
        pressStart &&
        Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8
      ) {
        cancelLongPress()
      }
    }
    const onPointerUp = (event: PointerEvent) => {
      cancelLongPress()
      if (drawingPointer !== event.pointerId || !measuringRef.current) return
      event.preventDefault()
      const coordinate = coordinateAt(event)
      setMeasurementPoints((points) => {
        const last = points.at(-1)
        return last && distanceBetween(last, coordinate) >= 1
          ? [...points, coordinate]
          : points
      })
      setPreviewPoint(null)
      drawingPointer = null
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId)
      }
    }
    canvas.addEventListener('pointerdown', onPointerDown)
    canvas.addEventListener('pointermove', onPointerMove)
    canvas.addEventListener('pointerup', onPointerUp)
    canvas.addEventListener('pointercancel', onPointerUp)

    return () => {
      analysisSequence.current += 1
      sampleSequence.current += 1
      profileSequence.current += 1
      cancelLongPress()
      canvas.removeEventListener('pointerdown', onPointerDown)
      canvas.removeEventListener('pointermove', onPointerMove)
      canvas.removeEventListener('pointerup', onPointerUp)
      canvas.removeEventListener('pointercancel', onPointerUp)
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
    const pointFeatures = displayedMeasurementPoints.map(
      (coordinate, index) => ({
        type: 'Feature' as const,
        properties: { index },
        geometry: { type: 'Point' as const, coordinates: coordinate },
      }),
    )
    const lineFeatures =
      displayedMeasurementPoints.length > 1
        ? [
            {
              type: 'Feature' as const,
              properties: {},
              geometry: {
                type: 'LineString' as const,
                coordinates: displayedMeasurementPoints,
              },
            },
          ]
        : []
    source.setData({
      type: 'FeatureCollection',
      features: [...lineFeatures, ...pointFeatures],
    })
  }, [displayedMeasurementPoints])

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
    void Promise.all(
      samples.map(async (sample) => {
        const zoom = Math.min(
          13,
          Math.max(0, Math.floor(mapRef.current?.getZoom() ?? 10)),
        )
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
    ).then((nextProfile) => {
      if (sequence !== profileSequence.current) return
      setProfile(nextProfile)
      setProfileLoading(false)
    })
  }, [measurementPoints])

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
        locationMarkerRef.current = new maplibregl.Marker({ color: '#1d6f42' })
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
    if (!measurePrompt) return
    measuringRef.current = true
    setMeasuring(true)
    setMeasurementPoints([measurePrompt.coordinate])
    setPreviewPoint(null)
    setMeasurePrompt(null)
    mapRef.current?.dragPan.disable()
    mapRef.current?.touchZoomRotate.disable()
    mapRef.current?.doubleClickZoom.disable()
  }

  const stopMeasurement = () => {
    measuringRef.current = false
    setMeasuring(false)
    setMeasurementPoints([])
    setPreviewPoint(null)
    setProfile([])
    mapRef.current?.dragPan.enable()
    mapRef.current?.touchZoomRotate.enable()
    mapRef.current?.doubleClickZoom.enable()
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

      <button
        className={`location-button ${locationStatus}`}
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

      {measurePrompt && (
        <button
          className="measure-prompt"
          type="button"
          style={{ left: measurePrompt.x, top: measurePrompt.y }}
          onClick={startMeasurement}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="m4 17 13-13 3 3L7 20H4v-3Z" />
            <path d="m13 8 3 3M9 12l2 2M17 4l3 3" />
          </svg>
          Measure distance
        </button>
      )}

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
              <span>Route distance</span>
              <strong>{formatDistance(measuredDistances.total)}</strong>
            </div>
            <div>
              <span>Direct distance</span>
              <strong>{formatDistance(measuredDistances.direct)}</strong>
            </div>
            <small>
              {measurementPoints.length} points · Drag on the map to add a point
            </small>
          </div>
          <div className="profile-chart">
            {profileLoading ? (
              <span>Loading elevation profile…</span>
            ) : profilePolyline ? (
              <svg
                viewBox="0 0 600 100"
                role="img"
                aria-label="Elevation profile for the measured route"
                preserveAspectRatio="none"
              >
                <polygon points={`0,100 ${profilePolyline} 600,100`} />
                <polyline points={profilePolyline} />
              </svg>
            ) : (
              <span>Drag to choose the next point</span>
            )}
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
