// Which OSM features the pipeline reads. The PBF cut (pbf.ts) and the Overpass query (fetch.ts) keep these;
// readOsm (osm.ts) sorts them into the road-side data (ways, polygons, points) and the extra features that
// only their own modules read (osm.extra: railways, power lines, sports grounds …), so the road modules,
// which loop over all ways, see the same input as before.

type Tags = Record<string, string>;

/** Ways the road, building, ground and barrier code reads (the original set). */
export function coreWay(tags: Tags): boolean {
  return !!(
    tags.highway || tags.building || tags.landuse ||
    /^(water|wood|scrub|grassland)$/.test(tags.natural ?? '') ||
    tags.waterway === 'riverbank' ||
    /^(river|stream|canal|ditch|drain)$/.test(tags.waterway ?? '') ||
    /^(park|pitch|garden|playground)$/.test(tags.leisure ?? '') ||
    tags.amenity === 'parking' || tags.amenity === 'fuel' ||
    /^(fence|wall|hedge|guard_rail)$/.test(tags.barrier ?? '')
  );
}

/** Railway lines with track on the ground (not abandoned or razed ones). */
export const isTrack = (t: Tags) => /^(rail|light_rail|narrow_gauge|tram|disused|preserved)$/.test(t.railway ?? '');

/** Ways and areas read by the detail modules only (railways, power, sports, industry, water structures …). */
export function extraWay(t: Tags): boolean {
  return !!(
    isTrack(t) || t.railway === 'platform' ||
    /^(line|minor_line|substation|generator|plant)$/.test(t.power ?? '') ||
    /^(tree_row|heath|wetland)$/.test(t.natural ?? '') ||
    /^(retaining_wall|gate)$/.test(t.barrier ?? '') ||
    /^(parking_space|school|kindergarten|fountain|shelter|fire_station|police|townhall|post_office|hospital)$/.test(t.amenity ?? '') ||
    /^(swimming_pool|sports_centre|track|stadium|water_park)$/.test(t.leisure ?? '') ||
    /^(pier|goods_conveyor|pipeline|storage_tank|chimney|works|tower|silo|water_tower|bridge)$/.test(t.man_made ?? '') ||
    t['area:highway'] === 'traffic_island' || !!t.traffic_calming ||
    /^(weir|dam|lock_gate)$/.test(t.waterway ?? '') ||
    t.aeroway === 'helipad' || t.parking === 'multi-storey' || t.parking === 'underground'
  );
}

export const wantedWay = (t: Tags) => coreWay(t) || extraWay(t);

/** Point features: trees, street furniture, rail and power structures, shops and other places. */
export function wantedNode(t: Tags | undefined): boolean {
  if (!t) return false;
  return !!(
    t.natural === 'tree' ||
    /^(traffic_signals|stop|give_way|bus_stop|street_lamp|crossing|motorway_junction|turning_circle|turning_loop|mini_roundabout|speed_camera|traffic_mirror)$/.test(t.highway ?? '') ||
    !!t.kerb || !!t.traffic_calming || !!t.traffic_sign ||
    /^(city|town|village|suburb|quarter|hamlet)$/.test(t.place ?? '') ||
    /^(bollard|block|gate|lift_gate|swing_gate|cycle_barrier)$/.test(t.barrier ?? '') ||
    /^(bench|waste_basket|post_box|bicycle_parking|telephone|vending_machine|recycling|fuel|charging_station|fountain|hunting_stand|shelter|toilets|parcel_locker|drinking_water)$/.test(t.amenity ?? '') ||
    // Shop fronts (shops.ts): shops and the amenities that have one.
    (!!t.shop && t.shop !== 'no' && t.shop !== 'vacant') ||
    /^(cafe|restaurant|fast_food|bar|pub|biergarten|ice_cream|pharmacy|bank)$/.test(t.amenity ?? '') ||
    /^(fire_hydrant|phone)$/.test(t.emergency ?? '') ||
    /^(column|billboard|poster_box)$/.test(t.advertising ?? '') ||
    /^(level_crossing|crossing|signal|switch|buffer_stop)$/.test(t.railway ?? '') ||
    /^(tower|pole|portal|transformer|generator)$/.test(t.power ?? '') ||
    /^(street_cabinet|surveillance|flagpole|chimney|mast|tower|water_tower|storage_tank)$/.test(t.man_made ?? '') ||
    /^(information|artwork|picnic_site)$/.test(t.tourism ?? '') ||
    /^(picnic_table|playground|swimming_pool)$/.test(t.leisure ?? '') ||
    (/^(memorial|wayside_cross|wayside_shrine|monument|boundary_stone)$/.test(t.historic ?? '') && t.memorial !== 'stolperstein') ||
    t.military === 'bunker' || t.aeroway === 'helipad' || t.waterway === 'weir'
  );
}

/** Relations: buildings, multipolygon areas, turn restrictions and bus routes. */
export function wantedRelation(t: Tags): boolean {
  if (t.building) return true;
  if (t.type === 'restriction') return /^(no|only)_/.test(t.restriction ?? '');
  if (t.type === 'route') return t.route === 'bus';
  return t.type === 'multipolygon' && (!!t.landuse || t.amenity === 'fuel' || /^(water|wood)$/.test(t.natural ?? '') || extraWay(t));
}
