# TopoScope

A browser-only topographic map whose elevation colors adapt to the visible
viewport. Zooming or panning recalculates the local minimum and maximum so both
subtle relief and large mountain ranges retain useful contrast.

## Features

- Dynamic elevation, hillshade, combined relief, slope, and aspect views
- Seven selectable color palettes
- Istanbul default view and an on-demand current-location control
- Live cursor elevation and visible elevation range
- Mouse, keyboard, and touch navigation through MapLibre GL JS
- DEM decoding and image generation in a Web Worker
- Responsive, accessible controls with no accounts, cookies, or telemetry
- Static GitHub Pages deployment with no backend

## Development

Requires Node.js 22 or newer.

```bash
npm install
npm run dev
```

Validation commands:

```bash
npm run lint
npm test
npm run build
```

## Data

The basemap is provided by [OpenFreeMap](https://openfreemap.org/). Elevation
comes from the public [AWS Terrain Tiles](https://registry.opendata.aws/terrain-tiles/)
Terrarium dataset. Tile requests go directly from the browser to those
providers; TopoScope has no server and does not collect user data.

## Deployment

The included GitHub Actions workflow builds and deploys `dist` to GitHub Pages
on pushes to `main`. Enable **GitHub Actions** as the Pages source in the
repository settings. The production build uses relative asset URLs and can also
be hosted by any static file server.
