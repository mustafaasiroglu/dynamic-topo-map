import type {
  ElevationRange,
  LayerMode,
  PaletteId,
  TileCoordinate,
} from './types'

type WorkerRequest =
  | { type: 'analyze'; tiles: TileCoordinate[] }
  | {
      type: 'render'
      tile: TileCoordinate
      palette: PaletteId
      mode: LayerMode
      range: ElevationRange
    }
  | {
      type: 'sample'
      tile: TileCoordinate
      pixelX: number
      pixelY: number
    }

interface WorkerResponse {
  id: number
  result?: unknown
  error?: string
}

export class TerrainClient {
  private readonly worker = new Worker(
    new URL('./terrain.worker.ts', import.meta.url),
    { type: 'module' },
  )
  private nextId = 0
  private pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason: Error) => void }
  >()

  constructor() {
    this.worker.onmessage = ({ data }: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(data.id)
      if (!request) return
      this.pending.delete(data.id)
      if (data.error) request.reject(new Error(data.error))
      else request.resolve(data.result)
    }
  }

  private request<T>(message: WorkerRequest): Promise<T> {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
      })
      this.worker.postMessage({ id, ...message })
    })
  }

  analyze(tiles: TileCoordinate[]) {
    return this.request<ElevationRange>({ type: 'analyze', tiles })
  }

  render(
    tile: TileCoordinate,
    palette: PaletteId,
    mode: LayerMode,
    range: ElevationRange,
  ) {
    return this.request<ArrayBuffer>({
      type: 'render',
      tile,
      palette,
      mode,
      range,
    })
  }

  sample(tile: TileCoordinate, pixelX: number, pixelY: number) {
    return this.request<number>({
      type: 'sample',
      tile,
      pixelX,
      pixelY,
    })
  }

  destroy() {
    this.worker.terminate()
    for (const { reject } of this.pending.values()) {
      reject(new Error('Terrain worker stopped'))
    }
    this.pending.clear()
  }
}
