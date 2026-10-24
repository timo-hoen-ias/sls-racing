# Builds Saarlouis landmarks and exports one GLB per landmark to public/models/landmarks/<id>.glb.
# Run: blender --background --factory-startup --python tools/blender/make_landmarks.py -- [out_dir] [id ...]
# Then compress: npm run models:build (see package.json).
#
# Footprints come from pipeline/landmarks.json (UTM 32N, written by tools/landmark-footprints.ts from OSM).
# Model space (spec of the map pipeline): metres, glTF +Y up, +X east, -Z north; origin = footprint centroid
# at ground level; the base reaches 1 m below ground. In Blender that is X east, Y north, Z up.
# Each GLB holds <id>_lod0, <id>_lod1 (no windows or small ornaments) and <id>_collider (a few hundred triangles at most).
# Material names start with stone, plaster, roof, slate, copper, glass or wood (the game maps them by prefix).
# Heights are estimates from photos until the LoD2 data is in; the footprint is exact.
import bpy, bmesh, json, math, os, sys
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import MATS, empty, export, pbr, tris

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.join(HERE, '..', '..')
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT_DIR = os.path.abspath(args[0]) if args else os.path.join(ROOT, 'public', 'models', 'landmarks')
ONLY = set(args[1:])
MANIFEST = json.load(open(os.path.join(ROOT, 'pipeline', 'landmarks.json')))


def materials():
    pbr('stone', 0xb9a58a, 0.0, 0.85)          # sandstone
    pbr('stone.dark', 0x3a3530, 0.0, 0.9)      # deep recesses, louvres
    pbr('stone.light', 0xd8cdb8, 0.0, 0.8)     # light ashlar (town hall)
    pbr('plaster', 0xd9d6cf, 0.0, 0.9)         # concrete and render
    pbr('plaster.white', 0xf1efe9, 0.0, 0.8)
    pbr('roof', 0xc8c8c4, 0.1, 0.6)            # light folded roof
    pbr('slate', 0x3d434a, 0.1, 0.6)
    pbr('copper', 0x5f8f7a, 0.6, 0.5)          # patina
    pbr('glass', 0x1d2a35, 0.3, 0.1)
    pbr('wood', 0x5a3d26, 0.0, 0.8)
    pbr('stone.red', 0x9a4a3a, 0.0, 0.85)       # red sandstone (Kommandantur)
    pbr('roof.grass', 0x5f7a3a, 0.0, 0.95)     # grassed rampart (Kasematten)


class Frame:
    """Builds in a building's own axes: u along `bearing` (deg from north), v 90° clockwise of it, h up.
    Collects geometry into one bmesh in Blender coordinates (X east, Y north, Z up)."""

    def __init__(self, bearing, mats, detail=True):
        # detail=False (LOD 1) drops windows, recesses and small ornaments.
        self.detail = detail
        b = math.radians(bearing)
        self.U = Vector((math.sin(b), math.cos(b), 0))
        self.V = Vector((math.sin(b + math.pi / 2), math.cos(b + math.pi / 2), 0))
        self.yaw = -b
        self.bm = bmesh.new()
        self.mats = list(mats)

    def p(self, u, v, h=0.0):
        return self.U * u + self.V * v + Vector((0, 0, h))

    def _mat(self, verts, mat):
        i = self.mats.index(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = i

    def box(self, mat, u0, u1, v0, v1, h0, h1, turn=0.0):
        """Axis-aligned box in (u, v), optionally turned about its centre (rad)."""
        before = set(self.bm.verts)
        v = bmesh.ops.create_cube(self.bm, size=1)['verts']
        bmesh.ops.scale(self.bm, vec=(v1 - v0, u1 - u0, h1 - h0), verts=v)
        m = Matrix.Translation(self.p((u0 + u1) / 2, (v0 + v1) / 2, (h0 + h1) / 2)) @ Matrix.Rotation(self.yaw - turn, 4, 'Z')
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self._mat([x for x in self.bm.verts if x not in before], mat)

    def spire(self, mat, u, v, h0, h1, r, seg=8, r_top=0.0):
        before = set(self.bm.verts)
        verts = bmesh.ops.create_cone(self.bm, cap_ends=True, segments=seg, radius1=r, radius2=r_top, depth=h1 - h0)['verts']
        m = Matrix.Translation(self.p(u, v, (h0 + h1) / 2)) @ Matrix.Rotation(self.yaw + math.pi / seg, 4, 'Z')
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        self._mat([x for x in self.bm.verts if x not in before], mat)

    def pyramid(self, mat, u0, u1, v0, v1, h0, h1, ridge=0.0):
        """Hip roof over a rectangle (ridge = length of the ridge along the longer side, 0 = pyramid)."""
        bm = self.bm
        c = [bm.verts.new(self.p(u, v, h0)) for u, v in ((u0, v0), (u1, v0), (u1, v1), (u0, v1))]
        uc, vc = (u0 + u1) / 2, (v0 + v1) / 2
        if u1 - u0 >= v1 - v0:
            r = min(ridge, (u1 - u0) - (v1 - v0)) / 2
            t = [bm.verts.new(self.p(uc - r, vc, h1)), bm.verts.new(self.p(uc + r, vc, h1))]
            faces = [(c[0], c[1], t[1], t[0]), (c[1], c[2], t[1]), (c[2], c[3], t[0], t[1]), (c[3], c[0], t[0])]
        else:
            r = min(ridge, (v1 - v0) - (u1 - u0)) / 2
            t = [bm.verts.new(self.p(uc, vc - r, h1)), bm.verts.new(self.p(uc, vc + r, h1))]
            faces = [(c[0], c[1], t[0]), (c[1], c[2], t[1], t[0]), (c[2], c[3], t[1]), (c[3], c[0], t[0], t[1])]
        fs = [bm.faces.new(list(dict.fromkeys(f))) for f in faces] + [bm.faces.new(list(reversed(c)))]
        i = self.mats.index(mat)
        for f in fs:
            f.material_index = i

    def lancet(self, mat, side, along, at, w, h0, h1, depth=0.12, out=0.0):
        """Pointed (gothic) window on a wall facing `side` ('-u', '+u', '-v', '+v') at wall coordinate `at`."""
        if not self.detail:
            return
        point = w * 0.6
        for (a0, a1, b0, b1, turn) in ((along - w / 2, along + w / 2, h0, h1 - point, 0),):
            self.wall_box(mat, side, at, a0, a1, b0, b1, depth, out)
        # Pointed head: a square turned 45° about the wall normal, clipped by the wall.
        self.wall_diamond(mat, side, at, along, h1 - point, w / math.sqrt(2) * 0.98, depth, out)

    def wall_box(self, mat, side, at, a0, a1, h0, h1, depth, out=0.0):
        if not self.detail:
            return
        d0, d1 = (at - depth + out, at + out) if side[0] == '+' else (at - out, at + depth - out)
        if side[1] == 'u':
            self.box(mat, d0, d1, a0, a1, h0, h1)
        else:
            self.box(mat, a0, a1, d0, d1, h0, h1)

    def wall_diamond(self, mat, side, at, along, h, s, depth, out=0.0):
        before = set(self.bm.verts)
        v = bmesh.ops.create_cube(self.bm, size=1)['verts']
        d = (at - depth / 2 + out) if side[0] == '+' else (at + depth / 2 - out)
        if side[1] == 'u':
            bmesh.ops.scale(self.bm, vec=(s, depth, s), verts=v)
            rot = Matrix.Rotation(math.pi / 4, 4, 'Y')
            pos = self.p(d, along, h)
        else:
            bmesh.ops.scale(self.bm, vec=(depth, s, s), verts=v)
            rot = Matrix.Rotation(math.pi / 4, 4, 'X')
            pos = self.p(along, d, h)
        m = Matrix.Translation(pos) @ Matrix.Rotation(self.yaw, 4, 'Z') @ rot
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self._mat([x for x in self.bm.verts if x not in before], mat)

    def prism(self, mat, pts, h0, h1):
        """Vertical prism over a polygon given in Blender (east, north)."""
        bm = self.bm
        lo = [bm.verts.new((x, y, h0)) for x, y in pts]
        hi = [bm.verts.new((x, y, h1)) for x, y in pts]
        fs = [bm.faces.new(list(reversed(lo))), bm.faces.new(hi)]
        n = len(pts)
        for i in range(n):
            j = (i + 1) % n
            fs.append(bm.faces.new((lo[i], lo[j], hi[j], hi[i])))
        i = self.mats.index(mat)
        for f in fs:
            f.material_index = i

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
        for p in me.polygons:
            p.use_smooth = False
        return ob


def local_footprint(entry):
    return [(e - entry['e'], n - entry['n']) for e, n in entry['footprint']]


ALL_MATS = ['stone', 'stone.dark', 'stone.light', 'stone.red', 'plaster', 'plaster.white', 'roof', 'roof.grass', 'slate', 'copper', 'glass', 'wood']


# ---------------------------------------------------------------- St. Ludwig

def ludwigskirche(entry, root, lod):
    """Neo-Gothic sandstone west front (central tower with stone spire, two corner turrets, three portals)
    in front of Gottfried Böhm's 1960s concrete nave with its folded roof. Front faces south-west (-u)."""
    f = Frame(49, ALL_MATS, detail=lod == 0)
    fp = local_footprint(entry)
    # Böhm's nave: the whole footprint in concrete, folded roof in three peaks.
    f.prism('plaster', fp, -1.0, 13.0)
    for u0, u1, v0, v1, top in ((-19.2, 1.5, -8.4, 12.6, 19.5), (1.5, 13.1, -13.7, 12.6, 19.5), (13.1, 25.9, -9.4, 6.3, 19.5), (13.1, 22.9, -13.5, -9.4, 15.5)):
        f.pyramid('roof', u0 - 0.3, u1 + 0.3, v0 - 0.3, v1 + 0.3, 13.0, top)
    for u in (-12.0, -4.0, 7.0, 19.0):
        for side, at in (('-v', -8.4 if u < 1.5 else -13.7 if u < 13.1 else -13.5), ('+v', 12.6 if u < 13.1 else 6.3)):
            f.wall_box('glass', side, at, u - 0.6, u + 0.6, 3.0, 11.5, 0.1, out=0.05)

    # West front: u -27.7 .. -19.2, v -8.1 .. 6.9.
    U0, U1, V0, V1 = -27.7, -19.2, -8.1, 6.9
    f.box('stone', U0, U1, V0, V1, -1.0, 15.0)
    f.box('stone', U0 - 0.2, U1, V0 - 0.2, V1 + 0.2, 14.6, 15.0)                       # cornice
    for i in range(14 if f.detail else 0):                                              # balustrade posts
        v = V0 + 0.6 + i * (V1 - V0 - 1.2) / 13
        f.box('stone', U0 - 0.1, U0 + 0.2, v - 0.12, v + 0.12, 15.0, 15.9)
    f.box('stone', U0 - 0.15, U1, V0, V1, 15.9, 16.1)
    for v in (-4.6, -0.6, 3.4):                                                          # three portals
        f.lancet('stone.dark', '-u', v, U0, 2.6, 0.0, 5.8, depth=0.3, out=0.03)
        f.lancet('glass', '-u', v, U0, 1.4, 7.4, 12.0, depth=0.1, out=0.04)
    for v in (V0 + 0.35, -2.75, 1.55, V1 - 0.35) if f.detail else ():                   # buttresses
        f.box('stone', U0 - 0.5, U0 + 0.2, v - 0.35, v + 0.35, -1.0, 13.5)
        f.spire('stone', U0 - 0.15, v, 13.5, 15.4, 0.4, seg=4)

    # Central tower (5.6 m square) with belfry, clock and octagonal stone spire.
    tv, tu0, tu1, s = -0.6, -27.9, -22.3, 2.8
    f.box('stone', tu0, tu1, tv - s, tv + s, 14.0, 36.0)
    for du in (tu0, tu1):
        for dv in (tv - s, tv + s):
            f.box('stone', du - 0.35, du + 0.35, dv - 0.35, dv + 0.35, 14.0, 34.0)           # corner buttresses
            f.spire('stone', du, dv, 34.0, 38.5, 0.45, seg=4)
    tu = (tu0 + tu1) / 2
    for side, at, along in (('-u', tu0, tv), ('+u', tu1, tv), ('-v', tv - s, tu), ('+v', tv + s, tu)):
        for k in (-1, 1):
            f.lancet('stone.dark', side, along + k * 0.85, at, 1.1, 27.0, 33.0, depth=0.3, out=0.03)
        f.lancet('glass', side, along, at, 1.2, 17.5, 22.5, depth=0.08, out=0.04)
    f.wall_box('plaster.white', '-u', tu0, tv - 0.8, tv + 0.8, 23.6, 25.2, 0.08, out=0.06)  # clock face
    f.wall_box('copper', '-u', tu0, tv - 0.05, tv + 0.05, 24.2, 25.0, 0.04, out=0.1)
    f.box('stone', tu0 - 0.3, tu1 + 0.3, tv - s - 0.3, tv + s + 0.3, 35.6, 36.2)         # cornice
    f.spire('stone', tu, tv, 36.0, 58.0, 3.0)
    for k in range(8 if f.detail else 0):                                                 # gablets at the spire foot
        a = 2 * math.pi * k / 8 + math.pi / 8
        f.spire('stone', tu + math.cos(a) * 2.5, tv + math.sin(a) * 2.5, 36.0, 39.0, 0.5, seg=4)
    f.box('copper', tu - 0.06, tu + 0.06, tv - 0.06, tv + 0.06, 58.0, 60.2)              # cross
    f.box('copper', tu - 0.06, tu + 0.06, tv - 0.55, tv + 0.55, 59.2, 59.35)

    # Corner turrets with stone spires.
    for v in (V0 + 1.2, V1 - 1.2):
        f.box('stone', U0 - 0.1, U0 + 2.3, v - 1.2, v + 1.2, -1.0, 19.0)
        f.box('stone', U0 - 0.3, U0 + 2.5, v - 1.4, v + 1.4, 18.8, 19.3)
        f.lancet('glass', '-u', v, U0 - 0.1, 0.6, 16.0, 18.3, depth=0.08, out=0.04)
        f.spire('stone', U0 + 1.1, v, 19.3, 26.5, 1.45)
        f.box('copper', U0 + 1.05, U0 + 1.15, v - 0.05, v + 0.05, 26.5, 27.6)

    ob = f.finish(f'ludwigskirche_lod{lod}', root)
    if lod:
        return ob, None
    # Collider: footprint up to the nave roof, plus the tower shaft.
    c = Frame(49, ['stone'])
    c.prism('stone', fp, -1.0, 15.0)
    c.box('stone', tu0, tu1, tv - s, tv + s, 15.0, 36.0)
    c.spire('stone', tu, tv, 36.0, 58.0, 3.0, seg=4)
    return ob, c.finish('ludwigskirche_collider', root)


# ---------------------------------------------------------------- Rathaus

def windows(f, side, at, a0, a1, floors, spacing=3.1, w=1.3, h=1.9, mat='glass'):
    n = int((a1 - a0 - 1.0) // spacing)
    start = (a0 + a1) / 2 - (n - 1) * spacing / 2
    for fl in floors:
        for i in range(n):
            a = start + i * spacing
            f.wall_box(mat, side, at, a - w / 2, a + w / 2, fl, fl + h, 0.1, out=0.05)
            f.wall_box('stone.light', side, at, a - w / 2 - 0.12, a + w / 2 + 0.12, fl - 0.15, fl, 0.1, out=0.09)  # sill


def rathaus(entry, root, lod):
    """1950s town hall: light ashlar wings with a ground-floor arcade, four upper floors of punched windows,
    low hipped slate roofs and a square corner tower with an open fin-ringed belfry and clock."""
    f = Frame(49, ALL_MATS, detail=lod == 0)
    fp = local_footprint(entry)
    H = 17.0
    upper = [4.6, 7.9, 11.2, 14.5]
    # Wings in the building's axes (u along 49°, v along 139°), from the OSM footprint.
    wings = [(2.5, 15.2, -35.0, 18.8), (-32.7, 19.5, 18.8, 32.4), (-20.5, 2.6, -42.8, -35.0), (2.6, 16.4, -47.3, -35.0)]
    f.prism('stone.light', fp, -1.0, H)
    for u0, u1, v0, v1 in wings:
        f.box('stone.light', u0 - 0.25, u1 + 0.25, v0 - 0.25, v1 + 0.25, H - 0.4, H)    # eaves cornice
        f.pyramid('slate', u0 - 0.6, u1 + 0.6, v0 - 0.6, v1 + 0.6, H, H + 4.2, ridge=200)
    # Facades: windows on every outer wall, arcade on the ground floor.
    for side, at, a0, a1 in (('+u', 15.2, -35.0, 18.8), ('-u', 2.5, -35.0, 18.8),
                             ('+v', 32.4, -32.7, 19.5), ('-v', 18.8, -26.3, 2.5),
                             ('-v', -42.8, -20.5, 2.6), ('-v', -47.3, 2.6, 16.4), ('+u', 16.4, -47.3, -35.0), ('-u', -20.5, -42.8, -35.0),
                             ('+u', 19.5, 18.8, 32.4), ('-u', -32.7, 19.9, 32.4)):
        windows(f, side, at, a0 + 1.0, a1 - 1.0, upper)
        n = int((a1 - a0 - 2.0) // 3.1)
        start = (a0 + a1) / 2 - (n - 1) * 3.1 / 2
        for i in range(n):
            a = start + i * 3.1
            f.wall_box('stone.dark', side, at, a - 1.2, a + 1.2, 0.0, 3.4, 0.6)
    # Corner tower (u -35.2 .. -27.4, v 13.5 .. 19.9): solid shaft, open belfry ringed by white fins, clock.
    u0, u1, v0, v1 = -35.4, -27.4, 12.9, 20.1
    f.box('stone.light', u0, u1, v0, v1, -1.0, 24.0)
    f.box('stone.dark', u0 + 0.5, u1 - 0.5, v0 + 0.5, v1 - 0.5, 24.0, 32.0)
    for side in ('-u', '+u', '-v', '+v'):
        a0, a1 = (v0, v1) if side[1] == 'u' else (u0, u1)
        at = {'-u': u0, '+u': u1, '-v': v0, '+v': v1}[side]
        for i in range(9):
            a = a0 + 0.2 + i * (a1 - a0 - 0.4) / 8
            f.wall_box('plaster.white', side, at, a - 0.14, a + 0.14, 24.0, 32.0, 0.5)
        f.wall_box('plaster.white', side, at, (a0 + a1) / 2 - 1.1, (a0 + a1) / 2 + 1.1, 27.0, 29.2, 0.05, out=0.55)  # clock
        f.wall_box('copper', side, at, (a0 + a1) / 2 - 0.05, (a0 + a1) / 2 + 0.05, 27.6, 28.8, 0.05, out=0.6)
        windows(f, side, at, a0 + 0.5, a1 - 0.5, [4.6, 7.9, 11.2, 14.5, 17.8], spacing=2.6, w=1.0, h=1.7)
    f.box('plaster.white', u0 - 0.3, u1 + 0.3, v0 - 0.3, v1 + 0.3, 32.0, 32.6)
    f.pyramid('slate', u0 - 0.5, u1 + 0.5, v0 - 0.5, v1 + 0.5, 32.6, 34.6)
    f.box('copper', (u0 + u1) / 2 - 0.05, (u0 + u1) / 2 + 0.05, (v0 + v1) / 2 - 0.05, (v0 + v1) / 2 + 0.05, 34.6, 38.0)  # mast

    ob = f.finish(f'rathaus_lod{lod}', root)
    if lod:
        return ob, None
    c = Frame(49, ['stone'])
    c.prism('stone', fp, -1.0, H + 2.0)
    c.box('stone', u0, u1, v0, v1, H + 2.0, 34.0)
    return ob, c.finish('rathaus_collider', root)


# ---------------------------------------------------------------- generic footprint buildings

def ccw(pts):
    a = sum(x0 * y1 - x1 * y0 for (x0, y0), (x1, y1) in zip(pts, pts[1:] + pts[:1]))
    return pts if a > 0 else list(reversed(pts))


def offset(pts, d):
    """Miter offset of a counter-clockwise polygon (d > 0 grows it)."""
    out = []
    n = len(pts)
    for i in range(n):
        p0, p1, p2 = Vector(pts[i - 1]), Vector(pts[i]), Vector(pts[(i + 1) % n])
        e0, e1 = (p1 - p0).normalized(), (p2 - p1).normalized()
        n0, n1 = Vector((e0.y, -e0.x)), Vector((e1.y, -e1.x))
        m = (n0 + n1)
        m = m.normalized() if m.length > 0.2 else n1          # near-reversals: no long miter spikes
        k = max(-3 * abs(d), min(3 * abs(d), d / max(0.3, m.dot(n1))))
        q = p1 + m * k
        out.append((q.x, q.y))
    return out


def edges(pts, min_len=2.0):
    """(start, unit direction, outward normal, length) for every edge of a ccw polygon."""
    for a, b in zip(pts, pts[1:] + pts[:1]):
        a, b = Vector(a), Vector(b)
        L = (b - a).length
        if L >= min_len:
            d = (b - a) / L
            yield a, d, Vector((d.y, -d.x)), L


def obox(f, mat, c, d, sx, sy, h0, h1):
    """Box centred on c (east, north) with its x along direction d, sx along d, sy across."""
    before = set(f.bm.verts)
    v = bmesh.ops.create_cube(f.bm, size=1)['verts']
    bmesh.ops.scale(f.bm, vec=(sx, sy, h1 - h0), verts=v)
    m = Matrix.Translation((c[0], c[1], (h0 + h1) / 2)) @ Matrix.Rotation(math.atan2(d.y, d.x), 4, 'Z')
    bmesh.ops.transform(f.bm, matrix=m, verts=v)
    f._mat([x for x in f.bm.verts if x not in before], mat)


def facade(f, pts, floors, mat='glass', w=1.2, h=1.9, spacing=3.2, frame=None, arch=False, depth=0.12, min_len=4.0):
    """Windows evenly along every wall of the footprint, one row per floor height in `floors`."""
    if not f.detail:
        return
    for a, d, n, L in edges(pts, min_len):
        k = int((L - 1.2) // spacing)
        if k < 1:
            continue
        for i in range(k):
            s = (L - (k - 1) * spacing) / 2 + i * spacing
            c = a + d * s + n * 0.03
            for h0 in floors:
                if frame:
                    obox(f, frame, a + d * s + n * 0.05, d, w + 0.3, 0.1, h0 - 0.2, h0 + h + 0.2)
                obox(f, mat, c + n * (0.04 if frame else 0), d, w, depth, h0, h0 + h)
                if arch:
                    f.spire(mat, *(c + n * (0.04 if frame else 0)), h0 + h, h0 + h + w * 0.5, w * 0.5, seg=4) if False else None
                    obox(f, mat, c + n * (0.04 if frame else 0), d, w * 0.7, depth, h0 + h, h0 + h + w * 0.35)


def roof(f, mat, pts, h0, steps, gable_mat=None):
    """Roof from the footprint outline at h0: each step insets the top by `thick` and raises it by `rise`."""
    bm = f.bm
    face = bm.faces.new([bm.verts.new((x, y, h0)) for x, y in pts])
    face.normal_update()
    i = f.mats.index(mat)
    face.material_index = i
    x0, x1 = min(p[0] for p in pts), max(p[0] for p in pts)
    y0, y1 = min(p[1] for p in pts), max(p[1] for p in pts)
    for thick, rise in steps:
        res = bmesh.ops.inset_region(bm, faces=[face], thickness=thick, depth=rise, use_even_offset=True, use_boundary=True)
        for s in res['faces']:
            s.material_index = i
        # Insets on concave outlines can overshoot at reflex corners: keep the roof over the footprint.
        for v in face.verts:
            v.co.x = min(x1, max(x0, v.co.x))
            v.co.y = min(y1, max(y0, v.co.y))
    return face


def quoins(f, pts, h0, h1, mat='stone.red', s=0.5):
    if not f.detail:
        return
    for a, d, n, L in edges(pts, 3.0):
        obox(f, mat, a + d * (s / 2) + n * 0.03, d, s, 0.12, h0, h1)


def walls(f, mat, pts, h0, h1):
    f.prism(mat, pts, h0, h1)


def kommandantur(entry, root, lod):
    """Baroque commander's house on the Großer Markt: white render, red sandstone quoins, window frames and
    plinth, three storeys under a slate mansard with dormers, a balcony over the middle portal."""
    f = Frame(0, ALL_MATS, detail=lod == 0)
    fp = ccw(local_footprint(entry))
    H = 12.0
    walls(f, 'plaster.white', fp, -1.0, H)
    if f.detail:
        f.prism('stone.red', offset(fp, 0.06), -1.0, 1.0)                    # plinth
        f.prism('stone.red', offset(fp, 0.12), H - 0.5, H)                   # cornice
    quoins(f, fp, 1.0, H - 0.5)
    facade(f, fp, [1.6, 5.4, 8.8], w=1.2, h=2.2, spacing=3.4, frame='stone.red')
    roof(f, 'slate', offset(fp, 0.25), H, [(1.4, 3.0), (2.0, 0.9)])
    if f.detail:                                                              # dormers in the steep slope
        for a, d, n, L in edges(fp, 8.0):
            k = int((L - 2) // 3.4)
            for i in range(k):
                s = (L - (k - 1) * 3.4) / 2 + i * 3.4
                c = a + d * s - n * 0.6
                obox(f, 'plaster.white', c, d, 1.3, 1.2, H + 0.4, H + 2.2)
                obox(f, 'glass', c + n * 0.62, d, 0.8, 0.05, H + 0.7, H + 1.9)
                obox(f, 'slate', c - n * 0.1, d, 1.5, 1.5, H + 2.2, H + 2.45)
    ob = f.finish(f"{entry['id']}_lod{lod}", root)
    if lod:
        return ob, None
    c = Frame(0, ['stone'])
    c.prism('stone', fp, -1.0, H + 3.0)
    return ob, c.finish(f"{entry['id']}_collider", root)


def altes_rathaus(entry, root, lod):
    """Small sandstone town hall (about 1900): two storeys, hipped slate roof."""
    f = Frame(0, ALL_MATS, detail=lod == 0)
    fp = ccw(local_footprint(entry))
    H = 8.5
    walls(f, 'stone', fp, -1.0, H)
    if f.detail:
        f.prism('stone.dark', offset(fp, 0.05), -1.0, 0.8)
        f.prism('stone.light', offset(fp, 0.1), H - 0.4, H)
    quoins(f, fp, 0.8, H - 0.4, mat='stone.light')
    facade(f, fp, [1.3, 5.0], w=1.1, h=2.1, spacing=2.8, frame='stone.light', min_len=3.0)
    roof(f, 'slate', offset(fp, 0.35), H, [(3.0, 3.6), (1.6, 1.4)])
    ob = f.finish(f"{entry['id']}_lod{lod}", root)
    if lod:
        return ob, None
    c = Frame(0, ['stone'])
    c.prism('stone', fp, -1.0, H + 4.0)
    return ob, c.finish(f"{entry['id']}_collider", root)


def st_marien(entry, root, lod):
    """Plain rendered parish church (Picard): tall nave and chancel under hipped/gabled roofs, west front with
    a bell gable and round-arched windows, small porch."""
    f = Frame(0, ALL_MATS, detail=lod == 0)
    fp = ccw(local_footprint(entry))
    H = 9.5
    walls(f, 'plaster', fp, -1.0, H)
    facade(f, fp, [3.5], w=1.2, h=3.0, spacing=4.0, frame='plaster.white', arch=True, min_len=6.0)
    roof(f, 'roof', offset(fp, 0.4), H, [(2.2, 3.4)])
    # West front gable with the bell cote (front at x ≈ -25.6, spanning y -12 .. 4.7).
    x0, y0, y1 = -25.7, -12.1, 4.6
    bm = f.bm
    tri = [bm.verts.new((x0 - 0.05, y, z)) for y, z in ((y0, H), (y1, H), ((y0 + y1) / 2, H + 6.5))]
    tri2 = [bm.verts.new((x0 + 0.6, y, z)) for y, z in ((y0, H), (y1, H), ((y0 + y1) / 2, H + 6.5))]
    fs = [bm.faces.new(tri), bm.faces.new(list(reversed(tri2)))]
    for i in range(3):
        j = (i + 1) % 3
        fs.append(bm.faces.new((tri[i], tri[j], tri2[j], tri2[i])))
    for fc in fs:
        fc.material_index = f.mats.index('plaster')
    yc = (y0 + y1) / 2
    obox(f, 'plaster', (x0 + 0.25, yc), Vector((0, 1)), 2.2, 0.8, H + 5.5, H + 9.0)          # bell gable
    obox(f, 'roof', (x0 + 0.25, yc), Vector((0, 1)), 2.6, 1.0, H + 9.0, H + 9.25)
    if f.detail:
        obox(f, 'stone.dark', (x0 - 0.2, yc), Vector((0, 1)), 1.1, 0.6, H + 6.3, H + 8.2)   # bell opening
        obox(f, 'copper', (x0 + 0.25, yc), Vector((0, 1)), 0.08, 0.08, H + 9.25, H + 10.6)  # cross
        obox(f, 'copper', (x0 + 0.25, yc), Vector((0, 1)), 0.6, 0.08, H + 10.1, H + 10.2)
        for dy in (-1.4, 0.0, 1.4):
            obox(f, 'glass', (x0 - 0.1, yc + dy), Vector((0, 1)), 0.9, 0.1, H + 0.5, H + 2.6)
        obox(f, 'wood', (x0 - 6.6, yc - 2.9), Vector((0, 1)), 1.9, 0.12, 0.0, 2.6)          # porch door
    ob = f.finish(f"{entry['id']}_lod{lod}", root)
    if lod:
        return ob, None
    c = Frame(0, ['stone'])
    c.prism('stone', fp, -1.0, H + 4.0)
    c.prism('stone', [(x0, y0), (x0 + 0.6, y0), (x0 + 0.6, y1), (x0, y1)], H + 4.0, H + 9.0)
    return ob, c.finish(f"{entry['id']}_collider", root)


def kasematten(entry, root, lod, gate=False):
    """Vauban casemates: a long sandstone front of vaulted bays (now bars and restaurants) under a grassy rampart;
    the south-west block also carries the Deutsches Tor gate house."""
    f = Frame(0, ALL_MATS, detail=lod == 0)
    fp = ccw(local_footprint(entry))
    H = 4.6
    walls(f, 'stone', fp, -1.0, H)
    if f.detail:
        f.prism('stone.light', offset(fp, 0.12), H - 0.35, H)
    # Vaulted bays: dark round-arched openings with glazing along the long walls.
    if f.detail:
        for a, d, n, L in edges(fp, 20.0):
            k = int((L - 2) // 4.4)
            for i in range(k):
                s = (L - (k - 1) * 4.4) / 2 + i * 4.4
                c = a + d * s + n * 0.03
                obox(f, 'glass', c, d, 2.6, 0.1, 0.0, 2.6)
                f.spire('glass', c.x, c.y, 2.6, 3.4, 1.3, seg=6) if False else obox(f, 'glass', c, d, 1.8, 0.1, 2.6, 3.2)
                obox(f, 'stone.light', c + n * 0.03, d, 3.0, 0.08, 3.2, 3.5)
    # Grassy rampart on top, rising in a long mound.
    roof(f, 'roof.grass', offset(fp, -0.4), H, [(1.6, 1.6), (1.8, 0.8)])
    if gate:
        # Deutsches Tor: sandstone gate house with a big arch at the south-west end.
        a, d, n, L = max(edges(fp, 5.0), key=lambda e: -(e[0] + e[1] * e[3] / 2).y - (e[0] + e[1] * e[3] / 2).x)
        mid = a + d * (L / 2)
        obox(f, 'stone.light', mid - n * 3.0, d, min(L, 12.0), 7.0, -1.0, 6.8)
        obox(f, 'stone.light', mid - n * 3.0, d, min(L, 12.0) + 0.4, 7.4, 6.8, 7.3)
        if f.detail:
            obox(f, 'stone.dark', mid + n * 0.55, d, 3.6, 0.2, 0.0, 4.2)
            obox(f, 'stone.dark', mid + n * 0.55, d, 2.4, 0.2, 4.2, 5.0)
            obox(f, 'stone', mid + n * 0.6, d, 1.4, 0.2, 5.3, 6.4)                       # coat of arms
    ob = f.finish(f"{entry['id']}_lod{lod}", root)
    if lod:
        return ob, None
    c = Frame(0, ['stone'])
    c.prism('stone', fp, -1.0, H + 2.5)
    return ob, c.finish(f"{entry['id']}_collider", root)


def vauban_insel(entry, root, lod):
    """Ravelin on the Vauban island: battered sandstone walls rising from the moat around the whole island,
    with a low parapet; the island itself (trees, paths) comes from the terrain and vegetation layers."""
    f = Frame(0, ALL_MATS, detail=lod == 0)
    fp = ccw(local_footprint(entry))
    top, base = 0.5, -4.0
    outer_top = fp
    outer_base = offset(fp, 1.0)               # batter: the wall leans back about 1 m over 4.5 m
    inner = offset(fp, -1.2)
    bm = f.bm
    ot = [bm.verts.new((x, y, top)) for x, y in outer_top]
    ob_ = [bm.verts.new((x, y, base)) for x, y in outer_base]
    it = [bm.verts.new((x, y, top)) for x, y in inner]
    ib = [bm.verts.new((x, y, -1.0)) for x, y in inner]
    n = len(fp)
    fs = []
    for i in range(n):
        j = (i + 1) % n
        fs.append(bm.faces.new((ob_[i], ob_[j], ot[j], ot[i])))      # outer face
        fs.append(bm.faces.new((ot[i], ot[j], it[j], it[i])))        # coping
        fs.append(bm.faces.new((it[i], it[j], ib[j], ib[i])))        # inner face (into the ground)
    for fc in fs:
        fc.material_index = f.mats.index('stone')
    if f.detail:
        f.prism('stone.light', offset(fp, 0.1), top - 0.15, top + 0.05)                  # coping stones
        for a, d, nn, L in edges(fp, 6.0):                                                  # weathering streaks
            k = int(L // 7)
            for i in range(k):
                c = a + d * (L * (i + 0.5) / k) + nn * 0.55
                obox(f, 'stone.dark', c, d, 0.8, 0.05, base + 0.3, -0.8)
    ob = f.finish(f"{entry['id']}_lod{lod}", root)
    if lod:
        return ob, None
    # Collider: just the wall ring (the island ground is terrain).
    c = Frame(0, ['stone'])
    ring = c.bm
    o = [ring.verts.new((x, y, z)) for x, y in fp for z in (base, top + 0.5)]
    i_ = [ring.verts.new((x, y, z)) for x, y in inner for z in (base, top + 0.5)]
    for k in range(n):
        m = (k + 1) % n
        ring.faces.new((o[2 * k], o[2 * m], o[2 * m + 1], o[2 * k + 1]))
        ring.faces.new((i_[2 * k + 1], i_[2 * m + 1], i_[2 * m], i_[2 * k]))
        ring.faces.new((o[2 * k + 1], o[2 * m + 1], i_[2 * m + 1], i_[2 * k + 1]))
    return ob, c.finish(f"{entry['id']}_collider", root)


BUILDERS = {
    'ludwigskirche': ludwigskirche, 'rathaus': rathaus, 'kommandantur': kommandantur, 'altes-rathaus': altes_rathaus,
    'st-marien': st_marien, 'kasematten-sw': lambda e, r, l: kasematten(e, r, l, gate=True), 'kasematten-no': kasematten,
    'festung-vauban-insel': vauban_insel,
}


def build_one(entry):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()
    materials()
    root = empty(entry['id'], None)
    lod0, collider = BUILDERS[entry['id']](entry, root, 0)
    lod1, _ = BUILDERS[entry['id']](entry, root, 1)
    for ob in (lod0, lod1, collider):
        print(f"  {ob.name:24s} {tris(ob):6d} Dreiecke")
    export(root, os.path.join(OUT_DIR, entry['id'] + '.raw.glb'))


if __name__ == '__main__':
    for entry in MANIFEST:
        if entry['id'] in BUILDERS and (not ONLY or entry['id'] in ONLY):
            build_one(entry)
