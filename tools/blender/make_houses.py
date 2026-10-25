# Builds the freely designed houses, villas and administrative buildings and the front-garden parts; exports
# public/models/houses.glb. Run: blender --background --factory-startup --python tools/blender/make_houses.py -- [out.glb]
# Then compress: npm run models:houses (see package.json).
#
# The catalogue (ids, footprints, door and garage positions, garden styles) is src/world/houseCatalog.json, shared
# with the pipeline (pipeline/lib/houses.ts) and the game (src/world/houses.ts).
#
# Model space: ground at y = 0 (the plinth reaches 2.5 m below it for slopes), the front with the door faces +z,
# x along the front, footprint centred on the origin (w x d from the catalogue). Meshes per model:
#   <id>_lod0 / <id>_lod1         walls, roofs and details: vertex colours, uv.x = surface code (SURFACE in
#                                 src/world/houseKinds.ts), uv.y = tint code T_* (the glTF export stores 1 - uv.y)
#   <id>_glas0 / <id>_glas1       window glass (lit at night by the game)
# Garden parts: garten-<teil>_lod0 / _lod1, ground at y = 0; linear parts (fences, walls, hedges, paths) are 1 m
# long along z, centred on the origin, scaled along z by the game; point parts face +z.
# Window openings are real holes with reveals in lod0; lod1 keeps the volumes, roofs and glass flush on the walls.
import bpy, bmesh, json, math, os, random, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import bl, export, srgb, tris

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'houses.raw.glb')
CAT = json.load(open(os.path.join(HERE, '..', '..', 'src', 'world', 'houseCatalog.json')))

# Surface codes in uv.x: keep in sync with SURFACE in src/world/houseKinds.ts.
SURF = dict(paint=0, plaster=1, rough=2, brick=3, concrete=4, clay=5, slate=6, gravel=7, metal=8, wood=9, glass=10,
            stone=11, foliage=12, lawn=13, paving=14, kies=15, timber=16, seam=17)

# Tint codes in uv.y: keep in sync with TINT in src/world/houseKinds.ts. The game varies these per house: the wall
# colour from the style's TINTS, roof shades and the colours of shutters and doors from its seed.
T_WALL, T_ROOF, T_SHUTTER, T_DOOR = 1, 2, 3, 4

# Base palette: key -> (colour, surface, tint code (0 = fixed, T_*)).
BASE = {
    'wall': (0xece6da, 'plaster', 1), 'wall2': (0xd9d2c4, 'rough', 1), 'plinth': (0x8c8880, 'rough', 0),
    'reveal': (0xe4ded2, 'plaster', 1), 'frame': (0xf2f2ee, 'paint', 0), 'frame.dark': (0x34373b, 'paint', 0),
    'sill': (0xb8b2a6, 'concrete', 0), 'door': (0x5a3a26, 'wood', T_DOOR), 'door.dark': (0x2c2e31, 'paint', T_DOOR),
    'door.white': (0xe8e6e0, 'paint', T_DOOR), 'garagedoor': (0xd8d8d4, 'metal', 0),
    'roof': (0x9a4a36, 'clay', T_ROOF), 'roof.slate': (0x4a4c52, 'slate', T_ROOF), 'roof.metal': (0x5a5e63, 'seam', 0),
    'roof.flat': (0x8a8882, 'gravel', 0), 'fascia': (0xeeeeea, 'paint', 0), 'gutter': (0x8a8d90, 'metal', 0),
    'parapet': (0xe6e2da, 'plaster', 1), 'cap': (0x7c8084, 'metal', 0), 'chimney': (0x8a4a3a, 'brick', 0),
    'brick': (0xa65a42, 'brick', 0), 'brick.dark': (0x6e3a2e, 'brick', 0), 'stone': (0xc8b490, 'stone', 0),
    'stone.red': (0xa8705a, 'stone', 0), 'concrete': (0xb4b2ac, 'concrete', 0), 'concrete.dark': (0x5a5c5e, 'concrete', 0),
    'wood': (0xa87a4e, 'wood', 0), 'wood.dark': (0x5a4434, 'wood', 0), 'wood.red': (0x8a2e24, 'wood', 0),
    'wood.grey': (0x8c8a84, 'wood', 0), 'timber': (0x4a3426, 'timber', 0), 'metal': (0x3a3d40, 'metal', 0),
    'metal.light': (0xb4b8bc, 'metal', 0), 'corten': (0x8a4a2a, 'metal', 0), 'shutter': (0x3e6a48, 'paint', T_SHUTTER),
    'shutter.blue': (0x3a5a7a, 'paint', T_SHUTTER), 'shutter.white': (0xe8e8e2, 'paint', 0), 'terracotta': (0xc87a52, 'clay', T_ROOF),
    'step': (0xa8a49c, 'concrete', 0), 'column': (0xeeeae2, 'stone', 0), 'copper': (0x5f8f7a, 'metal', 0),
    'flower.red': (0xc8283a, 'foliage', 0), 'flower.pink': (0xe070a0, 'foliage', 0), 'flower.yellow': (0xe8c030, 'foliage', 0),
    'flower.white': (0xf2f0e8, 'foliage', 0), 'flower.blue': (0x6a70d0, 'foliage', 0), 'leaf': (0x4a7a3a, 'foliage', 0),
    'leaf.dark': (0x2f5a2e, 'foliage', 0), 'grass.orn': (0xa8a868, 'foliage', 0), 'lawn': (0x5a8a3e, 'lawn', 0),
    'paving': (0xb0aaa0, 'paving', 0), 'kies': (0xc8c0b0, 'kies', 0), 'gabion': (0x9a968c, 'kies', 0),
    'black': (0x1c1d1f, 'paint', 0), 'white': (0xf4f4f0, 'paint', 0), 'red': (0xc8202a, 'paint', 0),
    'blue': (0x2a4a8a, 'paint', 0), 'skin': (0xe0b294, 'paint', 0), 'bin.grey': (0x3c4044, 'paint', 0),
    'bin.blue': (0x2a4a8a, 'paint', 0), 'bin.yellow': (0xd8b828, 'paint', 0), 'bin.brown': (0x5a3a26, 'paint', 0),
    'lamp': (0xfff2d0, 'paint', 0), 'water': (0x50708a, 'paint', 0), 'flag': (0xe8e8e8, 'paint', 0),
    'flag.blue': (0x1a3a8a, 'paint', 0), 'flag.yellow': (0xe8c020, 'paint', 0), 'flag.black': (0x1a1a1a, 'paint', 0),
    'flag.red': (0xc81e28, 'paint', 0),
}
GLASS = {'glass': (0x27323c, 'glass', 0)}

UP, DOWN = (0, 1, 0), (0, -1, 0)


def neg(v):
    return (-v[0], -v[1], -v[2])


class M:
    """One mesh in model space; every face carries a palette key (colour, surface code, tint flag)."""

    def __init__(self, pal=BASE, over=None):
        self.bm = bmesh.new()
        self.pal = dict(pal)
        if over:
            self.pal.update(over)
        self.uv = self.bm.loops.layers.uv.new('UVMap')
        self.col = self.bm.loops.layers.float_color.new('Color')

    def mark(self, faces, key):
        hexc, surf, tint = self.pal[key]
        c = srgb(hexc)
        for f in faces:
            for l in f.loops:
                l[self.col] = c
                l[self.uv].uv = (SURF[surf], tint)
        return faces

    def face(self, key, pts, n=None, away=None):
        """Polygon from model points; with n the winding is turned so the face looks along n (or away from a point)."""
        if away is not None:
            c = [sum(p[i] for p in pts) / len(pts) for i in range(3)]
            n = (c[0] - away[0], c[1] - away[1], c[2] - away[2])
        vs = [self.bm.verts.new(bl(*p)) for p in pts]
        try:
            f = self.bm.faces.new(vs)
        except ValueError:
            return None
        if n is not None:
            f.normal_update()
            if f.normal.dot(bl(*n)) < 0:
                f.normal_flip()
        self.mark([f], key)
        return f

    def box(self, key, x0, x1, y0, y1, z0, z1):
        """Axis-aligned box from corner coordinates."""
        if x1 - x0 < 1e-4 or y1 - y0 < 1e-4 or z1 - z0 < 1e-4:
            return
        v = bmesh.ops.create_cube(self.bm, size=1)['verts']
        bmesh.ops.scale(self.bm, vec=(x1 - x0, z1 - z0, y1 - y0), verts=v)
        bmesh.ops.translate(self.bm, vec=bl((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2), verts=v)
        self.mark({f for x in v for f in x.link_faces}, key)

    def boxc(self, key, size, at, roty=0.0, rotx=0.0, rotz=0.0):
        """Box of size (x, y, z) centred at `at`, rotated about the model axes (z, then x, then y)."""
        from mathutils import Matrix
        v = bmesh.ops.create_cube(self.bm, size=1)['verts']
        bmesh.ops.scale(self.bm, vec=(size[0], size[2], size[1]), verts=v)
        m = Matrix.Translation(bl(*at)) @ Matrix.Rotation(roty, 4, 'Z') @ Matrix.Rotation(rotx, 4, 'X') @ Matrix.Rotation(-rotz, 4, 'Y')
        bmesh.ops.transform(self.bm, matrix=m, verts=v)
        self.mark({f for x in v for f in x.link_faces}, key)

    def cyl(self, key, r, y0, y1, x=0, z=0, seg=12, r2=None, caps=True):
        """Vertical cylinder (or cone with r2) from y0 to y1."""
        v = bmesh.ops.create_cone(self.bm, cap_ends=caps, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=y1 - y0)['verts']
        bmesh.ops.translate(self.bm, vec=bl(x, (y0 + y1) / 2, z), verts=v)
        faces = self.mark({f for x_ in v for f in x_.link_faces}, key)
        # Round sides shade smooth when there are enough of them; caps stay flat.
        if seg >= 10:
            self.smooth([f for f in faces if len(f.verts) == 4])

    def ball(self, key, r, at, seg=12, rings=7, scale=(1, 1, 1)):
        v = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r)['verts']
        bmesh.ops.scale(self.bm, vec=(scale[0], scale[2], scale[1]), verts=v)
        bmesh.ops.translate(self.bm, vec=bl(*at), verts=v)
        self.smooth(self.mark({f for x in v for f in x.link_faces}, key))

    @staticmethod
    def smooth(faces):
        for f in faces:
            f.smooth = True

    def blob(self, key, r, at, seed, seg=10, rings=6, scale=(1, 1, 1), rough=0.18):
        """Lumpy sphere for shrubs and hedges."""
        v = bmesh.ops.create_icosphere(self.bm, subdivisions=3 if r > 0.3 else 2, radius=r)['verts']
        rnd = random.Random(seed)
        # Lumps from a few random bulges, so the surface stays smooth instead of spiky.
        bulges = [Vector((rnd.uniform(-1, 1), rnd.uniform(-1, 1), rnd.uniform(-1, 1))).normalized() for _ in range(6)]
        for x in v:
            d = x.co.normalized()
            x.co *= 1 + rough * sum(max(0.0, d.dot(b)) ** 3 * rnd.choice((1, -0.6)) for b in bulges) * 0.8 + (rnd.random() - 0.5) * rough * 0.3
        bmesh.ops.scale(self.bm, vec=(scale[0], scale[2], scale[1]), verts=v)
        bmesh.ops.translate(self.bm, vec=bl(*at), verts=v)
        self.smooth(self.mark({f for x in v for f in x.link_faces}, key))

    def prism(self, key, pts, y0, y1, top_key=None):
        """Vertical prism over a polygon of (x, z) points."""
        cx = sum(p[0] for p in pts) / len(pts)
        cz = sum(p[1] for p in pts) / len(pts)
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            mx, mz = (a[0] + b[0]) / 2 - cx, (a[1] + b[1]) / 2 - cz
            self.face(key, [(a[0], y0, a[1]), (b[0], y0, b[1]), (b[0], y1, b[1]), (a[0], y1, a[1])], (mx, 0, mz))
        self.face(top_key or key, [(x, y1, z) for x, z in pts], UP)

    def slab(self, key, pts, t, edge=None, under=None):
        """A plate whose top is the polygon pts (3 or 4 model points), thickness t below it."""
        n = newell(pts)
        if n[1] < 0:
            pts = list(reversed(pts))
            n = neg(n)
        bot = [(p[0] - n[0] * t, p[1] - n[1] * t, p[2] - n[2] * t) for p in pts]
        self.face(key, pts, n)
        self.face(under or edge or key, bot, neg(n))
        c = [sum(p[i] for p in pts) / len(pts) for i in range(3)]
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            out = ((a[0] + b[0]) / 2 - c[0], 0, (a[2] + b[2]) / 2 - c[2])
            self.face(edge or key, [a, b, bot[(i + 1) % len(pts)], bot[i]], out)

    def finish(self, name, parent, mat):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-5)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.materials.append(mat)
        me.color_attributes.active_color = me.color_attributes['Color']
        me.color_attributes.render_color_index = 0
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent
        return ob


def newell(pts):
    x = y = z = 0.0
    for i in range(len(pts)):
        a, b = pts[i], pts[(i + 1) % len(pts)]
        x += (a[1] - b[1]) * (a[2] + b[2])
        y += (a[2] - b[2]) * (a[0] + b[0])
        z += (a[0] - b[0]) * (a[1] + b[1])
    l = math.sqrt(x * x + y * y + z * z) or 1
    return (x / l, y / l, z / l)


# ---------------------------------------------------------------- walls and openings

def side_frame(v, side):
    """Origin (bottom-left seen from outside), along-direction, outward normal and length of a volume side."""
    x0, x1, z0, z1 = v['x0'], v['x1'], v['z0'], v['z1']
    return {
        'front': ((x0, 0, z1), (1, 0, 0), (0, 0, 1), x1 - x0),
        'back': ((x1, 0, z0), (-1, 0, 0), (0, 0, -1), x1 - x0),
        'left': ((x0, 0, z0), (0, 0, 1), (-1, 0, 0), z1 - z0),
        'right': ((x1, 0, z1), (0, 0, -1), (1, 0, 0), z1 - z0),
    }[side]


def to_u(v, side, x_or_z):
    """Along-wall position of a model x (front/back) or z (left/right)."""
    if side == 'front':
        return x_or_z - v['x0']
    if side == 'back':
        return v['x1'] - x_or_z
    if side == 'left':
        return x_or_z - v['z0']
    return v['z1'] - x_or_z


class Wall:
    def __init__(self, o, u, n, y0):
        self.o, self.u, self.n, self.y0 = o, u, n, y0

    def p(self, a, v, d=0.0):
        o, u, n = self.o, self.u, self.n
        return (o[0] + u[0] * a - n[0] * d, self.y0 + v, o[2] + u[2] * a - n[2] * d)


def wall(m, g, w, key, L, H, ops, lod, rkey=None, depth=0.2):
    """A wall rectangle L x H with openings [(u0, v0, u1, v1, kind, opts)]: holes with reveals in lod0."""
    rkey = rkey or ('reveal' if m.pal[key][2] == T_WALL else key)
    if lod:
        m.face(key, [w.p(0, 0), w.p(L, 0), w.p(L, H), w.p(0, H)], w.n)
        for op in ops:
            fill_flush(m, g, w, op)
        return
    us = sorted({0.0, L, *[a for op in ops for a in (op[0], op[2])]})
    vs = sorted({0.0, H, *[a for op in ops for a in (op[1], op[3])]})
    for i in range(len(us) - 1):
        for j in range(len(vs) - 1):
            cu, cv = (us[i] + us[i + 1]) / 2, (vs[j] + vs[j + 1]) / 2
            if any(op[0] < cu < op[2] and op[1] < cv < op[3] for op in ops):
                continue
            m.face(key, [w.p(us[i], vs[j]), w.p(us[i + 1], vs[j]), w.p(us[i + 1], vs[j + 1]), w.p(us[i], vs[j + 1])], w.n)
    u = w.u
    for op in ops:
        a0, v0, a1, v1 = op[:4]
        d = op[5].get('depth', depth)
        m.face(rkey, [w.p(a0, v0), w.p(a0, v1), w.p(a0, v1, d), w.p(a0, v0, d)], u)
        m.face(rkey, [w.p(a1, v0), w.p(a1, v0, d), w.p(a1, v1, d), w.p(a1, v1)], neg(u))
        m.face(rkey, [w.p(a0, v1), w.p(a1, v1), w.p(a1, v1, d), w.p(a0, v1, d)], DOWN)
        m.face('sill' if op[4] == 'win' else rkey, [w.p(a0, v0), w.p(a0, v0, d), w.p(a1, v0, d), w.p(a1, v0)], UP)
        fill_deep(m, g, w, op, d)


def bar(m, key, w, a0, v0, a1, v1, d0, d1):
    """Box between along/up/depth ranges of a wall frame."""
    pts = [w.p(a0, v0, d0), w.p(a1, v1, d1)]
    m.box(key, min(pts[0][0], pts[1][0]), max(pts[0][0], pts[1][0]), min(pts[0][1], pts[1][1]), max(pts[0][1], pts[1][1]),
          min(pts[0][2], pts[1][2]), max(pts[0][2], pts[1][2]))


def fill_deep(m, g, w, op, d):
    a0, v0, a1, v1, kind, o = op
    fk = o.get('frame', 'frame')
    ft = 0.065
    if kind in ('win', 'glassdoor'):
        g.face('glass', [w.p(a0, v0, d - 0.02), w.p(a1, v0, d - 0.02), w.p(a1, v1, d - 0.02), w.p(a0, v1, d - 0.02)], w.n)
        # Frame on the glass plane, mullion and transom on larger windows.
        bar(m, fk, w, a0, v0, a1, v0 + ft, d - 0.09, d - 0.01)
        bar(m, fk, w, a0, v1 - ft, a1, v1, d - 0.09, d - 0.01)
        bar(m, fk, w, a0, v0, a0 + ft, v1, d - 0.09, d - 0.01)
        bar(m, fk, w, a1 - ft, v0, a1, v1, d - 0.09, d - 0.01)
        bars = o.get('bars', 'auto')
        if bars == 'auto':
            bars = (a1 - a0 > 1.05 and kind == 'win') + 2 * (v1 - v0 > 1.7 and kind == 'win' and o.get('transom', True))
        if bars & 1:
            n = max(1, int((a1 - a0) / 1.0))
            for k in range(1, n + 1):
                a = a0 + (a1 - a0) * k / (n + 1)
                bar(m, fk, w, a - ft / 2, v0, a + ft / 2, v1, d - 0.08, d - 0.02)
        if bars & 2:
            v = v0 + (v1 - v0) * 0.72
            bar(m, fk, w, a0, v - ft / 2, a1, v + ft / 2, d - 0.08, d - 0.02)
        if o.get('blind') and kind == 'win':
            # Roller shutters or external blinds, lowered by a different amount in each window (fixed per model).
            rnd = random.Random(int(abs(a0 * 7919 + v0 * 104729 + w.o[0] * 31 + w.o[2] * 17 + w.n[0] * 5 + w.n[2] * 3) * 1000))
            if rnd.random() < 0.55:
                f = rnd.choice((0.15, 0.3, 0.45, 0.6, 0.75))
                bar(m, o['blind'], w, a0 + 0.01, v1 - f * (v1 - v0), a1 - 0.01, v1, d - 0.15, d - 0.1)
            bar(m, o['blind'], w, a0, v1 - 0.12, a1, v1, d - 0.17, d - 0.1)
    elif kind == 'door':
        dk = o.get('door', 'door')
        bar(m, dk, w, a0, v0, a1, v1, d - 0.06, d)
        if o.get('panels', True):
            for k in range(2):
                y = v0 + 0.25 + k * (v1 - v0) * 0.45
                bar(m, dk, w, a0 + 0.12, y, a1 - 0.12, y + (v1 - v0) * 0.35, d - 0.09, d - 0.06)
        if o.get('light', True):
            g.face('glass', [w.p(a0 + 0.18, v1 - 0.55, d - 0.07), w.p(a1 - 0.18, v1 - 0.55, d - 0.07), w.p(a1 - 0.18, v1 - 0.18, d - 0.07), w.p(a0 + 0.18, v1 - 0.18, d - 0.07)], w.n)
        bar(m, 'metal.light', w, a1 - 0.18, v0 + 1.0, a1 - 0.1, v0 + 1.06, d - 0.16, d - 0.06)
    elif kind == 'garage':
        gk = o.get('door', 'garagedoor')
        bar(m, gk, w, a0, v0, a1, v1, d - 0.05, d)
        k = 0
        y = v0 + 0.5
        while y < v1 - 0.1:
            bar(m, gk, w, a0 + 0.02, y, a1 - 0.02, y + 0.03, d - 0.07, d - 0.05)
            y += 0.5
            k += 1


def fill_flush(m, g, w, op):
    a0, v0, a1, v1, kind, o = op
    if kind in ('win', 'glassdoor'):
        g.face('glass', [w.p(a0, v0, -0.015), w.p(a1, v0, -0.015), w.p(a1, v1, -0.015), w.p(a0, v1, -0.015)], w.n)
    elif kind == 'door':
        m.face(o.get('door', 'door'), [w.p(a0, v0, -0.015), w.p(a1, v0, -0.015), w.p(a1, v1, -0.015), w.p(a0, v1, -0.015)], w.n)
    elif kind == 'garage':
        m.face(o.get('door', 'garagedoor'), [w.p(a0, v0, -0.015), w.p(a1, v0, -0.015), w.p(a1, v1, -0.015), w.p(a0, v1, -0.015)], w.n)


def decorate(m, w, op, deco, lod):
    """Things around an opening on the wall face: sills, surrounds, pediments, shutters, flower boxes."""
    a0, v0, a1, v1, kind, o = op
    if kind == 'win' and 'sill' in deco:
        bar(m, 'sill', w, a0 - 0.06, v0 - 0.06, a1 + 0.06, v0, -0.07, 0.02)
    if lod:
        if 'shutters' in deco and kind == 'win':
            sw = (a1 - a0) / 2
            for s in ((a0 - sw - 0.04, a0 - 0.04), (a1 + 0.04, a1 + sw + 0.04)):
                bar(m, deco.get('shutter', 'shutter'), w, s[0], v0, s[1], v1, -0.04, 0.0)
        return
    if 'surround' in deco:
        sk, sw = deco.get('surround_key', 'stone'), 0.13
        bar(m, sk, w, a0 - sw, v0 - (0 if kind != 'win' else 0.04), a0, v1 + sw, -0.035, 0.01)
        bar(m, sk, w, a1, v0 - (0 if kind != 'win' else 0.04), a1 + sw, v1 + sw, -0.035, 0.01)
        bar(m, sk, w, a0, v1, a1, v1 + sw, -0.035, 0.01)
    if 'pediment' in deco and kind in ('win', 'door'):
        sk = deco.get('surround_key', 'stone')
        top = v1 + 0.13
        bar(m, sk, w, a0 - 0.22, top, a1 + 0.22, top + 0.1, -0.12, 0.01)
        if deco['pediment'] == 'triangle' or (deco['pediment'] == 'mixed' and o.get('floor', 0) == 1):
            h = 0.32
            pa, pb, pc = w.p(a0 - 0.22, top + 0.1, -0.1), w.p(a1 + 0.22, top + 0.1, -0.1), w.p((a0 + a1) / 2, top + 0.1 + h, -0.1)
            qa, qb, qc = w.p(a0 - 0.22, top + 0.1, 0.01), w.p(a1 + 0.22, top + 0.1, 0.01), w.p((a0 + a1) / 2, top + 0.1 + h, 0.01)
            m.face(sk, [pa, pb, pc], w.n)
            mid = w.p((a0 + a1) / 2, top + 0.1 + h * 0.3, -0.05)
            m.face(sk, [pa, pc, qc, qa], away=mid)
            m.face(sk, [pc, pb, qb, qc], away=mid)
    if 'lintel' in deco and kind in ('win', 'door', 'glassdoor'):
        bar(m, deco.get('lintel_key', 'brick.dark'), w, a0 - 0.1, v1, a1 + 0.1, v1 + 0.2, -0.02, 0.01)
    if 'deepframe' in deco and kind in ('win', 'glassdoor'):
        fk = deco.get('deep_key', 'frame.dark')
        t, d = 0.08, 0.14
        bar(m, fk, w, a0 - t, v0 - t, a1 + t, v0, -d, 0.02)
        bar(m, fk, w, a0 - t, v1, a1 + t, v1 + t, -d, 0.02)
        bar(m, fk, w, a0 - t, v0, a0, v1, -d, 0.02)
        bar(m, fk, w, a1, v0, a1 + t, v1, -d, 0.02)
    if 'shutters' in deco and kind == 'win':
        sw = (a1 - a0) / 2
        sk = deco.get('shutter', 'shutter')
        for s in ((a0 - sw - 0.04, a0 - 0.04), (a1 + 0.04, a1 + sw + 0.04)):
            bar(m, sk, w, s[0], v0, s[1], v1, -0.05, 0.0)
            for k in range(1, int((v1 - v0) / 0.22)):
                bar(m, sk, w, s[0] + 0.04, v0 + k * 0.22, s[1] - 0.04, v0 + k * 0.22 + 0.04, -0.07, -0.04)
    if 'flowerbox' in deco and kind == 'win' and o.get('floor', 0) >= deco.get('flowerbox_floor', 1):
        bar(m, 'wood.dark', w, a0 + 0.05, v0 - 0.3, a1 - 0.05, v0 - 0.06, -0.3, 0.0)
        cols = ['flower.red', 'flower.pink', 'flower.red', 'flower.white']
        n = max(2, int((a1 - a0) / 0.25))
        for k in range(n):
            a = a0 + 0.12 + (a1 - a0 - 0.24) * k / max(1, n - 1)
            p = w.p(a, v0 - 0.02, -0.15)
            m.ball(cols[k % len(cols)] if k % 2 else 'leaf', 0.11, p, seg=6, rings=4)


def door_furniture(m, w, op):
    """Wall lamp beside the door, house number and bell plate."""
    a0, v0, a1, v1 = op[:4]
    la = a0 - 0.32
    bar(m, 'frame.dark', w, la - 0.09, v1 - 0.45, la + 0.09, v1 - 0.05, -0.03, 0.0)
    bar(m, 'lamp', w, la - 0.07, v1 - 0.4, la + 0.07, v1 - 0.12, -0.16, -0.03)
    bar(m, 'frame.dark', w, la - 0.09, v1 - 0.12, la + 0.09, v1 - 0.06, -0.18, -0.03)
    bar(m, 'metal.light', w, a1 + 0.08, 1.05, a1 + 0.2, 1.35, -0.025, 0.0)
    bar(m, 'frame.dark', w, a1 + 0.06, v1 - 0.3, a1 + 0.26, v1 - 0.12, -0.025, 0.0)


def spread(L, ww, gap, margin, n=None):
    """Centres of n equal windows of width ww spread over L (n from the gap if not given)."""
    if n is None:
        n = max(1, int((L - 2 * margin + gap) // (ww + gap)))
    if n == 1:
        return [L / 2]
    step = (L - 2 * margin - ww) / (n - 1)
    return [margin + ww / 2 + i * step for i in range(n)]


# ---------------------------------------------------------------- volumes and roofs

DEFAULT_WIN = dict(w=1.2, h=1.4, sill=0.9, gap=1.3, margin=1.0, deco=('sill',))


def volume(m, g, v, lod):
    """A box volume with walls (windows per floor and side), plinth and top band. Returns the eave height."""
    x0, x1, z0, z1 = v['x0'], v['x1'], v['z0'], v['z1']
    y0 = v.get('y0', 0.0)
    pl = v.get('plinth', 0.45 if y0 == 0 else 0)
    floors, fh = v.get('floors', 2), v.get('fh', 2.9)
    knee = v.get('knee', 0.0)
    H = floors * fh + knee
    if pl:
        m.box(v.get('plinth_key', 'plinth'), x0 - 0.03, x1 + 0.03, -2.5, y0 + pl, z0 - 0.03, z1 + 0.03)
    win = dict(DEFAULT_WIN, **v.get('win', {}))
    deco = win.get('deco', ())
    deco = deco if isinstance(deco, dict) else {k: True for k in deco}
    key = v.get('wall', 'wall')
    sides = v.get('sides', ('front', 'back', 'left', 'right'))
    keys = v.get('side_keys', {})
    for side in ('front', 'back', 'left', 'right'):
        if side in v.get('hidden', ()):
            continue
        o, u, n, L = side_frame(v, side)
        w = Wall(o, u, n, y0 + pl)
        ops = []
        custom = v.get('ops', {}).get(side)
        if custom is not None:
            ops = [(a, b, c, d, k, dict(oo)) for a, b, c, d, k, oo in custom(L, H)]
        elif side in sides:
            sw = dict(win, **v.get('side_win', {}).get(side, {}))
            for f in range(floors):
                if f in v.get('blank_floors', {}).get(side, ()):
                    continue
                ww, wh = sw['w'], sw['h'] if f > 0 or 'h0' not in sw else sw['h0']
                sill = sw['sill'] if f > 0 or 'sill0' not in sw else sw['sill0']
                if f * fh + sill + wh > H - 0.15:
                    continue
                for c in spread(L, ww, sw['gap'], sw['margin'], sw.get('n')):
                    ops.append([c - ww / 2, f * fh + sill, c + ww / 2, f * fh + sill + wh, 'win', {'floor': f, 'frame': sw.get('frame', 'frame'), 'bars': sw.get('bars', 'auto'), 'transom': sw.get('transom', True), 'blind': sw.get('blind')}])
            if side == 'front':
                for dx, kind, dw, dh, extra in v.get('doors', []):
                    a = to_u(v, side, dx)
                    a0, a1 = a - dw / 2, a + dw / 2
                    ops = [op for op in ops if op[4] != 'win' or op[5]['floor'] > 0 or op[2] < a0 - 0.25 or op[0] > a1 + 0.25]
                    ops.append([a0, 0.0, a1, dh, kind, dict(extra)])
                for gx, gw in v.get('garages', []):
                    a = to_u(v, side, gx)
                    ops = [op for op in ops if op[5].get('floor', 0) > 0 or op[2] < a - gw / 2 - 0.3 or op[0] > a + gw / 2 + 0.3]
                    ops.append([a - gw / 2, 0.0, a + gw / 2, 2.25, 'garage', {}])
            ops = [tuple(op) for op in ops]
        wall(m, g, w, keys.get(side, key), L, H, ops, lod, rkey=v.get('reveal'))
        for op in ops:
            decorate(m, w, op, deco, lod)
            if op[4] == 'door' and not lod and v.get('door_lamp', True) and op[0] > 0.5 and op[2] < L - 0.35:
                door_furniture(m, w, op)
        if v.get('fachwerk') and (side in v['fachwerk'] if isinstance(v['fachwerk'], tuple) else True):
            fachwerk(m, w, L, H, ops, floors, fh, lod, v.get('fachwerk_from', 0))
        if v.get('quoins') and not lod:
            quoins(m, w, L, H, v.get('quoin_key', 'stone'))
        if v.get('bands') and not lod:
            for f in range(1, floors):
                bar(m, v.get('band_key', 'stone'), w, -0.05, f * fh - 0.12, L + 0.05, f * fh + 0.06, -0.08, 0.01)
    top = y0 + pl + H
    if v.get('cornice'):
        ck = v.get('cornice_key', 'stone')
        c = v['cornice'] if isinstance(v['cornice'], float) else 0.18
        m.box(ck, x0 - c, x1 + c, top - 0.28, top, z0 - c, z1 + c)
        if not lod:
            m.box(ck, x0 - c * 0.5, x1 + c * 0.5, top - 0.4, top - 0.28, z0 - c * 0.5, z1 + c * 0.5)
            if v.get('brackets'):
                for x in spread(x1 - x0, 0.14, 0.7, 0.25):
                    m.box(ck, x0 + x - 0.07, x0 + x + 0.07, top - 0.62, top - 0.4, z1, z1 + c * 0.75)
    roof(m, v.get('roof'), x0, x1, z0, z1, top, lod)
    return top


def quoins(m, w, L, H, key):
    y = 0.0
    k = 0
    while y < H - 0.2:
        l = 0.55 if k % 2 == 0 else 0.32
        for a0, a1 in ((0, l), (L - l, L)):
            bar(m, key, w, a0 - 0.01, y, a1 + 0.01, y + 0.3, -0.03, 0.01)
        y += 0.34
        k += 1


def fachwerk(m, w, L, H, ops, floors, fh, lod, start):
    """Half-timbering: sill and head beams per floor, posts at the ends and beside openings, braces in closed panels."""
    t, d = 0.17, 0.035
    k = 'timber'
    for f in range(start, floors):
        yb, yt = f * fh, min(H, (f + 1) * fh)
        bar(m, k, w, -0.02, yb, L + 0.02, yb + t, -d, 0.01)
        bar(m, k, w, -0.02, yt - t, L + 0.02, yt, -d, 0.01)
        mine = [op for op in ops if op[1] < yt and op[3] > yb]
        posts = {0.0, L - t}
        for op in mine:
            posts.add(max(0.0, op[0] - t))
            posts.add(min(L - t, op[2]))
        ps = sorted(posts)
        # Extra posts in wide closed panels.
        full = []
        for a, b in zip(ps, ps[1:]):
            full.append(a)
            gap = b - a - t
            closed = not any(op[0] < b and op[2] > a + t for op in mine)
            if closed and gap > 1.6:
                n = int(gap // 1.2)
                for i in range(1, n + 1):
                    full.append(a + gap * i / (n + 1))
        full.append(ps[-1])
        full = sorted(set(round(x, 3) for x in full))
        for a in full:
            bar(m, k, w, a, yb + t, a + t, yt - t, -d, 0.01)
        if lod:
            continue
        for op in mine:
            bar(m, k, w, op[0] - 0.02, op[3], op[2] + 0.02, op[3] + 0.12, -d, 0.01)
            if op[1] > yb + 0.2:
                bar(m, k, w, op[0] - 0.02, op[1] - 0.12, op[2] + 0.02, op[1], -d, 0.01)
        for i, (a, b) in enumerate(zip(full, full[1:])):
            closed = not any(op[0] < b and op[2] > a + t for op in mine)
            span = b - (a + t)
            if closed and 0.6 < span < 2.0:
                hgt = yt - yb - 2 * t
                ang = math.atan2(hgt, span)
                lenb = math.hypot(span, hgt)
                c = w.p(a + t + span / 2, yb + t + hgt / 2, -d / 2 + 0.005)
                # Rotate about the wall normal: braces alternate direction.
                sgn = 1 if i % 2 == 0 else -1
                rot = sgn * ang
                if abs(w.n[2]) > 0.5:
                    m.boxc(k, (lenb, t * 0.9, d + 0.01), c, rotz=rot * (1 if w.u[0] > 0 else -1) * -1)
                else:
                    m.boxc(k, (d + 0.01, t * 0.9, lenb), c, rotx=rot * (1 if w.u[2] > 0 else -1))


def roof(m, r, x0, x1, z0, z1, e, lod):
    if not r:
        return
    t = r.get('type', 'gable')
    key = r.get('key', 'roof')
    o = r.get('over', 0.45)
    th = 0.16
    pitch = math.radians(r.get('pitch', 40))
    wk = r.get('wall', 'wall')
    fk = r.get('fascia', 'fascia')
    if r.get('axis', 'x') == 'z' and t in ('gable', 'hip', 'kruppel', 'pent', 'mansard', 'butterfly'):
        # Ridge along z: build along x and swap axes.
        swap_roof(m, r, x0, x1, z0, z1, e, lod)
        return
    w, d = x1 - x0, z1 - z0
    zm = (z0 + z1) / 2
    if t == 'flat':
        m.box(r.get('top', 'roof.flat'), x0 + 0.05, x1 - 0.05, e - 0.1, e + 0.02, z0 + 0.05, z1 - 0.05)
        ph = r.get('parapet', 0.45)
        pk = r.get('parapet_key', 'parapet')
        pw = 0.25
        for a in ((x0 - 0.02, x1 + 0.02, z0 - 0.02, z0 + pw), (x0 - 0.02, x1 + 0.02, z1 - pw, z1 + 0.02),
                  (x0 - 0.02, x0 + pw, z0 + pw, z1 - pw), (x1 - pw, x1 + 0.02, z0 + pw, z1 - pw)):
            m.box(pk, a[0], a[1], e - 0.3, e + ph, a[2], a[3])
        if not lod:
            m.box(r.get('cap', 'cap'), x0 - 0.05, x1 + 0.05, e + ph, e + ph + 0.04, z0 - 0.05, z0 + pw + 0.03)
            m.box(r.get('cap', 'cap'), x0 - 0.05, x1 + 0.05, e + ph, e + ph + 0.04, z1 - pw - 0.03, z1 + 0.05)
            m.box(r.get('cap', 'cap'), x0 - 0.05, x0 + pw + 0.03, e + ph, e + ph + 0.04, z0 + pw, z1 - pw)
            m.box(r.get('cap', 'cap'), x1 - pw - 0.03, x1 + 0.05, e + ph, e + ph + 0.04, z0 + pw, z1 - pw)
        if r.get('overhang'):
            oh = r['overhang']
            m.box(r.get('parapet_key', 'parapet'), x0 - oh, x1 + oh, e - 0.05, e + 0.22, z0 - oh, z1 + oh)
        return
    if t == 'gable' or t == 'kruppel':
        rh = d / 2 * math.tan(pitch)
        drop = o * math.tan(pitch)
        ridge = e + rh
        kz = 0.0
        if t == 'kruppel':
            # Hipped tops of the gables: the ridge stops short of the gable walls.
            kz = r.get('kruppel', 0.33)
        cut = ridge - rh * kz
        xi0, xi1 = (x0 + (d / 2) * kz * 0.9, x1 - (d / 2) * kz * 0.9) if t == 'kruppel' else (x0 - o, x1 + o)
        for zs, s in ((z1, 1), (z0, -1)):
            zc = zm + s * (d / 2) * kz
            if t == 'gable':
                pts = [(x0 - o, e - drop, zs + s * o), (x1 + o, e - drop, zs + s * o), (x1 + o, ridge, zm), (x0 - o, ridge, zm)]
            else:
                pts = [(x0 - o, e - drop, zs + s * o), (x1 + o, e - drop, zs + s * o), (x1 + o, cut, zc), (xi1, ridge, zm), (xi0, ridge, zm), (x0 - o, cut, zc)]
            slab_roof(m, key, pts, th, fk)
            if not lod:
                gutter(m, x0 - o, x1 + o, e - drop - 0.05, zs + s * (o + 0.08))
                if r.get('pipes', True):
                    downpipes(m, (x0 + 0.2, x1 - 0.2), zs, s, e - drop - 0.05, zs + s * (o + 0.08))
                if r.get('rafters'):
                    rafters(m, x0 - o, x1 + o, zs, s, e, o, pitch, key=r['rafters'] if isinstance(r['rafters'], str) else 'wood.dark')
        for xs, s in ((x0, -1), (x1, 1)):
            if t == 'gable':
                m.face(wk, [(xs, e, z0), (xs, e, z1), (xs, ridge - 0.05, zm)], (s, 0, 0))
            else:
                m.face(wk, [(xs, e, z0), (xs, e, z1), (xs, cut, zm + (d / 2) * kz), (xs, cut, zm - (d / 2) * kz)], (s, 0, 0))
                xe = x0 - o if s < 0 else x1 + o
                xi = xi0 if s < 0 else xi1
                slab_roof(m, key, [(xe, cut, zm - (d / 2) * kz - 0.02), (xe, cut, zm + (d / 2) * kz + 0.02), (xi, ridge, zm)], th, fk)
        if not lod:
            m.box('roof.slate' if key == 'roof.slate' else key, x0 - o, x1 + o, ridge - 0.04, ridge + 0.1, zm - 0.12, zm + 0.12)
        return ridge
    if t in ('hip', 'tent'):
        if d > w:
            swap_roof(m, dict(r, axis='z'), x0, x1, z0, z1, e, lod)
            return
        rh = d / 2 * math.tan(pitch)
        drop = o * math.tan(pitch)
        ridge = e + rh
        hx = d / 2 if t == 'hip' else w / 2
        if t == 'tent':
            rh = min(w, d) / 2 * math.tan(pitch)
            ridge = e + rh
        a0, a1 = (x0 + hx, x1 - hx) if t == 'hip' else ((x0 + x1) / 2, (x0 + x1) / 2)
        E = e - drop
        X0, X1, Z0, Z1 = x0 - o, x1 + o, z0 - o, z1 + o
        slab_roof(m, key, [(X0, E, Z1), (X1, E, Z1), (a1, ridge, zm), (a0, ridge, zm)], th, fk)
        slab_roof(m, key, [(X1, E, Z0), (X0, E, Z0), (a0, ridge, zm), (a1, ridge, zm)], th, fk)
        slab_roof(m, key, [(X0, E, Z0), (X0, E, Z1), (a0, ridge, zm)], th, fk)
        slab_roof(m, key, [(X1, E, Z1), (X1, E, Z0), (a1, ridge, zm)], th, fk)
        if not lod:
            gutter(m, X0, X1, E - 0.05, Z1 + 0.08)
            gutter(m, X0, X1, E - 0.05, Z0 - 0.08)
            if r.get('pipes', True):
                downpipes(m, (x0 + 0.2, x1 - 0.2), z1, 1, E - 0.05, Z1 + 0.08)
                downpipes(m, (x1 - 0.2,), z0, -1, E - 0.05, Z0 - 0.08)
        return ridge
    if t == 'mansard':
        ml = r.get('lower', 2.6)
        inset = r.get('inset', 0.9)
        E = e
        X0, X1, Z0, Z1 = x0 - 0.15, x1 + 0.15, z0 - 0.15, z1 + 0.15
        I0, I1, J0, J1 = x0 + inset, x1 - inset, z0 + inset, z1 - inset
        lk = r.get('lower_key', 'roof.slate')
        slab_roof(m, lk, [(X0, E, Z1), (X1, E, Z1), (I1, E + ml, J1), (I0, E + ml, J1)], th, fk)
        slab_roof(m, lk, [(X1, E, Z0), (X0, E, Z0), (I0, E + ml, J0), (I1, E + ml, J0)], th, fk)
        slab_roof(m, lk, [(X0, E, Z0), (X0, E, Z1), (I0, E + ml, J1), (I0, E + ml, J0)], th, fk)
        slab_roof(m, lk, [(X1, E, Z1), (X1, E, Z0), (I1, E + ml, J0), (I1, E + ml, J1)], th, fk)
        up = r.get('upper_pitch', 18)
        sub = dict(r, type='hip', pitch=up, over=0.12, key=r.get('key', 'roof.slate'))
        roof(m, sub, I0, I1, J0, J1, E + ml, lod)
        return
    if t == 'pent':
        rh = r.get('rise', d * math.tan(pitch))
        high_front = r.get('high', 'back') == 'front'
        zh, zl = (z1, z0) if high_front else (z0, z1)
        s = 1 if high_front else -1
        top, low = e + rh, e
        pts = [(x0 - o, low - o * math.tan(pitch), zl - s * o), (x1 + o, low - o * math.tan(pitch), zl - s * o), (x1 + o, top + 0.05, zh + s * 0.25), (x0 - o, top + 0.05, zh + s * 0.25)]
        slab_roof(m, key, pts, th, fk)
        for xs, sx in ((x0, -1), (x1, 1)):
            m.face(wk, [(xs, e, zl), (xs, e, zh), (xs, top, zh)], (sx, 0, 0))
        hw = r.get('high_wall', wk)
        m.face(hw, [(x0, e, zh), (x1, e, zh), (x1, top, zh), (x0, top, zh)], (0, 0, s))
        return
    if t == 'butterfly':
        rh = d / 2 * math.tan(pitch)
        top = e + rh
        for zs, s in ((z1, 1), (z0, -1)):
            slab_roof(m, key, [(x0 - o, e + 0.02, zm), (x1 + o, e + 0.02, zm), (x1 + o, top + o * math.tan(pitch), zs + s * o), (x0 - o, top + o * math.tan(pitch), zs + s * o)], th, fk)
        for xs, sx in ((x0, -1), (x1, 1)):
            m.face(wk, [(xs, e, z0), (xs, top, z0), (xs, e, zm)], (sx, 0, 0))
            m.face(wk, [(xs, e, zm), (xs, top, z1), (xs, e, z1)], (sx, 0, 0))
        return
    if t == 'shed':
        n = r.get('teeth', 2)
        rh = r.get('rise', 1.6)
        dz = d / n
        for i in range(n):
            za, zb = z0 + i * dz, z0 + (i + 1) * dz
            # Each tooth: sloping roof up towards the front (+z), glazed vertical face above the next tooth.
            slab_roof(m, key, [(x0 - o, e, za - (o if i == 0 else 0)), (x1 + o, e, za - (o if i == 0 else 0)), (x1 + o, e + rh, zb), (x0 - o, e + rh, zb)], th, fk)
            for xs, sx in ((x0, -1), (x1, 1)):
                m.face(wk, [(xs, e, za), (xs, e, zb), (xs, e + rh, zb)], (sx, 0, 0))
            m.face(r.get('glass_frame', 'frame.dark'), [(x0, e, zb), (x1, e, zb), (x1, e + 0.12, zb), (x0, e + 0.12, zb)], (0, 0, 1))
        return


def swap_roof(m, r, x0, x1, z0, z1, e, lod):
    """Builds a roof with its ridge along z by building it along x in a swapped mesh and copying it back."""
    tmp = M(m.pal)
    r2 = dict(r, axis='x')
    if r2.get('dormers_z'):
        r2['dormers'] = r2['dormers_z']
    roof(tmp, r2, z0, z1, -x1, -x0, e, lod)
    # (x, y, z) in tmp -> model (-z, y, x): rotation about y by 90°, keeps windings.
    from mathutils import Matrix
    rot = Matrix.Rotation(-math.pi / 2, 4, 'Z')
    bmesh.ops.transform(tmp.bm, matrix=rot, verts=tmp.bm.verts)
    me = bpy.data.meshes.new('tmp')
    tmp.bm.to_mesh(me)
    tmp.bm.free()
    m.bm.from_mesh(me)
    bpy.data.meshes.remove(me)
    # from_mesh re-creates layers by name; make sure our handles still point at them.
    m.uv = m.bm.loops.layers.uv['UVMap']
    m.col = m.bm.loops.layers.float_color['Color']


def slab_roof(m, key, pts, th, fk):
    m.slab(key, pts, th, edge=fk, under=fk)


def gutter(m, xa, xb, y, z):
    m.box('gutter', xa, xb, y - 0.1, y + 0.02, z - 0.06, z + 0.06)


def obox(m, key, c, a, b, d):
    """Box centred at c with the half-extent vectors a, b, d (any orientation)."""
    P = lambda i, j, k: tuple(c[n] + i * a[n] + j * b[n] + k * d[n] for n in range(3))
    for q in ([P(1, -1, -1), P(1, 1, -1), P(1, 1, 1), P(1, -1, 1)], [P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
              [P(-1, 1, -1), P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1)], [P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
              [P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)], [P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1), P(1, -1, -1)]):
        m.face(key, q, away=c)


def downpipes(m, xs, z_wall, s, y_top, z_gutter):
    """Downpipes from the gutter (top y_top at z_gutter) down a wall at z_wall (facing s) to the ground at the x positions."""
    for x in xs:
        m.cyl('gutter', 0.05, 0.05, y_top - 0.15, x, z_wall + s * 0.09, seg=6)
        m.box('gutter', x - 0.04, x + 0.04, y_top - 0.22, y_top - 0.12, min(z_wall + s * 0.04, z_gutter), max(z_wall + s * 0.04, z_gutter))
        m.box('gutter', x - 0.06, x + 0.06, 0.05, 0.25, min(z_wall + s * 0.09, z_wall + s * 0.3), max(z_wall + s * 0.09, z_wall + s * 0.3))


def rafters(m, x0, x1, zs, s, e, o, pitch, key='wood.dark', step=0.9):
    """Rafter ends under the eave overhang of a slope whose eave runs along x at the wall z = zs (outward s)."""
    cp, sp = math.cos(pitch), math.sin(pitch)
    n = (0, cp, s * sp)
    L = o / cp
    k = max(1, int((x1 - x0) / step))
    for i in range(k + 1):
        x = x0 + 0.1 + (x1 - x0 - 0.2) * i / k
        top = (x, e - o * math.tan(pitch) / 2, zs + s * o / 2)
        c = tuple(top[j] - n[j] * 0.26 for j in range(3))
        obox(m, key, c, (0.05, 0, 0), (0, 0.07 * cp, 0.07 * s * sp), (0, -sp * L / 2 * 0.98, s * cp * L / 2 * 0.98))


def slope_quad(x0, x1, z_eave, y_eave, z_ridge, y_ridge, t0, t1, lift):
    """Corner points of a strip of a roof slope between the fractions t0..t1 from the eave to the ridge."""
    za, zb = z_eave + (z_ridge - z_eave) * t0, z_eave + (z_ridge - z_eave) * t1
    ya, yb = y_eave + (y_ridge - y_eave) * t0 + lift, y_eave + (y_ridge - y_eave) * t1 + lift
    return [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)]


def solar_slope(m, x0, x1, z_eave, y_eave, z_ridge, y_ridge, t0=0.12, t1=0.82):
    """PV panels on a slope (eave and ridge lines along x), a thin dark slab just above the tiles."""
    rows = max(1, round((t1 - t0) * math.hypot(z_ridge - z_eave, y_ridge - y_eave) / 1.75))
    for i in range(rows):
        a = t0 + (t1 - t0) * i / rows + 0.006
        b = t0 + (t1 - t0) * (i + 1) / rows - 0.006
        m.slab('solar', slope_quad(x0, x1, z_eave, y_eave, z_ridge, y_ridge, a, b, 0.1), 0.04, edge='metal.light')


def solar_flat(m, x0, x1, z0, z1, y, tilt=math.radians(15)):
    """Rows of PV panels on a flat roof, tilted towards +z on low racks."""
    z = z0
    while z + 1.1 <= z1:
        pts = [(x0, y + 0.15, z + 1.0), (x1, y + 0.15, z + 1.0), (x1, y + 0.15 + math.sin(tilt), z + 1.0 - math.cos(tilt)), (x0, y + 0.15 + math.sin(tilt), z + 1.0 - math.cos(tilt))]
        m.slab('solar', pts, 0.04, edge='metal.light')
        for x in (x0 + 0.2, x1 - 0.2):
            m.box('metal.light', x - 0.03, x + 0.03, y, y + 0.15 + math.sin(tilt), z + 0.05, z + 0.11)
        z += 1.7


def skylight(m, g, x, z_eave, y_eave, z_ridge, y_ridge, t, w=0.8, h=1.1, lod=0):
    """Roof window on a slope (eave and ridge lines along x) at the fraction t up the slope."""
    L = math.hypot(z_ridge - z_eave, y_ridge - y_eave)
    dt = h / L / 2
    m.slab('frame.dark', slope_quad(x - w / 2, x + w / 2, z_eave, y_eave, z_ridge, y_ridge, t - dt, t + dt, 0.1), 0.1)
    gp = slope_quad(x - w / 2 + 0.07, x + w / 2 - 0.07, z_eave, y_eave, z_ridge, y_ridge, t - dt + 0.07 / L, t + dt - 0.07 / L, 0.112)
    g.face('glass', gp, newell_up(gp))


def newell_up(pts):
    n = newell(pts)
    return n if n[1] >= 0 else neg(n)


def dormer(m, g, x, zf, e_base, depth, h, lod, flat=False, w=1.6, key='wall', roof_key='roof', win=True, gl=None):
    """Dormer with its front at zf: walls from e_base up h, a window, a small roof; reaches depth back into the roof."""
    x0, x1 = x - w / 2, x + w / 2
    z0 = zf - depth
    m.box(key, x0, x1, e_base - 0.4, e_base + h, z0, zf)
    if flat:
        m.box('cap', x0 - 0.12, x1 + 0.12, e_base + h, e_base + h + 0.14, z0, zf + 0.15)
    else:
        rh = w / 2 * 0.75
        m.slab(roof_key, [(x0 - 0.15, e_base + h, zf + 0.2), (x0 - 0.15, e_base + h, z0), (x, e_base + h + rh, z0), (x, e_base + h + rh, zf + 0.2)], 0.1, edge='fascia')
        m.slab(roof_key, [(x1 + 0.15, e_base + h, z0), (x1 + 0.15, e_base + h, zf + 0.2), (x, e_base + h + rh, zf + 0.2), (x, e_base + h + rh, z0)], 0.1, edge='fascia')
        m.face(key, [(x0, e_base + h, zf), (x1, e_base + h, zf), (x, e_base + h + rh - 0.05, zf)], (0, 0, 1))
    if win and gl is not None:
        gl.face('glass', [(x0 + 0.25, e_base + 0.25, zf + 0.012), (x1 - 0.25, e_base + 0.25, zf + 0.012), (x1 - 0.25, e_base + h - 0.2, zf + 0.012), (x0 + 0.25, e_base + h - 0.2, zf + 0.012)], (0, 0, 1))
        if not lod:
            for a, b, c, d in ((x0 + 0.2, x1 - 0.2, e_base + 0.18, e_base + 0.25), (x0 + 0.2, x1 - 0.2, e_base + h - 0.2, e_base + h - 0.13),
                               (x0 + 0.18, x0 + 0.25, e_base + 0.18, e_base + h - 0.13), (x1 - 0.25, x1 - 0.18, e_base + 0.18, e_base + h - 0.13),
                               (x - 0.03, x + 0.03, e_base + 0.25, e_base + h - 0.2)):
                m.box('frame', a, b, c, d, zf, zf + 0.05)


def chimney(m, x, z, y0, y1, key='chimney'):
    m.box(key, x - 0.3, x + 0.3, y0, y1, z - 0.3, z + 0.3)
    m.box(key, x - 0.34, x + 0.34, y1 - 0.32, y1 - 0.2, z - 0.34, z + 0.34)
    m.box('cap', x - 0.36, x + 0.36, y1, y1 + 0.08, z - 0.36, z + 0.36)
    for dx in (-0.13, 0.13):
        m.cyl('terracotta' if key != 'stone' else 'concrete.dark', 0.08, y1 + 0.08, y1 + 0.32, x + dx, z, seg=6, r2=0.065)


def steps(m, x, z, w, n, rise=0.15, run=0.3, key='step'):
    """n steps down from the front door threshold (at z, height n * rise) towards +z."""
    for i in range(n):
        m.box(key, x - w / 2, x + w / 2, -0.4, rise * (n - i), z, z + run * (i + 1))


def canopy(m, x, z, w, depth, y, key='frame.dark', t=0.12):
    m.box(key, x - w / 2, x + w / 2, y, y + t, z, z + depth)


def railing(m, x0, x1, z0, z1, y, h=1.0, key='metal', lod=0, glass=None):
    """Bar railing around the open sides of a rectangle (front and both sides)."""
    for a, b, c, d in ((x0, x1, z1 - 0.04, z1), (x0, x0 + 0.04, z0, z1), (x1 - 0.04, x1, z0, z1)):
        m.box(key, a, b, y + h - 0.05, y + h, c, d)
        if lod:
            continue
        m.box(key, a, b, y + 0.1, y + 0.14, c, d)
        L = max(b - a, d - c)
        n = int(L / 0.12)
        for k in range(n + 1):
            t = k / max(1, n)
            if b - a > d - c:
                px = a + (b - a) * t
                m.box(key, px - 0.012, px + 0.012, y + 0.1, y + h, c + 0.01, d - 0.01)
            else:
                pz = c + (d - c) * t
                m.box(key, a + 0.01, b - 0.01, y + 0.1, y + h, pz - 0.012, pz + 0.012)


def balcony(m, x0, x1, z, depth, y, lod, key='concrete', rail='metal'):
    m.box(key, x0, x1, y - 0.18, y, z, z + depth)
    railing(m, x0, x1, z, z + depth, y, 1.0, rail, lod)


def column(m, x, z, y0, y1, r=0.17, key='column', lod=0, order='doric'):
    seg = 14 if lod == 0 else 8
    m.cyl(key, r, y0, y1, x, z, seg=seg)
    if lod == 0:
        m.box(key, x - r * 1.35, x + r * 1.35, y0, y0 + 0.14, z - r * 1.35, z + r * 1.35)
        m.box(key, x - r * 1.3, x + r * 1.3, y1 - 0.12, y1, z - r * 1.3, z + r * 1.3)
        m.cyl(key, r * 1.15, y1 - 0.24, y1 - 0.12, x, z, seg=seg, r2=r * 1.3)


def tower(m, g, x, z, r, y0, y1, roof_h, lod, key='wall', roof_key='roof.slate', seg=8, win_rows=(), cap='copper'):
    """Polygonal corner tower with windows on its faces and a pointed roof."""
    pts = [(x + r * math.cos(2 * math.pi * (i + 0.5) / seg), z + r * math.sin(2 * math.pi * (i + 0.5) / seg)) for i in range(seg)]
    m.prism(key, pts, -2.5, y1)
    for i in range(seg):
        a, b = pts[i], pts[(i + 1) % seg]
        mx, mz = (a[0] + b[0]) / 2, (a[1] + b[1]) / 2
        nx, nz = mx - x, mz - z
        l = math.hypot(nx, nz)
        nx, nz = nx / l, nz / l
        if nz < -0.3:
            continue
        ux, uz = (b[0] - a[0]), (b[1] - a[1])
        L = math.hypot(ux, uz)
        ux, uz = ux / L, uz / L
        for ya, yb in win_rows:
            ww = L * 0.5
            c0 = (mx - ux * ww / 2 + nx * 0.02, mz - uz * ww / 2 + nz * 0.02)
            c1 = (mx + ux * ww / 2 + nx * 0.02, mz + uz * ww / 2 + nz * 0.02)
            g.face('glass', [(c0[0], ya, c0[1]), (c1[0], ya, c1[1]), (c1[0], yb, c1[1]), (c0[0], yb, c0[1])], (nx, 0, nz))
            if not lod:
                m.boxc('stone', (ww + 0.16, 0.08, 0.1), (mx + nx * 0.05, ya - 0.04, mz + nz * 0.05), roty=math.atan2(-nz, nx) + math.pi / 2)
                m.boxc('frame', (ww, 0.06, 0.05), (mx + nx * 0.03, yb, mz + nz * 0.03), roty=math.atan2(-nz, nx) + math.pi / 2)
    m.box('stone', x - r - 0.12, x + r + 0.12, y1 - 0.25, y1, z - r - 0.12, z + r + 0.12) if lod else m.prism('stone', [(x + (r + 0.12) * math.cos(2 * math.pi * (i + 0.5) / seg), z + (r + 0.12) * math.sin(2 * math.pi * (i + 0.5) / seg)) for i in range(seg)], y1 - 0.25, y1)
    m.cyl(roof_key, r + 0.25, y1, y1 + roof_h, x, z, seg=seg, r2=0.02)
    m.cyl(cap, 0.04, y1 + roof_h - 0.1, y1 + roof_h + 0.8, x, z, seg=6)
    m.ball(cap, 0.12, (x, y1 + roof_h + 0.3, z), seg=8, rings=5)


def solar(m, x0, x1, z0, z1, y0, y1, n_rows=1):
    """Photovoltaic panels on a sloping roof plane between (z0, y0) and (z1, y1)."""
    for i in range(n_rows):
        t0, t1 = i / n_rows + 0.05, (i + 1) / n_rows - 0.05
        za, zb = z0 + (z1 - z0) * t0, z0 + (z1 - z0) * t1
        ya, yb = y0 + (y1 - y0) * t0 + 0.06, y0 + (y1 - y0) * t1 + 0.06
        m.slab('solar', [(x0, ya, za), (x1, ya, za), (x1, yb, zb), (x0, yb, zb)], 0.04, edge='metal.light')


BASE['solar'] = (0x141a26, 'paint', 0)


# ---------------------------------------------------------------- the catalogue

def model(id):
    return next(c for c in CAT['models'] if c['id'] == id)


def V(x0, x1, z0, z1, **k):
    d = dict(x0=x0, x1=x1, z0=z0, z1=z1)
    d.update(k)
    return d


def dr(x, kind='door', w=1.1, h=2.2, **extra):
    return (x, kind, w, h, extra)


def build_house(id, lod):
    c = model(id)
    hw, hd = c['w'] / 2, c['d'] / 2
    fn = BUILDERS[id]
    m = M(BASE, PALETTES.get(c['style']))
    g = M(GLASS)
    fn(m, g, lod, hw, hd, c)
    return m, g


PALETTES = {
    'modern': {'wall': (0xf2f0ec, 'plaster', 1), 'frame': (0x34373b, 'paint', 0), 'reveal': (0xf0eee8, 'plaster', 1), 'plinth': (0x5a5c5e, 'concrete', 0), 'sill': (0x4a4c50, 'metal', 0)},
    'antik': {'wall': (0xe8d8b8, 'plaster', 1), 'plinth': (0xa89070, 'stone', 0), 'frame': (0xf2f0ea, 'paint', 0), 'sill': (0xc8b490, 'stone', 0)},
    'architekt': {'wall': (0xb8b6b0, 'concrete', 0), 'frame': (0x2c2e31, 'paint', 0), 'plinth': (0x5a5c5e, 'concrete', 0), 'reveal': (0x2c2e31, 'paint', 0), 'sill': (0x2c2e31, 'metal', 0)},
    'landhaus': {'wall': (0xf0ead8, 'plaster', 1), 'plinth': (0x8a7a62, 'stone', 0), 'frame': (0xf2f0ea, 'paint', 0)},
    'klassisch': {'wall': (0xeee6d2, 'plaster', 1), 'plinth': (0x8c8880, 'rough', 0), 'frame': (0xf2f2ee, 'paint', 0)},
    'stadtvilla': {'wall': (0xf2eadc, 'plaster', 1), 'plinth': (0x8c8478, 'rough', 0), 'frame': (0xf2f2ee, 'paint', 0)},
    'villa': {'wall': (0xf0e8d8, 'plaster', 1), 'plinth': (0x9a8a70, 'stone', 0)},
    'verwaltung': {'wall': (0xe2d4b8, 'plaster', 1), 'plinth': (0x9a8a70, 'stone', 0), 'sill': (0xc8b490, 'stone', 0)},
}

MODERN_WIN = dict(w=1.6, h=1.6, sill=0.6, gap=1.4, margin=1.1, deco={'deepframe': True}, frame='frame.dark', transom=False, blind='frame.dark')
ANTIK_WIN = dict(w=1.05, h=1.75, sill=0.8, gap=1.2, margin=1.0, deco={'sill': True, 'surround': True, 'pediment': 'mixed'})
LAND_WIN = dict(w=0.95, h=1.25, sill=0.85, gap=1.1, margin=0.9, deco={'sill': True, 'shutters': True, 'flowerbox': True})
KLASS_WIN = dict(w=1.25, h=1.35, sill=0.9, gap=1.3, margin=1.0, deco={'sill': True}, blind='metal.light')
VILLA_WIN = dict(w=1.1, h=1.6, sill=0.8, gap=1.2, margin=1.1, deco={'sill': True, 'surround': True})


# --- modern

def modern_kubus(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=2, fh=3.0, win=MODERN_WIN, roof=dict(type='flat', parapet=0.3),
          doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)],
          side_win={'front': dict(n=2)})
    e = volume(m, g, v, lod)
    solar_flat(m, -hw + 1.0, hw - 1.0, -hd + 1.0, hd - 1.0, e)
    # Slim canopy over the door.
    canopy(m, c['door'], hd, 2.2, 1.2, 2.85)
    steps(m, c['door'], hd, 1.6, 2)


def modern_versatz(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw - 2.5, -hd, hd, floors=1, fh=3.0, win=dict(MODERN_WIN, w=2.4, h=2.2, sill=0.15), roof=dict(type='flat', parapet=0.2),
                    doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)]), lod)
    volume(m, g, V(-hw + 2.0, hw, -hd + 0.5, hd + 1.5, y0=3.45, plinth=0, floors=1, fh=3.0, win=dict(MODERN_WIN, w=2.0, h=1.5, sill=0.7), roof=dict(type='flat', parapet=0.3), wall='wall2'), lod)
    # The cantilevered upper floor rests on a steel post.
    m.box('metal', hw - 0.25, hw - 0.05, 0, 3.45, hd + 1.2, hd + 1.4)
    steps(m, c['door'], hd, 1.6, 2)


def modern_holzbox(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, win=MODERN_WIN, roof=dict(type='flat', parapet=0.3),
                    doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)], side_win={'front': dict(n=2, margin=0.9)}), lod)
    # Larch box on the upper floor, projecting from the front.
    bx0, bx1 = -hw + 0.6, -hw + 4.6
    v = V(bx0, bx1, hd - 1.0, hd + 0.9, y0=3.4, plinth=0, floors=1, fh=2.9, wall='wood', reveal='frame.dark',
          win=dict(MODERN_WIN, w=2.6, h=1.6, sill=0.6, n=1, deco={}), sides=('front',), roof=dict(type='flat', parapet=0.15, parapet_key='wood', cap='metal'))
    volume(m, g, v, lod)
    canopy(m, c['door'], hd, 2.0, 1.0, 2.8)
    steps(m, c['door'], hd, 1.6, 2)


def modern_bungalow(m, g, lod, hw, hd, c):
    gx = c['garage']
    volume(m, g, V(-hw, hw - 3.2, -hd, hd, floors=1, fh=3.0, win=dict(MODERN_WIN, w=2.8, h=2.1, sill=0.25, gap=1.0),
                    roof=dict(type='flat', parapet=0.25, overhang=0.9), doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)]), lod)
    volume(m, g, V(hw - 3.2, hw, -hd + 1, hd, floors=1, fh=2.9, wall='wood.grey', reveal='frame.dark', sides=(), garages=[(gx, 2.6)],
                    roof=dict(type='flat', parapet=0.2, parapet_key='wood.grey', cap='metal')), lod)
    steps(m, c['door'], hd, 1.6, 2)


def modern_dachterrasse(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, win=MODERN_WIN, roof=dict(type='flat', parapet=0.15),
                    doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)], side_win={'front': dict(n=2, w=1.8)}), lod)
    # Penthouse box at the back, roof terrace with a railing in front of it.
    e = 0.45 + 6.0
    volume(m, g, V(-hw + 0.3, hw - 3.2, -hd + 0.3, hd - 4.0, y0=e, plinth=0, floors=1, fh=2.8, wall='wall2',
                    win=dict(MODERN_WIN, w=2.2, h=2.2, sill=0.1, n=1), sides=('front',), roof=dict(type='flat', parapet=0.15)), lod)
    railing(m, -hw + 0.1, hw - 0.1, -hd + 0.1, hd - 0.1, e + 0.15, 1.0, 'metal', lod)
    # Glass stair tower at the side.
    m.box('frame.dark', hw - 2.9, hw - 0.3, e, e + 2.8, -hd + 0.3, -hd + 3.0)
    g.face('glass', [(hw - 2.85, e + 0.1, -hd + 3.012), (hw - 0.35, e + 0.1, -hd + 3.012), (hw - 0.35, e + 2.7, -hd + 3.012), (hw - 2.85, e + 2.7, -hd + 3.012)], (0, 0, 1))
    canopy(m, c['door'], hd, 1.8, 1.0, 2.8)
    steps(m, c['door'], hd, 1.6, 2)


# --- antik

def antik_walmdach(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=2, fh=3.3, plinth=0.75, win=ANTIK_WIN, quoins=True, bands=True, cornice=0.22, brackets=True,
          roof=dict(type='hip', pitch=38, key='roof.slate', over=0.35), doors=[dr(0, 'door', 1.3, 2.6, door='door.white')])
    e = volume(m, g, v, lod)
    portico(m, 0, hd, 2.6, 1.6, 3.3, lod)
    steps(m, 0, hd + 1.6, 2.0, 4, rise=0.18)
    chimney(m, -hw + 2, 0, e, e + 3.2)
    chimney(m, hw - 2, 0, e, e + 3.2)
    for x in (-hw + 2.4, hw - 2.4):
        dormer(m, g, x, hd - 0.9, e + 0.6, 2.0, 1.5, lod, w=1.5, roof_key='roof.slate', gl=g)


def portico(m, x, z, w, depth, h, lod, key='column'):
    """Columned porch with a triangular pediment in front of the door."""
    for s in (-1, 1):
        column(m, x + s * (w / 2 - 0.25), z + depth - 0.25, 0.7, 0.7 + h - 0.35, lod=lod)
    m.box('stone', x - w / 2, x + w / 2, 0.7 + h - 0.35, 0.7 + h, z, z + depth)
    ph = 0.7
    y = 0.7 + h
    m.face('stone', [(x - w / 2 - 0.1, y, z + depth + 0.02), (x + w / 2 + 0.1, y, z + depth + 0.02), (x, y + ph, z + depth + 0.02)], (0, 0, 1))
    m.slab('roof.slate', [(x - w / 2 - 0.15, y, z + depth + 0.05), (x - w / 2 - 0.15, y, z), (x, y + ph + 0.05, z), (x, y + ph + 0.05, z + depth + 0.05)], 0.08, edge='stone')
    m.slab('roof.slate', [(x + w / 2 + 0.15, y, z), (x + w / 2 + 0.15, y, z + depth + 0.05), (x, y + ph + 0.05, z + depth + 0.05), (x, y + ph + 0.05, z)], 0.08, edge='stone')


def antik_mansarde(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=2, fh=3.3, plinth=0.75, win=dict(ANTIK_WIN, deco={'sill': True, 'surround': True, 'pediment': 'straight'}),
          quoins=True, bands=True, cornice=0.25, brackets=True, roof=dict(type='mansard', lower=2.7, inset=1.0, key='roof.slate'),
          doors=[dr(0, 'door', 1.3, 2.6, door='door.white')])
    e = volume(m, g, v, lod)
    for x in spread(c['w'], 1.2, 1.6, 1.6, 3):
        dormer(m, g, x - hw, hd - 0.15, e + 0.4, 0.9, 1.55, lod, w=1.3, roof_key='roof.slate', gl=g)
    canopy(m, 0, hd, 2.2, 1.0, 3.0, key='metal')
    steps(m, 0, hd, 2.0, 4, rise=0.18)
    chimney(m, hw - 2.2, -1, e + 2.7, e + 4.6)


def antik_risalit(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.3, plinth=0.75, win=dict(ANTIK_WIN, deco={'sill': True, 'surround': True}), quoins=True, bands=True,
                        cornice=0.2, roof=dict(type='hip', pitch=36, key='roof.slate', over=0.3), side_win={'front': dict(n=4, margin=0.8)}), lod)
    # Central projection with its own gable (Giebelrisalit) and the entrance.
    rv = V(-2.0, 2.0, hd - 0.1, hd + 0.6, floors=2, fh=3.3, plinth=0.75, quoins=True, bands=True, wall='wall2',
           win=dict(ANTIK_WIN, w=1.2, n=1, deco={'sill': True, 'surround': True, 'pediment': 'triangle'}), sides=('front',),
           doors=[dr(0, 'door', 1.4, 2.7, door='door.white')], roof=dict(type='gable', axis='z', pitch=34, key='roof.slate', over=0.25, wall='wall2'))
    volume(m, g, rv, lod)
    steps(m, 0, hd + 0.6, 2.4, 4, rise=0.18)
    chimney(m, -hw + 1.8, -1.5, e, e + 3.0)


def antik_erker(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.3, plinth=0.75, win=ANTIK_WIN, quoins=True, bands=True, cornice=0.2, brackets=True,
                        roof=dict(type='hip', pitch=40, key='roof.slate', over=0.3), doors=[dr(c['door'], 'door', 1.2, 2.6, door='door.white')],
                        side_win={'front': dict(n=2, margin=1.1)}), lod)
    tower(m, g, hw - 0.6, hd - 0.6, 1.9, 0, e + 1.4, 4.2, lod, key='wall', win_rows=[(1.6, 3.1), (4.9, 6.4), (e + 0.1, e + 1.1)])
    canopy(m, c['door'], hd, 1.8, 0.9, 3.0, key='metal')
    steps(m, c['door'], hd, 1.8, 4, rise=0.18)
    chimney(m, -hw + 2, -1, e, e + 3.0)


def antik_biedermeier(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, plinth=0.6, win=dict(ANTIK_WIN, h=1.5, deco={'sill': True, 'surround': True, 'shutters': True}, n=3),
                        bands=True, roof=dict(type='gable', axis='z', pitch=45, key='roof', over=0.3), doors=[dr(0, 'door', 1.2, 2.4, door='door.white')]), lod)
    m.box('stone', -1.2, 1.2, 2.7, 2.85, hd, hd + 0.35)
    steps(m, 0, hd, 1.8, 3, rise=0.18)
    g.face('glass', [(-0.5, e + 1.2, hd + 0.012), (0.5, e + 1.2, hd + 0.012), (0.5, e + 2.3, hd + 0.012), (-0.5, e + 2.3, hd + 0.012)], (0, 0, 1))
    m.box('frame', -0.58, 0.58, e + 1.12, e + 1.2, hd, hd + 0.05)
    chimney(m, 1.5, -1, e + 2, e + 4.6)


# --- architekt

def architekt_pultdach(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw - 4.5, -hd, hd, floors=2, fh=3.0, wall='wood.grey', reveal='frame.dark', win=dict(MODERN_WIN, w=0.9, h=2.2, sill=0.4, gap=1.6, deco={}),
                    roof=dict(type='pent', pitch=12, high='front', key='roof.metal', over=0.3, wall='wood.grey'), doors=[dr(c['door'], 'door', 1.1, 2.4, door='wood', panels=False, light=False)]), lod)
    volume(m, g, V(hw - 4.5, hw, -hd + 0.8, hd - 0.4, floors=1, fh=3.2, wall='concrete', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=3.4, h=2.6, sill=0.1, n=1, deco={}), sides=('front', 'right'), roof=dict(type='flat', parapet=0.2, parapet_key='concrete')), lod)
    m.box('concrete', -hw - 0.6, hw - 4.5, 2.95, 3.15, hd, hd + 1.4)
    e = 0.45 + 6.0
    solar_slope(m, -hw + 0.5, hw - 5.0, -hd, e, hd, e + c['d'] * math.tan(math.radians(12)), 0.08, 0.9)
    steps(m, c['door'], hd, 1.4, 2)


def architekt_kragarm(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw - 3.5, -hd, hd - 1.0, floors=1, fh=3.0, wall='concrete', reveal='frame.dark', win=dict(MODERN_WIN, w=2.6, h=2.3, sill=0.15, deco={}),
                    roof=dict(type='flat', parapet=0.1, parapet_key='concrete'), doors=[dr(c['door'], 'door', 1.2, 2.4, door='door.dark', panels=False)]), lod)
    # The upper floor, a long dark box, cantilevers 3.5 m over the entrance and the garden.
    volume(m, g, V(-hw + 1.0, hw, -hd + 0.5, hd, y0=3.45, plinth=0, floors=1, fh=3.0, wall='metal', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=4.2, h=1.4, sill=0.8, n=1, deco={}), sides=('front', 'right', 'back'), roof=dict(type='flat', parapet=0.1, parapet_key='metal', cap='metal')), lod)
    steps(m, c['door'], hd - 1.0, 1.4, 2)


def architekt_schmetterling(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, wall='wall', win=dict(MODERN_WIN, w=1.2, h=1.8, sill=0.5, deco={'deepframe': True}, n=3),
                    side_keys={'left': 'wood', 'right': 'wood'}, roof=dict(type='butterfly', pitch=10, key='roof.metal', over=0.5, wall='wall'),
                    doors=[dr(c['door'], 'door', 1.2, 2.4, door='wood', panels=False)]), lod)
    canopy(m, c['door'], hd, 2.0, 1.2, 2.9, key='concrete')
    steps(m, c['door'], hd, 1.6, 2)


def architekt_shed(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=2.9, wall='brick.dark', reveal='frame.dark', win=dict(MODERN_WIN, w=1.0, h=2.0, sill=0.5, gap=1.0, deco={}),
                    roof=dict(type='shed', teeth=2, rise=1.5, key='roof.metal', over=0.2, wall='brick.dark'), doors=[dr(c['door'], 'door', 1.1, 2.3, door='door.dark', panels=False)]), lod)
    e = 0.45 + 5.8
    for i in range(2):
        zb = -hd + (i + 1) * (2 * hd) / 2
        g.face('glass', [(-hw + 0.3, e + 0.15, zb + 0.012), (hw - 0.3, e + 0.15, zb + 0.012), (hw - 0.3, e + 1.35, zb + 0.012), (-hw + 0.3, e + 1.35, zb + 0.012)], (0, 0, 1))
    steps(m, c['door'], hd, 1.4, 2)


def architekt_scheune(m, g, lod, hw, hd, c):
    # Barn-like house: no overhangs, dark metal roof and gables, a big glazed gable to the side.
    v = V(-hw, hw, -hd, hd, floors=1, fh=3.0, knee=0.4, wall='wood.dark', reveal='frame.dark',
          win=dict(MODERN_WIN, w=1.8, h=2.2, sill=0.2, gap=1.4, deco={}), roof=dict(type='gable', pitch=45, key='roof.metal', over=0.05, wall='wood.dark', fascia='roof.metal'),
          doors=[dr(c['door'], 'door', 1.2, 2.3, door='door.dark', panels=False)])
    e = volume(m, g, v, lod)
    rh = hd * math.tan(math.radians(45))
    for x in (-3.4, -0.4):
        skylight(m, g, x, hd, e, 0, e + rh, 0.5, w=1.0, h=1.3, lod=lod)
    g.face('glass', [(-hw - 0.012, e + 0.2, -1.5), (-hw - 0.012, e + 0.2, 1.5), (-hw - 0.012, e + rh - 1.6, 0)], (-1, 0, 0))
    m.box('concrete', -1.0, 6.0, -0.4, 0.15, hd, hd + 2.0)


# --- landhaus

def landhaus_fachwerk(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=2, fh=2.7, wall='wall', fachwerk=True, win=dict(LAND_WIN, deco={'flowerbox': True, 'flowerbox_floor': 1}),
          roof=dict(type='gable', pitch=52, key='roof', over=0.45, rafters=True), doors=[dr(c['door'], 'door', 1.1, 2.2)])
    e = volume(m, g, v, lod)
    rh = hd * math.tan(math.radians(52))
    for x in (-2.4, 1.6):
        skylight(m, g, x, -hd, e, 0, e + rh, 0.42, lod=lod)
    for s, xs in ((-1, -hw), (1, hw)):
        g.face('glass', [(xs + s * 0.012, e + 0.9, -0.45), (xs + s * 0.012, e + 0.9, 0.45), (xs + s * 0.012, e + 1.9, 0.45), (xs + s * 0.012, e + 1.9, -0.45)], (s, 0, 0))
    chimney(m, 2.5, -1, e, e + rh + 0.6)
    steps(m, c['door'], hd, 1.5, 3)


def landhaus_steinsockel(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=1, fh=2.9, wall='stone', reveal='stone', win=dict(LAND_WIN, deco={'sill': True, 'shutters': True}),
                    doors=[dr(c['door'], 'door', 1.2, 2.3)]), lod)
    e = volume(m, g, V(-hw - 0.15, hw + 0.15, -hd - 0.15, hd + 0.15, y0=0.45 + 2.9, plinth=0, floors=1, fh=2.7, fachwerk=True,
                        win=dict(LAND_WIN, deco={'flowerbox': True, 'flowerbox_floor': 0}), roof=dict(type='gable', pitch=48, key='roof', over=0.5, rafters=True)), lod)
    for x in (-2.5, 2.5):
        dormer(m, g, x, hd - 0.6, e + 0.8, 1.8, 1.3, lod, w=1.4, gl=g)
    chimney(m, -3, 0, e, e + 4.5)
    steps(m, c['door'], hd, 1.6, 3)


def landhaus_kruppelwalm(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=2.8, wall='wall', win=dict(LAND_WIN, deco={'sill': True, 'shutters': True}, n=4),
                        roof=dict(type='kruppel', pitch=46, key='roof', over=0.45, kruppel=0.35, rafters=True), doors=[dr(0, 'door', 1.2, 2.3, door='wood.dark')]), lod)
    canopy(m, 0, hd, 2.4, 1.2, 2.75, key='wood.dark')
    for s in (-1, 1):
        m.box('wood.dark', s * 1.1 - 0.08, s * 1.1 + 0.08, 0.45, 2.75, hd + 1.0, hd + 1.16)
    steps(m, 0, hd, 1.8, 3)
    chimney(m, -2.5, -1.2, e, e + 4.6)


def landhaus_gauben(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=1, fh=2.9, knee=0.5, wall='wall', win=dict(LAND_WIN, deco={'sill': True, 'shutters': True, 'shutter': 'shutter.blue'}),
          roof=dict(type='gable', pitch=45, key='roof.slate', over=0.5), doors=[dr(0, 'door', 1.2, 2.3, door='door.white')])
    e = volume(m, g, v, lod)
    for x in (-3.0, 0, 3.0):
        dormer(m, g, x, hd - 0.4, e + 0.4, 2.2, 1.45, lod, w=1.6, roof_key='roof.slate', gl=g)
    # Veranda across the front: wooden posts, a lean-to roof and a railing.
    for x in (-hw + 0.3, -1.4, 1.4, hw - 0.3):
        m.box('white', x - 0.08, x + 0.08, 0.45, 2.75, hd + 2.0, hd + 2.16)
    m.slab('roof.slate', [(-hw - 0.1, 2.75, hd + 2.3), (hw + 0.1, 2.75, hd + 2.3), (hw + 0.1, 3.3, hd), (-hw - 0.1, 3.3, hd)], 0.1, edge='white')
    m.box('wood', -hw, hw, 0.0, 0.45, hd, hd + 2.2)
    if not lod:
        for a, b in ((-hw + 0.3, -1.6), (1.6, hw - 0.3)):
            m.box('white', a, b, 1.25, 1.33, hd + 2.04, hd + 2.12)
            for k in range(int((b - a) / 0.15)):
                x = a + k * 0.15
                m.box('white', x, x + 0.04, 0.45, 1.25, hd + 2.06, hd + 2.1)
    steps(m, 0, hd + 2.2, 1.8, 3)
    chimney(m, 3.5, -1.5, e, e + 4.4)


def landhaus_cottage(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=1, fh=2.8, knee=0.4, wall='stone', reveal='stone', plinth=0.3,
          win=dict(LAND_WIN, w=0.9, h=1.2, deco={'sill': True, 'flowerbox': True, 'flowerbox_floor': 0}),
          roof=dict(type='gable', pitch=50, key='roof.slate', over=0.35, wall='stone', rafters=True), doors=[dr(c['door'], 'door', 1.0, 2.1, door='shutter')])
    e = volume(m, g, v, lod)
    dormer(m, g, -1.5, hd - 0.3, e + 0.5, 1.6, 1.3, lod, w=1.3, roof_key='roof.slate', gl=g)
    chimney(m, -hw + 0.6, 0, e - 1, e + hd * math.tan(math.radians(50)) + 0.8, key='stone')
    m.slab('roof.slate', [(c['door'] - 0.9, 2.55, hd + 1.0), (c['door'] + 0.9, 2.55, hd + 1.0), (c['door'] + 0.9, 2.95, hd), (c['door'] - 0.9, 2.95, hd)], 0.08, edge='wood.dark')
    steps(m, c['door'], hd, 1.3, 2)


# --- klassisch

def klassisch_siedlung(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=1, fh=2.8, knee=0.6, win=dict(KLASS_WIN, n=2), roof=dict(type='gable', axis='z', pitch=48, key='roof', over=0.4, rafters=True),
          doors=[dr(c['door'], 'door', 1.0, 2.2, door='wood')])
    e = volume(m, g, v, lod)
    g.face('glass', [(-0.6, e + 1.0, hd + 0.012), (0.6, e + 1.0, hd + 0.012), (0.6, e + 2.2, hd + 0.012), (-0.6, e + 2.2, hd + 0.012)], (0, 0, 1))
    m.box('frame', -0.68, 0.68, e + 0.93, e + 1.0, hd, hd + 0.06)
    m.box('fascia', c['door'] - 0.8, c['door'] + 0.8, 2.55, 2.65, hd, hd + 0.9)
    chimney(m, 1.0, -1.5, e, e + 4.4)
    steps(m, c['door'], hd, 1.3, 3)


def klassisch_klinker(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=2.75, wall='brick', reveal='brick', win=dict(KLASS_WIN, deco={'sill': True, 'lintel': True}),
                        roof=dict(type='gable', pitch=38, key='roof.slate', over=0.5), doors=[dr(c['door'], 'door', 1.1, 2.2, door='door.white')],
                        ops={'front': lambda L, H: [(1.3, 0.0, 2.4, 2.2, 'door', {}), (4.0, 0.85, 5.5, 2.2, 'win', {'floor': 0}), (L - 2.6, 0.85, L - 1.1, 2.2, 'win', {'floor': 0}),
                                                     (1.3, 3.6, 2.5, 4.95, 'win', {'floor': 1}), (L - 4.2, 2.75, L - 1.0, 5.0, 'glassdoor', {'bars': 1})]}), lod)
    balcony(m, hw - 4.4, hw - 0.8, hd, 1.4, 0.45 + 2.75, lod)
    chimney(m, -2, -1, e, e + 3.6)
    canopy(m, -hw + 1.85, hd, 1.8, 1.0, 2.8, key='metal')
    steps(m, -hw + 1.85, hd, 1.5, 2)


def klassisch_bungalow(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=1, fh=2.75, win=dict(KLASS_WIN, w=1.6, gap=1.4), roof=dict(type='hip', pitch=24, key='roof', over=0.7),
                        doors=[dr(c['door'], 'door', 1.1, 2.2, door='wood')], side_keys={'front': 'wall'}), lod)
    m.box('brick', -hw - 0.01, -hw + 4.0, 0.45, 3.2, hd - 0.02, hd + 0.02)
    solar_slope(m, -2.4, 2.4, hd, e, 0, e + hd * math.tan(math.radians(24)), 0.15, 0.7)
    chimney(m, -3, 0, e, e + 2.6)
    steps(m, c['door'], hd, 1.4, 2)


def klassisch_garage(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw - 3.3, -hd, hd, floors=2, fh=2.75, win=dict(KLASS_WIN, n=2), roof=dict(type='gable', pitch=42, key='roof', over=0.45),
                        doors=[dr(c['door'], 'door', 1.1, 2.2, door='wood')]), lod)
    volume(m, g, V(hw - 3.3, hw, -hd, hd - 0.6, floors=1, fh=2.6, sides=(), garages=[(c['garage'], 2.6)], wall='wall2', roof=dict(type='flat', parapet=0.15)), lod)
    rh = hd * math.tan(math.radians(42))
    solar_slope(m, -hw + 0.9, hw - 4.6, hd, e, 0, e + rh)
    skylight(m, g, -2.0, -hd, e, 0, e + rh, 0.45, lod=lod)
    chimney(m, -2.5, -1, e, e + 3.4)
    canopy(m, c['door'], hd, 1.6, 0.9, 2.7, key='metal')
    steps(m, c['door'], hd, 1.4, 2)


def klassisch_zeltdach(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=2.75, wall='wall', win=dict(KLASS_WIN, n=2, deco={'sill': True, 'shutters': True, 'shutter': 'shutter.white'}),
                        roof=dict(type='tent', pitch=28, key='roof', over=0.6), doors=[dr(0, 'door', 1.1, 2.2, door='wood')], plinth_key='brick'), lod)
    m.box('brick', -hw - 0.02, hw + 0.02, 0.45, 1.0, -hd - 0.02, hd + 0.02)
    steps(m, 0, hd, 1.4, 3)
    chimney(m, 1.5, 1.5, e, e + 3.2)


# --- stadtvilla

def stadtvilla_zeltdach(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, win=dict(VILLA_WIN, n=3, deco={'sill': True}, blind='metal.light'), bands=True, band_key='wall2',
                        roof=dict(type='tent', pitch=22, key='roof.slate', over=0.7), doors=[dr(0, 'door', 1.2, 2.4, door='door.dark')]), lod)
    canopy(m, 0, hd, 2.0, 1.2, 2.9, key='metal')
    steps(m, 0, hd, 1.6, 3)


def stadtvilla_toskana(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, wall='wall', win=dict(VILLA_WIN, deco={'sill': True, 'shutters': True, 'shutter': 'shutter.white'}),
                        roof=dict(type='hip', pitch=22, key='terracotta', over=0.6), doors=[dr(c['door'], 'door', 1.2, 2.4, door='wood')],
                        side_win={'front': dict(n=3)}), lod)
    # Loggia: arched openings across one side of the ground floor.
    x0 = 0.5
    for i in range(3):
        x = x0 + i * 1.8
        m.box('column', x - 0.15, x + 0.15, 0.45, 2.7, hd, hd + 1.6)
    m.box('wall', x0 - 0.15, x0 + 2 * 1.8 + 0.15, 2.7, 3.45, hd, hd + 1.6)
    m.slab('terracotta', [(x0 - 0.3, 3.45, hd + 1.8), (x0 + 3.9, 3.45, hd + 1.8), (x0 + 3.9, 3.9, hd), (x0 - 0.3, 3.9, hd)], 0.1, edge='wall')
    steps(m, c['door'], hd, 1.4, 3)
    chimney(m, -2, -1, e, e + 2.6, key='wall')


def stadtvilla_erker(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.0, win=dict(VILLA_WIN, deco={'sill': True}, blind='frame.dark'), roof=dict(type='hip', pitch=25, key='roof.slate', over=0.6),
                        doors=[dr(c['door'], 'door', 1.2, 2.4, door='door.dark')], side_win={'front': dict(n=2, margin=0.8)}), lod)
    # Bay window over both floors on the left of the front.
    bv = V(-3.6, -1.0, hd, hd + 1.0, floors=2, fh=3.0, wall='wall2', win=dict(VILLA_WIN, w=1.6, n=1, deco={'sill': True}), sides=('front', 'left', 'right'),
           side_win={'left': dict(w=0.5, n=1, margin=0.25), 'right': dict(w=0.5, n=1, margin=0.25)}, roof=dict(type='flat', parapet=0.25))
    volume(m, g, bv, lod)
    balcony(m, 0.6, 3.8, hd, 1.2, 0.45 + 3.0, lod, rail='metal')
    steps(m, c['door'], hd, 1.6, 3)


def stadtvilla_schwedenhaus(m, g, lod, hw, hd, c):
    v = V(-hw, hw, -hd, hd, floors=1, fh=2.8, knee=0.5, wall='wood.red', reveal='white', plinth=0.4,
          win=dict(LAND_WIN, deco={'sill': True}, frame='white'), side_keys={},
          roof=dict(type='gable', pitch=42, key='roof.slate', over=0.4, wall='wood.red', rafters='white'), doors=[dr(0, 'door', 1.1, 2.2, door='door.white')])
    e = volume(m, g, v, lod)
    # White corner boards and window trims.
    if not lod:
        for x, z in ((-hw, -hd), (hw, -hd), (-hw, hd), (hw, hd)):
            m.box('white', x - 0.1, x + 0.1, 0.4, e, z - 0.1, z + 0.1)
    for x in (-2.8, 2.8):
        dormer(m, g, x, hd - 0.5, e + 0.4, 1.8, 1.3, lod, w=1.4, roof_key='roof.slate', key='wood.red', gl=g)
    m.box('wood', -2.5, 2.5, 0.0, 0.4, hd, hd + 2.0)
    railing(m, -2.5, 2.5, hd, hd + 2.0, 0.4, 0.9, 'white', lod)
    m.box('white', -1.1, 1.1, 2.6, 2.7, hd, hd + 1.0)


def stadtvilla_mediterran(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=1, fh=3.0, wall='wall', win=dict(VILLA_WIN, w=1.6, h=2.1, sill=0.2, deco={'sill': True}),
                    roof=dict(type='flat', parapet=0.3), doors=[dr(c['door'], 'door', 1.2, 2.4, door='wood')]), lod)
    e = volume(m, g, V(-hw, hw - 4.5, -hd, hd - 1.5, y0=3.45, plinth=0, floors=1, fh=3.0, wall='wall', win=dict(VILLA_WIN, w=1.4, h=1.8, sill=0.4, deco={'sill': True, 'shutters': True, 'shutter': 'shutter.blue'}),
                        roof=dict(type='hip', pitch=20, key='terracotta', over=0.5)), lod)
    railing(m, hw - 4.5, hw - 0.1, -hd + 0.1, hd - 0.1, 3.45 + 0.3, 0.8, 'wall', 1)
    m.box('wood', hw - 4.0, hw - 0.5, 3.45 + 2.6, 3.45 + 2.7, -hd + 1.0, hd - 1.0)
    for x in (hw - 4.0, hw - 0.5):
        m.box('wood', x - 0.07, x + 0.07, 3.45, 3.45 + 2.6, hd - 1.07, hd - 0.93)
    steps(m, c['door'], hd, 1.6, 2)


# --- villen

def villa_jugendstil(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw - 4, -hd, hd, floors=2, fh=3.4, plinth=0.9, win=dict(VILLA_WIN, deco={'sill': True, 'surround': True, 'pediment': 'mixed'}), quoins=True, bands=True,
                        cornice=0.25, brackets=True, roof=dict(type='hip', pitch=45, key='roof.slate', over=0.4), doors=[dr(0, 'door', 1.4, 2.7, door='door.white')]), lod)
    e2 = volume(m, g, V(hw - 4, hw, -hd + 1.5, hd + 1.0, floors=2, fh=3.4, plinth=0.9, win=dict(VILLA_WIN, n=1, w=1.4, deco={'sill': True, 'surround': True, 'pediment': 'triangle'}),
                         quoins=True, bands=True, roof=dict(type='gable', axis='z', pitch=50, key='roof.slate', over=0.35)), lod)
    tower(m, g, -hw + 0.4, hd - 0.4, 2.2, 0, e + 2.2, 5.0, lod, win_rows=[(1.9, 3.6), (5.3, 7.0), (e + 0.4, e + 1.8)])
    portico(m, 0, hd, 3.0, 1.8, 3.4, lod)
    steps(m, 0, hd, 2.4, 5, rise=0.18)
    for x in (-1.5, 2.2):
        dormer(m, g, x, hd - 1.0, e + 0.8, 2.0, 1.6, lod, w=1.5, roof_key='roof.slate', gl=g)
    chimney(m, -2, -2, e, e + 4.6)
    chimney(m, 3, -3, e, e + 4.6)


def villa_bauhaus(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=1, fh=3.2, win=dict(MODERN_WIN, w=2.8, h=2.2, sill=0.3, gap=0.9, deco={'deepframe': True}),
                    roof=dict(type='flat', parapet=0.3), doors=[dr(c['door'], 'door', 1.4, 2.5, door='door.dark', panels=False)]), lod)
    e = volume(m, g, V(-hw, hw - 6, -hd, hd, y0=3.65, plinth=0, floors=1, fh=3.0, win=dict(MODERN_WIN, w=3.6, h=1.3, sill=0.9, gap=0.6, deco={'deepframe': True}),
                        roof=dict(type='flat', parapet=0.3, overhang=0.6)), lod)
    railing(m, hw - 6, hw - 0.1, -hd + 0.1, hd - 0.1, 3.65 + 0.3, 1.0, 'white', lod)
    # Round stair tower with a glass band.
    m.cyl('wall', 1.6, -2.5, 8.2, -hw + 3.5, -hd + 1.4, seg=20)
    m.cyl('cap', 1.7, 8.2, 8.35, -hw + 3.5, -hd + 1.4, seg=20)
    canopy(m, c['door'], hd, 3.0, 1.6, 2.9, key='white', t=0.18)
    steps(m, c['door'], hd, 2.0, 3)


def villa_landhaus(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=2, fh=3.1, win=dict(VILLA_WIN, deco={'sill': True, 'shutters': True, 'shutter': 'shutter'}),
                        roof=dict(type='hip', pitch=40, key='roof', over=0.6), doors=[dr(0, 'door', 1.6, 2.5, door='wood.dark')], side_win={'front': dict(n=6)}), lod)
    for x in (-5, 0, 5):
        dormer(m, g, x, hd - 0.9, e + 0.8, 2.2, 1.6, lod, w=1.7, gl=g)
    # Two-storey bay with a balcony over the entrance.
    for s in (-1, 1):
        m.box('wall2', s * 1.6 - 0.2, s * 1.6 + 0.2, 0.45, 3.4, hd + 1.6, hd + 2.0)
    balcony(m, -1.9, 1.9, hd, 2.0, 3.55, lod, key='wall2', rail='white')
    steps(m, 0, hd, 2.6, 3)
    chimney(m, -4, -2, e, e + 5.0)
    chimney(m, 4, -2, e, e + 5.0)


def villa_glas(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=1, fh=3.3, wall='concrete', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=3.6, h=2.8, sill=0.1, gap=0.3, margin=0.4, deco={}, transom=False), side_win={'back': dict(n=2)},
                    roof=dict(type='flat', parapet=0.2, parapet_key='concrete', overhang=1.2), doors=[dr(c['door'], 'door', 1.6, 2.7, door='wood', panels=False, light=False)]), lod)
    volume(m, g, V(-hw + 2, 1.0, -hd + 1, hd - 2.5, y0=3.75, plinth=0, floors=1, fh=3.0, wall='wood', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=3.0, h=2.3, sill=0.2, gap=0.6, deco={}, transom=False), roof=dict(type='flat', parapet=0.15, parapet_key='wood', cap='metal', overhang=0.6)), lod)
    # Roof terrace with a pool beside the upper floor.
    m.box('paving', 1.4, hw - 0.3, 3.7, 3.85, -hd + 0.3, hd - 0.3)
    m.box('water', 2.4, hw - 1.2, 3.7, 3.87, -hd + 1.4, hd - 1.6)
    m.box('stone', 2.2, hw - 1.0, 3.85, 4.0, -hd + 1.2, -hd + 1.4)
    steps(m, c['door'], hd, 2.0, 2)


# --- verwaltung

def verwaltung_klassisch(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=3, fh=3.6, plinth=1.0, win=dict(ANTIK_WIN, w=1.3, h=2.1, gap=1.4, deco={'sill': True, 'surround': True, 'pediment': 'mixed'}),
                        quoins=True, bands=True, cornice=0.35, brackets=True, roof=dict(type='mansard', lower=3.0, inset=1.1, key='roof.slate'),
                        side_keys={}, blank_floors={}), lod)
    # Central projection with columns over two floors, the pediment carrying the clock.
    rv = V(-5.5, 5.5, hd - 0.2, hd + 1.0, floors=3, fh=3.6, plinth=1.0, quoins=True, bands=True, wall='wall2', cornice=0.3,
           win=dict(ANTIK_WIN, w=1.4, h=2.3, n=3, margin=1.6, deco={'sill': True, 'surround': True, 'pediment': 'triangle'}), sides=('front',),
           doors=[dr(0, 'door', 2.2, 3.4, door='wood.dark')], roof=dict(type='gable', axis='z', pitch=24, key='roof.slate', over=0.35, wall='wall2'))
    e2 = volume(m, g, rv, lod)
    for x in (-4.6, -2.0, 2.0, 4.6):
        column(m, x, hd + 1.35, 1.0 + 3.6, 1.0 + 3 * 3.6 - 0.2, r=0.32, lod=lod)
    m.box('stone', -5.4, 5.4, 1.0 + 3 * 3.6 - 0.3, 1.0 + 3 * 3.6 + 0.1, hd + 0.9, hd + 1.8)
    clock(m, 0, e2 + 1.1, hd + 1.05, 0.7, lod)
    for x in spread(c['w'], 1.3, 2.4, 2.0, 7):
        if abs(x - hw) > 6.2:
            dormer(m, g, x - hw, hd - 0.2, e + 0.4, 1.0, 1.7, lod, w=1.4, roof_key='roof.slate', flat=True, gl=g)
    steps(m, 0, hd + 1.0, 7.0, 6, rise=0.17, run=0.35)
    for s in (-1, 1):
        m.box('stone', s * 3.9 - 0.3, s * 3.9 + 0.3, 0, 1.25, hd + 1.0, hd + 3.1)


def clock(m, x, y, z, r, lod):
    v = bmesh.ops.create_circle(m.bm, cap_ends=True, segments=24 if not lod else 12, radius=r)['verts']
    bmesh.ops.rotate(m.bm, verts=v, cent=Vector((0, 0, 0)), matrix=__import__('mathutils').Matrix.Rotation(math.pi / 2, 3, 'X'))
    bmesh.ops.translate(m.bm, vec=bl(x, y, z + 0.06), verts=v)
    fs = list({f for vv in v for f in vv.link_faces})
    for f in fs:
        f.normal_update()
        if f.normal.dot(bl(0, 0, 1)) < 0:
            f.normal_flip()
    m.mark(fs, 'white')
    if not lod:
        m.boxc('black', (0.05, r * 0.55, 0.02), (x, y + r * 0.25, z + 0.08))
        m.boxc('black', (0.04, r * 0.8, 0.02), (x + r * 0.28, y + r * 0.1, z + 0.09), rotz=-1.2)
        for k in range(12):
            a = k * math.pi / 6
            m.boxc('black', (0.04, 0.12, 0.02), (x + math.sin(a) * r * 0.85, y + math.cos(a) * r * 0.85, z + 0.075), rotz=-a)


def verwaltung_modern(m, g, lod, hw, hd, c):
    volume(m, g, V(-hw, hw, -hd, hd, floors=4, fh=3.5, plinth=0.3, wall='concrete', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=2.6, h=2.2, sill=0.7, gap=0.6, margin=0.9, deco={}, transom=False),
                    roof=dict(type='flat', parapet=0.6, parapet_key='concrete'), doors=[dr(0, 'glassdoor', 6.0, 3.1, bars=1)]), lod)
    # Vertical fins over the whole front, a deep entrance canopy and a set-back top floor.
    if not lod:
        for x in spread(c['w'], 0.25, 3.0, 0.3):
            m.box('metal.light', x - hw - 0.1, x - hw + 0.1, 0.3, 0.3 + 14.0, hd, hd + 0.45)
    canopy(m, 0, hd, 10.0, 4.0, 3.5, key='concrete', t=0.35)
    for x in (-4.6, 4.6):
        m.cyl('metal.light', 0.12, 0.0, 3.5, x, hd + 3.6, seg=10)
    e = 0.3 + 14.0
    volume(m, g, V(-hw + 3, hw - 3, -hd + 2, hd - 2.5, y0=e, plinth=0, floors=1, fh=3.2, wall='metal', reveal='frame.dark',
                    win=dict(MODERN_WIN, w=3.2, h=2.4, sill=0.3, gap=0.4, deco={}, transom=False), roof=dict(type='flat', parapet=0.3, parapet_key='metal', cap='metal')), lod)
    railing(m, -hw + 0.2, hw - 0.2, -hd + 0.2, hd - 0.2, e + 0.6, 0.6, 'metal', lod)
    solar_flat(m, -hw + 3.6, hw - 3.6, -hd + 2.4, hd - 3.0, e + 3.2)
    steps(m, 0, hd, 8.0, 2, run=0.4)


def verwaltung_backstein(m, g, lod, hw, hd, c):
    e = volume(m, g, V(-hw, hw, -hd, hd, floors=3, fh=3.3, plinth=0.8, plinth_key='stone', wall='brick', reveal='brick',
                        win=dict(KLASS_WIN, w=1.2, h=1.9, gap=1.3, deco={'sill': True, 'lintel': True, 'lintel_key': 'stone'}), bands=True, band_key='stone', cornice=0.3, cornice_key='stone',
                        roof=dict(type='hip', pitch=38, key='roof.slate', over=0.3), doors=[dr(0, 'door', 2.0, 3.0, door='wood.dark')]), lod)
    # Gable over the entrance axis with the coat-of-arms field and a ridge turret.
    m.face('brick', [(-3.5, e, hd + 0.02), (3.5, e, hd + 0.02), (0, e + 3.5, hd + 0.02)], (0, 0, 1))
    m.slab('roof.slate', [(-3.8, e - 0.2, hd + 0.3), (-3.8, e - 0.2, hd - 3.0), (0, e + 3.6, hd - 3.0), (0, e + 3.6, hd + 0.3)], 0.12, edge='stone')
    m.slab('roof.slate', [(3.8, e - 0.2, hd - 3.0), (3.8, e - 0.2, hd + 0.3), (0, e + 3.6, hd + 0.3), (0, e + 3.6, hd - 3.0)], 0.12, edge='stone')
    m.box('stone', -0.9, 0.9, e + 0.8, e + 2.2, hd + 0.02, hd + 0.08)
    clock(m, 0, e + 1.5, hd + 0.03, 0.55, lod)
    ridge = e + hd * math.tan(math.radians(38))
    m.box('wood.dark', -0.9, 0.9, ridge - 1.0, ridge + 1.6, -0.9, 0.9)
    m.cyl('copper', 1.25, ridge + 1.6, ridge + 4.2, 0, 0, seg=8, r2=0.05)
    canopy(m, 0, hd, 3.6, 1.6, 3.3, key='metal')
    steps(m, 0, hd, 4.0, 5, rise=0.16)


BUILDERS = {
    'modern-kubus': modern_kubus, 'modern-versatz': modern_versatz, 'modern-holzbox': modern_holzbox, 'modern-bungalow': modern_bungalow,
    'modern-dachterrasse': modern_dachterrasse, 'antik-walmdach': antik_walmdach, 'antik-mansarde': antik_mansarde, 'antik-risalit': antik_risalit,
    'antik-erker': antik_erker, 'antik-biedermeier': antik_biedermeier, 'architekt-pultdach': architekt_pultdach, 'architekt-kragarm': architekt_kragarm,
    'architekt-schmetterling': architekt_schmetterling, 'architekt-shed': architekt_shed, 'architekt-scheune': architekt_scheune,
    'landhaus-fachwerk': landhaus_fachwerk, 'landhaus-steinsockel': landhaus_steinsockel, 'landhaus-kruppelwalm': landhaus_kruppelwalm,
    'landhaus-gauben': landhaus_gauben, 'landhaus-cottage': landhaus_cottage, 'klassisch-siedlung': klassisch_siedlung,
    'klassisch-klinker': klassisch_klinker, 'klassisch-bungalow': klassisch_bungalow, 'klassisch-garage': klassisch_garage,
    'klassisch-zeltdach': klassisch_zeltdach, 'stadtvilla-zeltdach': stadtvilla_zeltdach, 'stadtvilla-toskana': stadtvilla_toskana,
    'stadtvilla-erker': stadtvilla_erker, 'stadtvilla-schwedenhaus': stadtvilla_schwedenhaus, 'stadtvilla-mediterran': stadtvilla_mediterran,
    'villa-jugendstil': villa_jugendstil, 'villa-bauhaus': villa_bauhaus, 'villa-landhaus': villa_landhaus, 'villa-glas': villa_glas,
    'verwaltung-klassisch': verwaltung_klassisch, 'verwaltung-modern': verwaltung_modern, 'verwaltung-backstein': verwaltung_backstein,
}


# ---------------------------------------------------------------- garden parts (keep in sync with GARDEN_PARTS in houseKinds.ts)

def g_zaun_holz(m, lod):
    m.box('white', -0.03, 0.03, 0.25, 0.32, -0.5, 0.5)
    m.box('white', -0.03, 0.03, 0.65, 0.72, -0.5, 0.5)
    n = 8 if not lod else 0
    for k in range(n):
        z = -0.5 + (k + 0.5) / n
        m.box('white', 0.03, 0.06, 0.05, 0.85, z - 0.04, z + 0.04)
        m.face('white', [(0.03, 0.85, z - 0.04), (0.03, 0.85, z + 0.04), (0.03, 0.92, z)], None)
    if lod:
        m.box('white', 0.03, 0.05, 0.05, 0.88, -0.5, 0.5)
    m.box('white', -0.05, 0.05, 0.0, 0.95, -0.55, -0.45)


def g_zaun_schmiede(m, lod):
    m.box('stone', -0.15, 0.15, -0.3, 0.45, -0.5, 0.5)
    m.box('stone', -0.18, 0.18, 0.45, 0.5, -0.5, 0.5)
    m.box('black', -0.02, 0.02, 1.25, 1.29, -0.5, 0.5)
    m.box('black', -0.02, 0.02, 0.62, 0.66, -0.5, 0.5)
    if not lod:
        for k in range(8):
            z = -0.5 + (k + 0.5) / 8
            m.box('black', -0.012, 0.012, 0.5, 1.38, z - 0.012, z + 0.012)
            m.cyl('black', 0.03, 1.38, 1.46, 0, z, seg=4, r2=0.0)
    else:
        m.box('black', -0.01, 0.01, 0.5, 1.4, -0.5, 0.5)


def g_gabione(m, lod):
    m.box('gabion', -0.2, 0.2, -0.2, 1.0, -0.5, 0.5)
    if not lod:
        for y in (0.2, 0.6, 1.0):
            m.box('metal.light', -0.21, 0.21, y - 0.01, y + 0.01, -0.5, 0.5)
        for z in (-0.5, -0.1, 0.3):
            m.box('metal.light', -0.21, 0.21, -0.2, 1.0, z - 0.01, z + 0.01)


def g_mauer_beton(m, lod):
    m.box('concrete.dark', -0.12, 0.12, -0.3, 0.7, -0.5, 0.5)


def g_mauer_klinker(m, lod):
    m.box('brick', -0.13, 0.13, -0.3, 0.75, -0.5, 0.5)
    m.box('stone', -0.16, 0.16, 0.75, 0.82, -0.5, 0.5)


def g_hecke(m, lod, h=1.1):
    m.box('leaf.dark', -0.35, 0.35, 0.0, h - 0.1, -0.5, 0.5)
    if not lod:
        for k in range(3):
            m.blob('leaf', 0.36, (0, h - 0.18, -0.33 + k * 0.33), seed=k + int(h * 10), scale=(1, 0.5, 1))
            for s in (-1, 1):
                m.blob('leaf.dark', 0.3, (s * 0.2, h * 0.5, -0.33 + k * 0.33), seed=k * 7 + s, scale=(0.4, 1.3, 1))


def g_hecke_hoch(m, lod):
    g_hecke(m, lod, 1.8)


def g_pfeiler(m, lod):
    m.box('stone', -0.22, 0.22, -0.3, 1.4, -0.22, 0.22)
    m.box('stone', -0.27, 0.27, 1.4, 1.5, -0.27, 0.27)
    m.ball('stone', 0.17, (0, 1.66, 0), seg=10 if not lod else 6, rings=6 if not lod else 4)


def g_pfeiler_klinker(m, lod):
    m.box('brick', -0.2, 0.2, -0.3, 1.1, -0.2, 0.2)
    m.box('stone', -0.24, 0.24, 1.1, 1.18, -0.24, 0.24)
    m.box('lamp', -0.08, 0.08, 1.18, 1.4, -0.08, 0.08)


def g_tor_holz(m, lod):
    m.box('wood', -0.03, 0.03, 0.08, 0.9, -0.48, 0.48)
    if not lod:
        for k in range(6):
            z = -0.42 + k * 0.17
            m.box('wood.dark', 0.03, 0.05, 0.12, 0.86, z - 0.05, z + 0.05)


def g_tor_schmiede(m, lod):
    m.box('black', -0.02, 0.02, 0.08, 0.12, -0.48, 0.48)
    m.box('black', -0.02, 0.02, 1.3, 1.34, -0.48, 0.48)
    if not lod:
        for k in range(9):
            z = -0.44 + k * 0.11
            top = 1.34 + 0.25 * math.cos((z / 0.48) * math.pi / 2)
            m.box('black', -0.012, 0.012, 0.1, top, z - 0.012, z + 0.012)
            m.cyl('black', 0.028, top, top + 0.08, 0, z, seg=4, r2=0)
    else:
        m.box('black', -0.01, 0.01, 0.1, 1.45, -0.48, 0.48)


def g_weg(m, lod):
    m.box('paving', -0.6, 0.6, -0.2, 0.06, -0.5, 0.5)


def g_kiesweg(m, lod):
    m.box('kies', -0.7, 0.7, -0.2, 0.05, -0.5, 0.5)
    m.box('concrete', -0.75, -0.7, -0.2, 0.07, -0.5, 0.5)
    m.box('concrete', 0.7, 0.75, -0.2, 0.07, -0.5, 0.5)


def g_auffahrt(m, lod):
    m.box('paving', -1.5, 1.5, -0.2, 0.05, -0.5, 0.5)
    m.box('concrete', -1.55, -1.5, -0.2, 0.08, -0.5, 0.5)
    m.box('concrete', 1.5, 1.55, -0.2, 0.08, -0.5, 0.5)


def g_beet(m, lod, cols=('flower.red', 'flower.yellow', 'flower.white', 'flower.blue', 'flower.pink')):
    m.box('wood.dark', -0.45, 0.45, -0.1, 0.12, -0.5, 0.5)
    m.box('leaf.dark', -0.4, 0.4, 0.12, 0.14, -0.48, 0.48)
    rnd = random.Random(len(cols))
    n = 9 if not lod else 3
    for k in range(n):
        x, z = rnd.uniform(-0.3, 0.3), -0.42 + 0.84 * (k + 0.5) / n
        m.blob('leaf', 0.13, (x, 0.24, z), seed=k, scale=(1, 0.8, 1))
        if not lod:
            m.blob(cols[k % len(cols)], 0.08, (x, 0.36, z), seed=k + 50, scale=(1, 0.6, 1), rough=0.3)


def g_rosen(m, lod):
    g_beet(m, lod, ('flower.red', 'flower.pink', 'flower.red', 'flower.white'))


def g_graeser(m, lod):
    n = 9 if not lod else 4
    for k in range(n):
        a = k * 2.4
        m.boxc('grass.orn', (0.04, 0.9, 0.02), (math.cos(a) * 0.08, 0.4, math.sin(a) * 0.08), rotz=math.cos(a) * 0.35, rotx=math.sin(a) * 0.35)
    m.blob('grass.orn', 0.22, (0, 0.18, 0), seed=3, scale=(1, 0.8, 1))


def g_strauch(m, lod):
    m.blob('leaf', 0.55, (0, 0.5, 0), seed=11, scale=(1, 0.85, 1), rough=0.25)
    if not lod:
        m.blob('leaf.dark', 0.4, (0.25, 0.35, 0.2), seed=12)
        m.blob('leaf', 0.35, (-0.25, 0.65, -0.1), seed=13)


def g_buchskugel(m, lod):
    m.ball('leaf.dark', 0.4, (0, 0.4, 0), seg=12 if not lod else 7, rings=8 if not lod else 5)


def g_baeumchen(m, lod):
    m.cyl('wood.dark', 0.06, 0, 1.8, seg=8 if not lod else 5)
    m.blob('leaf', 0.9, (0, 2.4, 0), seed=21, scale=(1, 0.9, 1), rough=0.22)
    if not lod:
        m.blob('leaf.dark', 0.6, (0.4, 2.1, 0.2), seed=22)
        m.blob('leaf', 0.55, (-0.35, 2.8, -0.2), seed=23)


def g_briefkasten(m, lod):
    m.box('metal', -0.04, 0.04, 0, 1.0, -0.04, 0.04)
    m.box('frame.dark', -0.2, 0.2, 1.0, 1.35, -0.14, 0.14)
    m.box('metal.light', -0.12, 0.12, 1.28, 1.3, 0.14, 0.15)


def g_tonnen(m, lod):
    for i, k in enumerate(('bin.grey', 'bin.blue', 'bin.yellow')):
        x = (i - 1) * 0.65
        m.box(k, x - 0.28, x + 0.28, 0.0, 1.0, -0.35, 0.35)
        m.box(k, x - 0.3, x + 0.3, 1.0, 1.06, -0.4, 0.37)


def g_laterne(m, lod):
    m.cyl('black', 0.04, 0, 0.9, seg=8 if not lod else 5)
    m.box('black', -0.1, 0.1, 0.9, 1.15, -0.1, 0.1)
    m.box('lamp', -0.08, 0.08, 0.93, 1.12, -0.08, 0.08)


def g_brunnen(m, lod):
    seg = 20 if not lod else 10
    m.cyl('stone', 1.4, -0.2, 0.45, seg=seg)
    m.cyl('water', 1.25, 0.45, 0.48, seg=seg)
    m.cyl('stone', 0.18, 0.45, 1.3, seg=10)
    m.cyl('stone', 0.6, 1.3, 1.45, seg=seg, r2=0.45)
    m.ball('stone', 0.15, (0, 1.6, 0), seg=10, rings=6)


def g_fahnenmast(m, lod):
    m.cyl('metal.light', 0.06, 0, 8.0, seg=8 if not lod else 5, r2=0.04)
    m.ball('metal.light', 0.08, (0, 8.05, 0), seg=8, rings=5)
    for i, k in enumerate(('flag.black', 'flag.red', 'flag.yellow')):
        m.box(k, -0.01, 0.01, 6.6 + (2 - i) * 0.4, 7.0 + (2 - i) * 0.4, 0.06, 2.0)


def g_zwerg(m, lod):
    m.cyl('blue', 0.13, 0, 0.22, seg=10, r2=0.11)
    m.cyl('red', 0.12, 0.22, 0.4, seg=10, r2=0.1)
    m.ball('skin', 0.1, (0, 0.47, 0.01), seg=10, rings=6)
    m.ball('white', 0.09, (0, 0.42, 0.07), seg=8, rings=5, scale=(1, 1.2, 0.6))
    m.cyl('red', 0.1, 0.52, 0.78, seg=10, r2=0.0)


def g_bank(m, lod):
    for x in (-0.7, 0.7):
        m.box('metal', x - 0.04, x + 0.04, 0, 0.45, -0.22, 0.22)
    m.box('wood', -0.85, 0.85, 0.42, 0.46, -0.22, 0.22)
    m.boxc('wood', (1.7, 0.4, 0.04), (0, 0.7, -0.24), rotx=-0.15)


GARDEN = {
    'zaun-holz': g_zaun_holz, 'zaun-schmiede': g_zaun_schmiede, 'gabione': g_gabione, 'mauer-beton': g_mauer_beton,
    'mauer-klinker': g_mauer_klinker, 'hecke': g_hecke, 'hecke-hoch': g_hecke_hoch, 'pfeiler': g_pfeiler, 'pfeiler-klinker': g_pfeiler_klinker,
    'tor-holz': g_tor_holz, 'tor-schmiede': g_tor_schmiede, 'weg': g_weg, 'kiesweg': g_kiesweg, 'auffahrt': g_auffahrt, 'beet': g_beet,
    'rosen': g_rosen, 'graeser': g_graeser, 'strauch': g_strauch, 'buchskugel': g_buchskugel, 'baeumchen': g_baeumchen,
    'briefkasten': g_briefkasten, 'tonnen': g_tonnen, 'laterne': g_laterne, 'brunnen': g_brunnen, 'fahnenmast': g_fahnenmast,
    'zwerg': g_zwerg, 'bank': g_bank,
}


# ---------------------------------------------------------------- export

def material(name, rough=0.8):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = rough
    return m


def build(only=None):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    body, glass = material('house'), material('glass', 0.05)
    root = bpy.data.objects.new('houses', None)
    bpy.context.scene.collection.objects.link(root)
    obs = []
    for c in CAT['models']:
        if only and c['id'] not in only:
            continue
        for lod in (0, 1):
            m, g = build_house(c['id'], lod)
            obs.append(m.finish(f"{c['id']}_lod{lod}", root, body))
            obs.append(g.finish(f"{c['id']}_glas{lod}", root, glass))
    for name, fn in GARDEN.items():
        if only and name not in only:
            continue
        for lod in (0, 1):
            m = M(BASE)
            fn(m, lod)
            obs.append(m.finish(f'garten-{name}_lod{lod}', root, body))
    total = 0
    for ob in obs:
        n = tris(ob)
        total += n
        print(f'  {ob.name:34s} {n:6d} Dreiecke')
    print(f'  zusammen {total} Dreiecke')
    return root


if __name__ == '__main__':
    only = os.environ.get('HOUSES_ONLY')
    root = build(only.split(',') if only else None)
    export(root, OUT, texcoords=True)
