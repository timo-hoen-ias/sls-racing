# Builds the visible parts of the road bridges on top of the map pipeline's decks: parapets with steel railings,
# edge fascias and piers. One GLB per bridge in public/models/landmarks/bruecke-<way id>.glb.
# Run after "npm run world:build" (needs public/tiles/bridges.json) and "node tools/landmark-footprints.ts":
#   blender --background --factory-startup --python tools/blender/make_bridges.py
#
# Rules from the pipeline (it owns deck, ramps and collision): nothing above the deck within halfWidth
# (the collision deck, already including 0.5 m); railings may only collide outside it; piers stay below
# deck - 1 m. Model space: origin on the deck centreline at the manifest's (e, n), y relative to the deck top
# there (manifest y = its absolute height); +X east, -Z north like the landmarks.
import bpy, bmesh, json, math, os, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import MATS, empty, export, pbr, tris

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
OUT_DIR = os.path.join(ROOT, 'public', 'models', 'landmarks')
MANIFEST = json.load(open(os.path.join(ROOT, 'pipeline', 'landmarks.json')))
BRIDGES = {b['id']: b for b in json.load(open(os.path.join(ROOT, 'public', 'tiles', 'bridges.json')))['bridges']}

PARAPET = 0.45      # width of the concrete parapet beyond the collision deck
PIER_DEPTH = 14.0   # piers reach this far below the deck (hidden in the ground or the river bed)


def materials():
    pbr('plaster', 0xa9a59c, 0.0, 0.9)           # concrete
    pbr('plaster.dark', 0x7d7a73, 0.0, 0.9)
    pbr('stone', 0xb9a58a, 0.0, 0.85)            # sandstone piers of older bridges
    pbr('copper', 0x4a5156, 0.6, 0.45)           # steel railing (painted)


class Mesh:
    def __init__(self, mats):
        self.bm = bmesh.new()
        self.mats = mats

    def quad(self, a, b, c, d, mat):
        f = self.bm.faces.new([self.bm.verts.new(v) for v in (a, b, c, d)])
        f.material_index = self.mats.index(mat)

    def box(self, mat, centre, along, across, sx, sz, y0, y1):
        """Box centred on centre (x, z) with x along `along`, z along `across` (both unit 2D vectors)."""
        c = Vector(centre)
        hx, hz = sx / 2, sz / 2
        corners = [c + along * dx + across * dz for dx, dz in ((-hx, -hz), (hx, -hz), (hx, hz), (-hx, hz))]
        lo = [Vector((p.x, p.y, y0)) for p in corners]
        hi = [Vector((p.x, p.y, y1)) for p in corners]
        for i in range(4):
            j = (i + 1) % 4
            self.quad(lo[i], lo[j], hi[j], hi[i], mat)
        self.quad(*reversed(lo), mat)
        self.quad(*hi, mat)

    def column(self, mat, centre, r, y0, y1, seg=10):
        res = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=y1 - y0)
        bmesh.ops.translate(self.bm, vec=(centre[0], centre[1], (y0 + y1) / 2), verts=res['verts'])
        for f in {f for v in res['verts'] for f in v.link_faces}:
            f.material_index = self.mats.index(mat)

    def finish(self, name, parent):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-4)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        for m in self.mats:
            me.materials.append(MATS[m])
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent
        return ob


def centreline(bridge, entry):
    """Local polyline [(Vector(x, north), y)] in Blender coordinates (X east, Y north, Z up)."""
    p = bridge['pts']
    pts = [(Vector((p[i] - entry['e'], p[i + 1] - entry['n'])), p[i + 2] - entry['y']) for i in range(0, len(p), 3)]
    return pts


def frames(pts):
    """Per point: position, unit tangent, unit left normal (all 2D) and deck height."""
    out = []
    n = len(pts)
    for i, (q, y) in enumerate(pts):
        a = pts[max(0, i - 1)][0]
        b = pts[min(n - 1, i + 1)][0]
        t = (b - a).normalized()
        out.append((q, t, Vector((-t.y, t.x)), y))
    return out


def ribbon(m, fr, off0, off1, y0, y1, mat, side):
    """Closed strip along the bridge between lateral offsets off0..off1 (m) and heights y0..y1 above the deck."""
    for (qa, ta, na, ya), (qb, tb, nb, yb) in zip(fr, fr[1:]):
        def corner(q, n, y, off, h):
            v = q + n * (off * side)
            return Vector((v.x, v.y, y + h))
        for (o_a, h_a), (o_b, h_b) in (((off0, y1), (off1, y1)), ((off1, y1), (off1, y0)), ((off1, y0), (off0, y0)), ((off0, y0), (off0, y1))):
            m.quad(corner(qa, na, ya, o_a, h_a), corner(qa, na, ya, o_b, h_b), corner(qb, nb, yb, o_b, h_b), corner(qb, nb, yb, o_a, h_a), mat)
    # End caps.
    for q, t, n, y in (fr[0], fr[-1]):
        a = [Vector(((q + n * (o * side)).x, (q + n * (o * side)).y, y + h)) for o, h in ((off0, y0), (off1, y0), (off1, y1), (off0, y1))]
        m.quad(*a, mat)


def build_bridge(entry, lod):
    bridge = BRIDGES[entry['bridge']]
    hw = bridge['halfWidth']
    fr = frames(centreline(bridge, entry))
    length = sum((b[0] - a[0]).length for a, b in zip(fr, fr[1:]))
    m = Mesh(['plaster', 'plaster.dark', 'stone', 'copper'])
    for side in (1, -1):
        ribbon(m, fr, hw, hw + PARAPET, -1.25, 0.35, 'plaster', side)                    # parapet + fascia
        if lod == 0:
            ribbon(m, fr, hw + PARAPET - 0.02, hw + PARAPET + 0.04, -1.3, -0.95, 'plaster.dark', side)  # drip edge
            ribbon(m, fr, hw + 0.15, hw + 0.22, 1.02, 1.1, 'copper', side)                 # handrail
            ribbon(m, fr, hw + 0.17, hw + 0.2, 0.62, 0.66, 'copper', side)                 # middle rail
            # Posts every 2 m.
            s, nxt = 0.0, 1.0
            for (qa, ta, na, ya), (qb, tb, nb, yb) in zip(fr, fr[1:]):
                seg = (qb - qa).length
                while nxt <= s + seg:
                    k = (nxt - s) / seg
                    q = qa.lerp(qb, k) + na * ((hw + 0.18) * side)
                    y = ya + (yb - ya) * k
                    m.box('copper', (q.x, q.y), ta, na, 0.06, 0.06, y + 0.35, y + 1.1)
                    nxt += 2.0
                s += seg
    # Piers: every ~30 m, not within 12 m of the ends (abutments are terrain); twin columns under a cap beam.
    if length > 40:
        k = max(1, int((length - 24) // 30))
        targets = [12 + (length - 24) * (i + 0.5) / k for i in range(k)]
        s = 0.0
        for (qa, ta, na, ya), (qb, tb, nb, yb) in zip(fr, fr[1:]):
            seg = (qb - qa).length
            for d in [t for t in targets if s <= t < s + seg]:
                kk = (d - s) / seg
                q = qa.lerp(qb, kk)
                y = ya + (yb - ya) * kk
                m.box('plaster.dark', (q.x, q.y), na, ta, 2 * hw + 0.6, 1.4, y - 2.0, y - 1.25)   # cap beam
                for off in ((-hw * 0.5, hw * 0.5) if hw > 4 else (0.0,)):
                    m.column('plaster', q + na * off, 0.7 if lod == 0 else 0.75, y - PIER_DEPTH, y - 2.0, 12 if lod == 0 else 6)
            s += seg
    return m


def build_collider(entry):
    bridge = BRIDGES[entry['bridge']]
    hw = bridge['halfWidth']
    fr = frames(centreline(bridge, entry))
    fr = fr[::5] + ([fr[-1]] if (len(fr) - 1) % 5 else [])           # 20 m segments are plenty for a wall
    m = Mesh(['plaster', 'plaster.dark', 'stone', 'copper'])
    for side in (1, -1):
        # Only outside the collision deck: parapet and railing as one thin wall.
        ribbon(m, fr, hw + 0.05, hw + PARAPET, -0.2, 1.1, 'plaster', side)
    return m


def build_one(entry):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()
    materials()
    root = empty(entry['id'], None)
    obs = [build_bridge(entry, lod).finish(f"{entry['id']}_lod{lod}", root) for lod in (0, 1)]
    obs.append(build_collider(entry).finish(f"{entry['id']}_collider", root))
    for ob in obs:
        print(f"  {ob.name:28s} {tris(ob):6d} Dreiecke")
    export(root, os.path.join(OUT_DIR, entry['id'] + '.raw.glb'))


if __name__ == '__main__':
    for entry in MANIFEST:
        if 'bridge' in entry and entry['bridge'] in BRIDGES:
            build_one(entry)
