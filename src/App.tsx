import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import maplibregl, {
  type Map as MapLibreMap,
  type RasterTileSource,
} from 'maplibre-gl'
import './App.css'
import { PALETTES, getPalette } from './palettes'
import { TerrainClient } from './terrainClient'
import { lngLatToTile, visibleTiles } from './tileMath'
import type { ElevationRange, LayerMode, PaletteId } from './types'

const HOME_VIEW = { center: [10.1, 46.6] as [number, number], zoom: 6.3 }
const SOURCE_ID = 'dynamic-terrain'
const LAYER_ID = 'dynamic-terrain'

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
  const analysisSequence = useRef(0)
  const sampleSequence = useRef(0)
  const [palette, setPalette] = useState<PaletteId>('terrain')
  const [mode, setMode] = useState<LayerMode>('dynamic')
  const [range, setRange] = useState<ElevationRange>({ min: 0, max: 4000 })
  const [cursorElevation, setCursorElevation] = useState<number | null>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [controlsOpen, setControlsOpen] = useState(true)
  const settingsRef = useRef({ palette, mode })
  settingsRef.current = { palette, mode }
  const activePalette = useMemo(() => getPalette(palette), [palette])

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
        (url.searchParams.get('palette') ?? 'terrain') as PaletteId,
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
        tiles: [terrainTileUrl('terrain', 'dynamic', { min: 0, max: 4000 })],
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

    return () => {
      analysisSequence.current += 1
      sampleSequence.current += 1
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

  const resetView = () => {
    mapRef.current?.easeTo({ ...HOME_VIEW, duration: 900 })
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

      <section className="legend" aria-label={`${activePalette.label} elevation legend`}>
        <div
          className="gradient"
          style={{
            background: `linear-gradient(90deg, ${activePalette.stops.join(', ')})`,
          }}
        />
        <div>
          <span>{formatElevation(range.min)}</span>
          <strong>{mode === 'aspect' ? 'Orientation' : LAYERS.find((l) => l.id === mode)?.label}</strong>
          <span>{formatElevation(range.max)}</span>
        </div>
      </section>
    </main>
  )
}

export default App
