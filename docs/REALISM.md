# Realism calibration

CityGen can measure a generated plan and a real city with the same code and compare them metric
by metric. This is an offline research workflow: **generation never needs the internet**, and no
real-city data ships with the repository.

Real cities are references for plausible ranges and relationships. They are not templates: no
generation rule reads the corpus, and there is no `if reference == PARIS`.

## What is measured

One profile, three scales. Every metric records the scale it was measured at; a 1.5 km
neighbourhood window is never compared with a whole metropolis.

| Scale | What | How |
|---|---|---|
| `city` | the whole urban area | one measurement |
| `district` | 6 km windows | median and 25th–75th percentile over half-overlapping windows that are at least half built-up |
| `neighbourhood` | 1.5 km windows | same |

| Metric | Definition |
|---|---|
| `intersectionDensity` | nodes where two or more streets meet (dead ends excluded), per km² |
| `streetDensity` | street length in km per km² |
| `segmentLengthMean`, `segmentLengthMedian` | length of a street between two intersections, m |
| `avgNodeDegree` | streets per node |
| `threeWayShare`, `fourWayShare`, `deadEndShare` | % of nodes with 3, 4 or more, and 1 street |
| `circuity` | total segment length / total straight-line distance between segment ends |
| `orientationEntropy` | Shannon entropy (nats) of street bearings in 36 bins, length-weighted, both directions |
| `orientationOrder` | `1 - ((H - ln 4) / (ln 36 - ln 4))²`: 1 for a perfect grid, 0 for uniform bearings (Boeing 2019) |
| `dominantOrientations` | number of peaks in the bearing histogram folded onto 0–90° (grid families) |
| `shareRegional` ... `shareLocal` | % of street length per road group |
| `majorRoadShare` | regional + arterial + avenue, % of length |
| `majorRoadSpacing` | `2 × area / major-road length`: the mesh size of an equivalent square grid, m |
| `blockAreaMedian`, `P25`, `P75` | block area, ha |
| `blockAspectMedian`, `P75` | long side / short side of the smallest rectangle around a block |
| `majorCorridorLengthKm` | length-weighted mean length of major corridors (see below), city scale only |
| `corridorContinuity` | that length divided by `sqrt(area)`: how far across the city a typical major-road metre's corridor runs |

Conventions shared by both analyzers:

- **Area** is the footprint of the network: the 200 m cells that a street passes through. It is
  not a convex hull, so densities are lower-bounded by built-up land and comparable between a
  coastal plan and an inland one.
- **Segments** are chains of degree-2 nodes merged, as OSMnx simplification does.
- **Blocks** are faces of the planarised network between 200 m² and 40 ha and at least 8 m wide.
  Bridges and tunnels are left out so they do not invent intersections.
- **Corridors** are chains of major segments that continue through junctions with less than 30°
  change of direction.
- **Road groups.** OSM `highway` and CityGen hierarchy map to the same five groups:

| Group | OpenStreetMap | CityGen |
|---|---|---|
| `regional` | motorway, trunk (+ links) | `REGIONAL` |
| `arterial` | primary | `METROPOLITAN_ARTERIAL` |
| `avenue` | secondary | `PRIMARY_AVENUE` |
| `connector` | tertiary | `SECONDARY_AVENUE`, `DISTRICT_CONNECTOR` |
| `local` | residential, living_street, unclassified, road | `LOCAL_HIGH_STREET`, `LOCAL` |

Service roads, tracks and paths are not part of the compared network.

There is no single realism score. The comparison returns, per metric, the generated value, the
reference value or range, the difference, and a diagnosis such as `OK`, `TOO SPARSE`,
`TOO ORDERED`. These are diagnostics, not errors.

## Distributions and samples

Averages hide variance, so every profile also carries:

- `scales.city.distributions`: P10, P25, median, P75, P90 within the city for `segmentLength`,
  `blockArea`, `blockAspect`, `nodeDegree`, plus `blockAreaOver03ha` / `blockAspectOver03ha`
  (faces under 0.3 ha left out, because in OSM data many are slivers between carriageways) and
  `smallFaceShare`.
- `scales.district.distributions` and `scales.neighbourhood.distributions`: the same five
  percentiles of every metric across that city's windows.
- `scales.<scale>.sampleList`: every window as a sample with `sampleId`, `bounds`, `areaKm2`,
  `context` (`ring`: central / inner / peripheral; `fabric`: strong_grid / mixed / irregular) and
  its `metrics`.

A reference profile additionally records `city`, `country`, `archetype` and `sourceMetadata`
(data source and licence, tool version, extraction date, boundary method and query, Overpass
filter, CRS), which is enough to repeat the extraction.

The first calibration study, with eight real cities against 96 generated ones, is in
[REALISM_CALIBRATION_REPORT.md](REALISM_CALIBRATION_REPORT.md).

## Workflow

### 1. Download a real city (Python, once per city)

```bash
python3 -m venv .venv && .venv/bin/pip install osmnx networkx geopandas shapely numpy pandas momepy
```

```bash
.venv/bin/python tools/reference/osmnx_to_reference.py --id barcelona
```

The script downloads the drivable network with OSMnx, projects it to UTM metres, and writes a
compact file to `reference/networks/barcelona.network.json`. Other forms:

```bash
.venv/bin/python tools/reference/osmnx_to_reference.py --all
```

```bash
.venv/bin/python tools/reference/osmnx_to_reference.py --place "Lyon, France" --id lyon
```

`--center LAT LON --window KM` limits a very large city to a square window, `--check` prints
OSMnx's own statistics for cross-checking, and `--momepy` adds a block-shape summary computed
with momepy. `reference/corpus.json` lists the starting corpus and its archetypes.

You can skip the script if you already have data: the analyzer also reads an OSMnx **GraphML**
file (`ox.save_graphml`) and **GeoJSON** street lines with a `highway` property, in metres or in
longitude / latitude. For a GeoPackage, export the edges layer to GeoJSON first
(`gdf.to_file("edges.geojson", driver="GeoJSON")`).

### 2. Measure it with CityGen's own code

```bash
node scripts/realism.mjs reference reference/networks/barcelona.network.json
```

`node scripts/realism.mjs reference --all` measures every downloaded city of the corpus.

This writes `reference/profiles/barcelona.json` in the profile schema. Because the same
`computeProfile` function measures generated plans, definitions cannot drift apart.

### 3. Combine cities into an archetype range (optional)

```bash
node scripts/realism.mjs sets
```

Profiles are grouped by the archetype in `reference/corpus.json` and written to
`reference/sets/<ARCHETYPE>.json` with a median and a range per metric (min–max for up to four
cities, 10th–90th percentile from five).

### 4. Compare

```bash
node scripts/realism.mjs compare --ref reference/profiles/barcelona.json --seed meridian-1 --scale district
```

Several `--ref` files are combined into a range on the fly. In the app, the **Reality Profile**
panel does the same: choose a scale, load one or more reference files, read generated value,
reference range and diagnosis side by side.

### 5. Study many seeds

```bash
node scripts/realism.mjs profile --seed study --count 100 --out profiles
```

Each `city-profile-<seed>.json` contains the seed and configuration, population, area, the
metric profile at all three scales, road-hierarchy lengths and shares, corridor statistics, block
statistics and validation counts. Load them in a notebook alongside the reference profiles:

```python
import glob, json, pandas as pd
gen = pd.DataFrame([json.load(open(f))["scales"]["district"]["metrics"] for f in glob.glob("profiles/*.json")])
ref = json.load(open("reference/profiles/barcelona.json"))["scales"]["district"]["metrics"]
print((gen.median() - pd.Series(ref)).sort_values())
```

## Data sources

| Purpose | Source | Status |
|---|---|---|
| Street networks | OpenStreetMap via OSMnx | supported by the script and readers |
| Ready-made networks | Geoff Boeing's global urban street-network datasets | GraphML is the same OSMnx format the reader parses; not yet tried on those files |
| Block and street morphology | momepy | optional summary in the script |
| Land use | Copernicus Urban Atlas | not read yet; planned for district-type calibration |
| Regional extent and density | GHSL | not read yet; planned for the regional release |
| Alternative network source | Overture Maps | not read yet; GeoJSON export works with the reader |

Do not scrape web maps, and do not commit large downloads: `reference/networks/` is for local use.

## Caveats

- OSM classification varies by country and mapper; road-group shares are the least comparable
  metrics. Compare within an archetype rather than across the world.
- Dual carriageways in OSM are two lines. They raise street density and add thin faces; the
  block filter removes most of those.
- CityGen's hierarchy is partly a classification of existing streets (see the README), so its
  class shares answer "is there a plausible middle tier?" rather than "are the streets wide
  enough?".
- The Python script was run with OSMnx 2.1.1 for the eight cities of the first study. On the
  same graph, OSMnx's own statistics and this analyzer agree closely (see the calibration report).
- OSM draws divided roads as two lines, which lowers the 4-way share and adds thin faces; streets
  cut by the extraction boundary end in artificial dead ends. Read block shape from the
  `Over03ha` distributions and dead ends from central and inner windows.
