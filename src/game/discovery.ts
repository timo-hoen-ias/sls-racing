// Discovering the town (W5): every spot belongs to the nearest district (OSM place nodes, districts.json from
// the pipeline); driving into one for the first time reveals it on the map and pays a little. Viewpoints at
// the landmarks count the same once the car stops close by.

export interface District { name: string; x: number; z: number }
export interface Viewpoint { id: string; name: string; x: number; z: number; radius: number }

export const DISTRICT_REWARD = { xp: 300, credits: 1000 };
export const VIEWPOINT_REWARD = { xp: 150, credits: 400 };
/** Districts further than this from the car's spot do not count (outside the town). */
const MAX_DIST = 2500;

export class Discovery {
  districts: District[] = [];
  viewpoints: Viewpoint[] = [];
  /** Ids found ("district:Roden", "view:rathaus"), shared with the save. */
  found: Set<string>;
  onDistrict?: (d: District, count: number, total: number) => void;
  onViewpoint?: (v: Viewpoint, count: number, total: number) => void;
  private current?: District;

  constructor(found: string[] = []) {
    this.found = new Set(found);
  }

  /** The district the spot belongs to, if any lies close enough. */
  at(x: number, z: number) {
    let best: District | undefined, bd = MAX_DIST;
    for (const d of this.districts) {
      const dist = Math.hypot(d.x - x, d.z - z);
      if (dist < bd) { bd = dist; best = d; }
    }
    return best;
  }

  get districtsFound() { return this.districts.filter((d) => this.found.has(`district:${d.name}`)).length; }
  get viewpointsFound() { return this.viewpoints.filter((v) => this.found.has(`view:${v.id}`)).length; }

  update(x: number, z: number, speed: number) {
    const d = this.at(x, z);
    if (d !== this.current) {
      this.current = d;
      if (d && !this.found.has(`district:${d.name}`)) {
        this.found.add(`district:${d.name}`);
        this.onDistrict?.(d, this.districtsFound, this.districts.length);
      }
    }
    // Viewpoints: slow down next to the landmark.
    if (speed > 8) return;
    for (const v of this.viewpoints) {
      if (this.found.has(`view:${v.id}`) || Math.hypot(v.x - x, v.z - z) > v.radius + 25) continue;
      this.found.add(`view:${v.id}`);
      this.onViewpoint?.(v, this.viewpointsFound, this.viewpoints.length);
    }
  }
}
