#!/usr/bin/env python3
"""Download a real city's street network with OSMnx and write the compact network JSON that
CityGen's ReferenceCityAnalyzer reads.

This is an OFFLINE research tool. CityGen itself never touches the network: you run this once
per reference city, then measure the saved file with

    node scripts/realism.mjs reference reference/networks/<id>.network.json

so real and generated cities are measured by exactly the same code.

Usage
-----
    pip install osmnx networkx geopandas shapely numpy pandas momepy
    python tools/reference/osmnx_to_reference.py --id barcelona            # from reference/corpus.json
    python tools/reference/osmnx_to_reference.py --all                     # the whole corpus
    python tools/reference/osmnx_to_reference.py --place "Lyon, France" --id lyon
    python tools/reference/osmnx_to_reference.py --graphml saved.graphml --id mycity

Options: --center LAT LON --window KM   download a square window instead of the whole place
         --check                        also print OSMnx's own basic statistics, to cross-check
         --momepy                       also write block (tessellation-free) shape metrics via momepy

Output: reference/networks/<id>.network.json
    { "schema": "citygen-network/1", "name", "source", "crs", "nodes": [[x, y], ...],
      "edges": [[u, v, highway, bridge_or_tunnel(0/1), [x0, y0, x1, y1, ...]], ...] }
Coordinates are projected metres (UTM), rounded to 0.1 m. Each street appears once.
"""
import argparse
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
CORPUS = os.path.join(ROOT, "reference", "corpus.json")
OUT_DIR = os.path.join(ROOT, "reference", "networks")
# the drivable street network without service roads, which is what CityGen generates
CUSTOM_FILTER = (
    '["highway"~"motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|'
    'secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|road"]'
)


def load_graph(args, entry):
    """Returns (graph, how): `how` describes the boundary so the extraction can be repeated."""
    import osmnx as ox

    if args.graphml:
        return ox.load_graphml(args.graphml), {"method": "graphml_file", "file": os.path.basename(args.graphml)}
    center = args.center or entry.get("center")
    window = args.window or entry.get("window")
    if center and window:
        # a square window of `window` km around the centre
        G = ox.graph_from_point(tuple(center), dist=window * 500, dist_type="bbox", custom_filter=CUSTOM_FILTER, simplify=True)
        return G, {"method": "square_window", "center_lat_lon": list(center), "window_km": window}
    place = args.place or entry.get("place")
    if not place:
        sys.exit("Need --place, --graphml, or an --id that exists in reference/corpus.json")
    return ox.graph_from_place(place, custom_filter=CUSTOM_FILTER, simplify=True), {"method": "administrative_boundary", "geocode_query": place}


def to_network(G, name, source):
    import datetime
    import osmnx as ox

    G = ox.project_graph(G)                      # 2. project to local UTM metres
    crs = str(G.graph.get("crs"))
    index, nodes = {}, []
    for n, d in G.nodes(data=True):
        index[n] = len(nodes)
        nodes.append([round(d["x"], 1), round(d["y"], 1)])
    edges, seen = [], set()
    for u, v, k, d in G.edges(keys=True, data=True):
        if u == v:
            continue
        # a two-way street is stored once per direction; both directions have the same length
        # (osmid is not a safe key: after simplification it can be a list in either order)
        key = (min(u, v), max(u, v), round(float(d.get("length", 0)), 1))
        if key in seen:
            continue
        seen.add(key)
        hw = d.get("highway")
        hw = ",".join(hw) if isinstance(hw, list) else str(hw)
        flag = 1 if (d.get("bridge") not in (None, "no") or d.get("tunnel") not in (None, "no")) else 0
        geom = d.get("geometry")
        if geom is not None:
            coords = list(geom.coords)
            # edge geometry may run v -> u; make it start at u
            ux, uy = G.nodes[u]["x"], G.nodes[u]["y"]
            if (coords[0][0] - ux) ** 2 + (coords[0][1] - uy) ** 2 > (coords[-1][0] - ux) ** 2 + (coords[-1][1] - uy) ** 2:
                coords.reverse()
            flat = [round(c, 1) for xy in coords for c in xy]
        else:
            flat = []
        edges.append([index[u], index[v], hw, flag, flat])
    meta = {
        "data": "OpenStreetMap contributors (ODbL), via the Overpass API",
        "tool": f"OSMnx {ox.__version__}",
        "extracted": datetime.date.today().isoformat(),
        "networkType": "drivable streets without service roads",
        "overpassFilter": CUSTOM_FILTER,
        "simplified": "OSMnx topology simplification (degree-2 nodes merged)",
        "crs": crs,
        "projection": "projected by OSMnx to the local UTM zone; coordinates in metres, rounded to 0.1 m",
        "boundary": source,
    }
    return {"schema": "citygen-network/1", "name": name, "source": "OpenStreetMap via OSMnx", "sourceMetadata": meta, "crs": crs, "nodes": nodes, "edges": edges}


def cross_check(G):
    """OSMnx's own numbers, for comparing with the profile CityGen computes from the same file."""
    import osmnx as ox

    Gp = ox.project_graph(G)
    area = ox.convert.graph_to_gdfs(Gp, edges=False).union_all().convex_hull.area
    stats = ox.stats.basic_stats(Gp, area=area)
    Gu = ox.convert.to_undirected(ox.bearing.add_edge_bearings(G))
    print("  OSMnx cross-check (convex-hull area, so densities differ from CityGen's footprint area):")
    for key in ("intersection_density_km", "street_density_km", "street_length_avg", "streets_per_node_avg", "circuity_avg"):
        print(f"    {key}: {stats.get(key)}")
    print(f"    streets_per_node_proportions: {stats.get('streets_per_node_proportions')}")
    print(f"    orientation_entropy (unweighted, 36 bins): {ox.bearing.orientation_entropy(Gu)}")


def momepy_blocks(G, out_path):
    """Optional: block shapes with momepy, for studies beyond CityGen's own block metrics."""
    import geopandas as gpd
    import momepy
    import osmnx as ox
    from shapely.ops import polygonize

    edges = ox.convert.graph_to_gdfs(ox.project_graph(G), nodes=False)
    blocks = gpd.GeoDataFrame(geometry=list(polygonize(edges.geometry.union_all())), crs=edges.crs)
    blocks = blocks[(blocks.area > 200) & (blocks.area < 4e5)]
    blocks["area_ha"] = blocks.area / 1e4
    blocks["elongation"] = momepy.elongation(blocks)
    blocks["rectangularity"] = momepy.rectangularity(blocks)
    blocks[["area_ha", "elongation", "rectangularity"]].describe().to_json(out_path)
    print(f"  momepy block summary -> {out_path}")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--id")
    ap.add_argument("--all", action="store_true")
    ap.add_argument("--place")
    ap.add_argument("--graphml")
    ap.add_argument("--center", nargs=2, type=float, metavar=("LAT", "LON"))
    ap.add_argument("--window", type=float, metavar="KM")
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--momepy", action="store_true")
    args = ap.parse_args()

    with open(CORPUS, encoding="utf-8") as f:
        corpus = {c["id"]: c for c in json.load(f)["cities"]}
    ids = list(corpus) if args.all else [args.id]
    if not args.all and not args.id:
        sys.exit("Need --id (and --place or --graphml for a city outside the corpus), or --all")
    os.makedirs(OUT_DIR, exist_ok=True)
    for cid in ids:
        entry = corpus.get(cid, {})
        name = entry.get("name", cid)
        print(f"{name}: downloading ...")
        G, how = load_graph(args, entry)                             # 1. download
        net = to_network(G, name, how)
        for key in ("archetype", "country"):
            if entry.get(key):
                net[key] = entry[key]
        path = os.path.join(OUT_DIR, f"{cid}.network.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(net, f, separators=(",", ":"))                # 4. save
        print(f"  {len(net['nodes'])} nodes, {len(net['edges'])} streets -> {path}")
        if args.check:
            cross_check(G)
        if args.momepy:
            momepy_blocks(G, os.path.join(OUT_DIR, f"{cid}.momepy-blocks.json"))
    print("Next: node scripts/realism.mjs reference reference/networks/<id>.network.json")


if __name__ == "__main__":
    main()
