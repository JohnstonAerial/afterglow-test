#!/usr/bin/env python3
"""Afterglow satellite cloud grid.

Reads the newest GOES-19 ABI L2 Cloud Cover Layers file for CONUS (NOAA public
storage, bucket noaa-goes19, product ABI-L2-CCLC) and averages it onto a
0.25 degree lat/lon grid. Writes a small JSON file the app can sample along the
sun's direction.

Layers (each 0-100 percent, 255 = no data):
  low  = max(CF1, CF2)  surface to 10,000 ft
  mid  = CF3            10,000 to 18,000 ft
  high = CF4            18,000 to 24,000 ft
  top  = CF5            24,000 ft and up
NOAA labels this product beta. Usage: sat_grid.py OUT.json
"""
import base64, datetime as dt, json, sys, urllib.request, xml.etree.ElementTree as ET
import numpy as np, netCDF4

BUCKET = "https://noaa-goes19.s3.amazonaws.com"
PRODUCT = "ABI-L2-CCLC"
LAT0, LAT1, LON0, LON1, STEP = 14.0, 57.0, -153.0, -52.0, 0.25
NS = "{http://s3.amazonaws.com/doc/2006-03-01/}"

def newest_key():
    now = dt.datetime.now(dt.timezone.utc)
    for back in range(0, 4):  # this hour, then up to 3 hours back
        t = now - dt.timedelta(hours=back)
        prefix = f"{PRODUCT}/{t:%Y}/{t:%j}/{t:%H}/"
        with urllib.request.urlopen(f"{BUCKET}/?list-type=2&prefix={prefix}", timeout=60) as r:
            root = ET.fromstring(r.read())
        keys = sorted(e.text for e in root.iter(NS + "Key") if e.text.endswith(".nc"))
        if keys:
            return keys[-1]
    raise SystemExit("no CCL file in the last 4 hours")

def pixel_latlon(ds):
    """GOES fixed grid (scan angles) to geodetic lat/lon, per NOAA PUG 4.2.8."""
    p = ds.variables["goes_imager_projection"]
    req, rpol = p.semi_major_axis, p.semi_minor_axis
    H = p.perspective_point_height + req
    lon0 = np.radians(p.longitude_of_projection_origin)
    x = ds.variables["x"][:].astype("f8"); y = ds.variables["y"][:].astype("f8")
    x, y = np.meshgrid(x, y)
    a = np.sin(x)**2 + np.cos(x)**2 * (np.cos(y)**2 + (req**2 / rpol**2) * np.sin(y)**2)
    b = -2 * H * np.cos(x) * np.cos(y)
    c = H**2 - req**2
    disc = b**2 - 4 * a * c
    with np.errstate(invalid="ignore"):
        rs = (-b - np.sqrt(disc)) / (2 * a)
        sx = rs * np.cos(x) * np.cos(y); sy = -rs * np.sin(x); sz = rs * np.cos(x) * np.sin(y)
        lat = np.degrees(np.arctan((req**2 / rpol**2) * sz / np.sqrt((H - sx)**2 + sy**2)))
        lon = np.degrees(lon0 - np.arctan(sy / (H - sx)))
    bad = disc < 0
    lat[bad] = np.nan; lon[bad] = np.nan
    return lat, lon

def layer(ds, name):
    v = ds.variables[name][:]
    return np.ma.filled(v.astype("f8"), np.nan)

def main(out):
    key = newest_key()
    raw = urllib.request.urlopen(f"{BUCKET}/{key}", timeout=120).read()
    ds = netCDF4.Dataset("ccl", memory=raw)
    lat, lon = pixel_latlon(ds)
    cf = {k: layer(ds, k) for k in ("CF1", "CF2", "CF3", "CF4", "CF5")}
    fields = {
        "low": np.fmax(cf["CF1"], cf["CF2"]),
        "mid": cf["CF3"], "high": cf["CF4"], "top": cf["CF5"],
    }
    nlat = int(round((LAT1 - LAT0) / STEP)); nlon = int(round((LON1 - LON0) / STEP))
    ok = np.isfinite(lat) & np.isfinite(lon)
    i = np.floor((lat - LAT0) / STEP); j = np.floor((lon - LON0) / STEP)
    ok &= (i >= 0) & (i < nlat) & (j >= 0) & (j < nlon)
    cell = (i[ok].astype(int) * nlon + j[ok].astype(int))
    layers = {}
    for name, f in fields.items():
        vals = f[ok]
        good = np.isfinite(vals)
        s = np.bincount(cell[good], weights=vals[good], minlength=nlat * nlon)
        n = np.bincount(cell[good], minlength=nlat * nlon)
        pct = np.full(nlat * nlon, 255, dtype=np.uint8)
        has = n > 0
        pct[has] = np.clip(np.rint(100 * s[has] / n[has]), 0, 100).astype(np.uint8)
        layers[name] = base64.b64encode(pct.tobytes()).decode("ascii")
    t = ds.variables["t"][:].item()
    scan = dt.datetime(2000, 1, 1, 12, tzinfo=dt.timezone.utc) + dt.timedelta(seconds=float(t))
    doc = {
        "v": 1, "source": "GOES-19 ABI L2 Cloud Cover Layers (CONUS, NOAA beta)",
        "file": key.rsplit("/", 1)[-1], "scan": scan.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "made": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "grid": {"lat0": LAT0, "lon0": LON0, "step": STEP, "nlat": nlat, "nlon": nlon,
                 "order": "row-major from south-west; row = lat, col = lon; cell covers [lat0+i*step, +step)"},
        "layers": layers,
        "note": "percent 0-100, 255 = no data; low = surface-10k ft, mid = 10-18k, high = 18-24k, top = 24k+ ft",
    }
    with open(out, "w") as fh:
        json.dump(doc, fh, separators=(",", ":"))
    print(key, doc["scan"], {k: len(v) for k, v in layers.items()})

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "latest.json")
