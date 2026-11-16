#!/bin/sh
# Convert the Tbilisi parking bays (ESRI shapefile, UTM 38N) to data/parking.geojson for the route cleaner.
#   sh tools/build_parking.sh [path/to/parking_09.shp]
# Needs GDAL (ogr2ogr). The default source is the sibling repo Tbilisi-Parking-Study.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
src=${1:-"$here/../Tbilisi-Parking-Study/Parking_Database/parking_09.shp"}
out="$here/data/parking.geojson"
[ -f "$src" ] || { echo "shapefile not found: $src" >&2; exit 1; }
rm -f "$out"
ogr2ogr -f GeoJSON -t_srs EPSG:4326 -lco COORDINATE_PRECISION=6 -lco WRITE_BBOX=NO \
  -dialect sqlite -sql "SELECT geometry, COALESCE(ZONE_CODE, '#' || CAST(OBJECTID AS TEXT)) AS id, PARKIREBIS AS addr, ZONE_ID AS zone, MANQANIS_A AS cars,
    SSM_ADGILI AS disabled, CAST(TAXI_ADGIL AS INTEGER) AS taxi, EL_DAMTENI AS ev, PARKING_TY AS type,
    DGOMIS_GRA AS layout, DGOMIS_MET AS method, FASI AS paid, SENISVNA AS note, SIITI_NOME AS list FROM parking_09" \
  "$out" "$src"
n=$(grep -o '"type": "Feature"' "$out" | wc -l | tr -d ' ')
echo "wrote $out: $n bays, $(du -h "$out" | cut -f1)"
