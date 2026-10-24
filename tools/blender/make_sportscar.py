# Builds the player's sports coupé (generic, no real make) and exports it as GLB.
# Run: blender --background --factory-startup --python tools/blender/make_sportscar.py -- [out.glb]
# Then compress: npm run models:compress (see package.json).
#
# Model space is the game's (src/vehicle/sportsCarModel.ts): ground at y = 0, +z forward, +x left,
# 1 unit = 1 m. In Blender that is (x, -z, y); the glTF exporter's +Y up turns it back.
#
# Layout of the GLB (src/vehicle/sportsCarGlb.ts reads it):
#   car
#     lod0, lod1, lod2   body shell + details at three levels of detail (extras: dent on panels)
#     splitter, wing, mirrorL, mirrorR, plate   parts that break off (extras: part)
#     exhaust_L/R, headlight_L/R                empties at the tailpipe ends and lamp centres
#     wheel              one wheel (lod0, lod1), origin in the hub, outer face towards +x
#     caliper            brake caliper in wheel space (steers but does not spin)
# Materials are matched by name in the game: paint, glass, head, brake, ... (see MATS).
import bpy, bmesh, math, os, sys
from mathutils import Vector, Matrix

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'sportscar.raw.glb')

# Keep in sync with CAR in src/vehicle/tuning.ts.
WHEEL_R = 0.35
WHEEL_W = 0.3
AXLES = (1.27, -1.2)
TRACK = 0.8
ARCH_R = WHEEL_R + 0.055
ARCH_Y = WHEEL_R + 0.02


def bl(x, y, z):
    return Vector((x, -z, y))


# ---------------------------------------------------------------- materials

def srgb(hexcol):
    lin = lambda c: c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return tuple(lin(((hexcol >> s) & 255) / 255) for s in (16, 8, 0)) + (1,)


MATS = {}


def pbr(name, col, metal=0.0, rough=0.5, coat=0.0, emit=None, strength=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes['Principled BSDF']
    b.inputs['Base Color'].default_value = srgb(col)
    b.inputs['Metallic'].default_value = metal
    b.inputs['Roughness'].default_value = rough
    if coat:
        b.inputs['Coat Weight'].default_value = coat
        b.inputs['Coat Roughness'].default_value = 0.04
    if emit is not None:
        b.inputs['Emission Color'].default_value = srgb(emit)
        b.inputs['Emission Strength'].default_value = strength
    m.diffuse_color = srgb(col)
    MATS[name] = m
    return m


def materials():
    pbr('paint', 0xc0141c, 0.6, 0.32, coat=1)
    pbr('glass', 0x0a0e13, 0.3, 0.04, coat=1)
    pbr('trim', 0x0b0c0e, 0.2, 0.25, coat=0.6)       # gloss black: window frames, bezels
    pbr('black', 0x0d0e10, 0.2, 0.55)                # matte: grilles, intakes
    pbr('seam', 0x050506, 0.0, 0.8)                  # panel gaps
    pbr('carbon', 0x16181b, 0.4, 0.35, coat=0.8)
    pbr('chrome', 0xd9dde2, 1.0, 0.18)
    pbr('housing', 0x2a2d31, 0.9, 0.2)               # inside of the lamp units
    pbr('head', 0xffffff, 0.0, 0.3, emit=0xf4f8ff, strength=2.4)
    pbr('brake', 0x4a0000, 0.0, 0.3, emit=0xff1010, strength=0.7)
    pbr('indicator', 0x6a3a00, 0.0, 0.3, emit=0xff8a00, strength=0.3)
    pbr('plate', 0xe8e8e2, 0.0, 0.5)
    pbr('well', 0x08090a, 0.0, 0.9)
    pbr('tyre', 0x161616, 0.0, 0.92)
    pbr('rim', 0x2c2f33, 0.9, 0.28)
    pbr('rimLip', 0xb8bcc2, 1.0, 0.2)
    pbr('disc', 0x5d5f62, 0.8, 0.45)
    pbr('caliper', 0xf0c419, 0.2, 0.4)


# ---------------------------------------------------------------- helpers

def mesh_object(name, bm, parent=None, mats=()):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in mats:
        me.materials.append(MATS[m])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    if parent is not None:
        ob.parent = parent
    return ob


def empty(name, parent=None, at=(0, 0, 0)):
    ob = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    ob.location = bl(*at)
    return ob


def smooth(ob, angle=40):
    for p in ob.data.polygons:
        p.use_smooth = True
    sel(ob)
    bpy.ops.object.shade_smooth_by_angle(angle=math.radians(angle), keep_sharp_edges=True)


def sel(*obs):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]


def apply_mods(ob):
    sel(ob)
    for m in list(ob.modifiers):
        bpy.ops.object.modifier_apply(modifier=m.name)


def join(name, obs, parent):
    obs = [o for o in obs if o is not None]
    sel(*obs)
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    ob.parent = parent
    return ob


def tris(ob):
    return sum(len(p.vertices) - 2 for p in ob.data.polygons)


class Builder:
    """Collects primitives (one material slot each) into one bmesh, in model space."""

    def __init__(self, mats):
        self.bm = bmesh.new()
        self.mats = list(mats)

    def _place(self, verts, mat, m):
        bmesh.ops.transform(self.bm, matrix=m, verts=verts)
        idx = self.mats.index(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
        return verts

    @staticmethod
    def matrix(at=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1)):
        # rot in model space (x, y, z) radians, applied z, y, x like three.js 'XYZ' order.
        from mathutils import Euler
        e = Euler((rot[0], -rot[2], rot[1]), 'YZX').to_matrix().to_4x4()
        s = Matrix.Diagonal((scale[0], scale[2], scale[1], 1))
        return Matrix.Translation(bl(*at)) @ e @ s

    def box(self, mat, size, at=(0, 0, 0), rot=(0, 0, 0), bevel=0.0, seg=2):
        before = set(self.bm.verts)
        v = bmesh.ops.create_cube(self.bm, size=1)['verts']
        bmesh.ops.scale(self.bm, vec=(size[0], size[2], size[1]), verts=v)
        if bevel:
            edges = list({e for x in v for e in x.link_edges})
            bmesh.ops.bevel(self.bm, geom=v + edges, offset=bevel, segments=seg, affect='EDGES', profile=0.5)
        return self._place([x for x in self.bm.verts if x not in before], mat, self.matrix(at, rot))

    def cyl(self, mat, r1, r2, h, at=(0, 0, 0), rot=(0, 0, 0), seg=16, scale=(1, 1, 1), caps=True):
        # Axis along model y before rotation.
        v = bmesh.ops.create_cone(self.bm, cap_ends=caps, segments=seg, radius1=r1, radius2=r2, depth=h)['verts']
        bmesh.ops.scale(self.bm, vec=(scale[0], scale[2], scale[1]), verts=v)
        return self._place(v, mat, self.matrix(at, rot))

    def sphere(self, mat, r, at=(0, 0, 0), rot=(0, 0, 0), scale=(1, 1, 1), seg=16, rings=8):
        v = bmesh.ops.create_uvsphere(self.bm, u_segments=seg, v_segments=rings, radius=r)['verts']
        bmesh.ops.scale(self.bm, vec=(scale[0], scale[2], scale[1]), verts=v)
        return self._place(v, mat, self.matrix(at, rot))

    def lathe_x(self, mat, profile, seg=48, at=(0, 0, 0), closed=False):
        """Surface of revolution about the model x axis from [(radius, x), ...]."""
        rings = []
        for r, x in profile:
            ring = []
            for k in range(seg):
                a = 2 * math.pi * k / seg
                ring.append(self.bm.verts.new(bl(at[0] + x, at[1] + r * math.cos(a), at[2] + r * math.sin(a))))
            rings.append(ring)
        for a, b in zip(rings, rings[1:]):
            for k in range(seg):
                k2 = (k + 1) % seg
                self.bm.faces.new((a[k], a[k2], b[k2], b[k]))
        if closed:
            for ring in (rings[0], rings[-1]):
                if len(set(ring)) > 2:
                    self.bm.faces.new(ring)
        verts = [v for r in rings for v in r]
        idx = self.mats.index(mat)
        for f in {f for v in verts for f in v.link_faces}:
            f.material_index = idx
        return rings

    def extrude_x(self, mat, outline, x0, x1):
        """Prism along model x from a (z, y) outline (counter-clockwise seen from +x)."""
        a = [self.bm.verts.new(bl(x0, y, z)) for z, y in outline]
        b = [self.bm.verts.new(bl(x1, y, z)) for z, y in outline]
        n = len(outline)
        faces = [self.bm.faces.new(list(reversed(a))), self.bm.faces.new(b)]
        for i in range(n):
            j = (i + 1) % n
            faces.append(self.bm.faces.new((a[i], a[j], b[j], b[i])))
        idx = self.mats.index(mat)
        for f in faces:
            f.material_index = idx
        return a + b

    def finish(self, name, parent):
        bmesh.ops.remove_doubles(self.bm, verts=self.bm.verts, dist=1e-6)
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        return mesh_object(name, self.bm, parent, self.mats)


# ---------------------------------------------------------------- loft

def monotone(xs, ys):
    n = len(xs)
    d = [(ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]) for i in range(n - 1)]
    m = [0.0] * n
    m[0], m[-1] = d[0], d[-1]
    for i in range(1, n - 1):
        m[i] = 0 if d[i - 1] * d[i] <= 0 else 2 / (1 / d[i - 1] + 1 / d[i])

    def f(x):
        i = 0
        while i < n - 2 and x > xs[i + 1]:
            i += 1
        h = xs[i + 1] - xs[i]
        t = min(1, max(0, (x - xs[i]) / h))
        t2, t3 = t * t, t * t * t
        return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * m[i + 1]
    return f


def spow(v, p):
    return math.copysign(abs(v) ** p, v)


# Station: z, half width, bottom, top, dip (hood between fenders), n (2 round .. boxy), tumble.
BODY = [
    (-2.33, 0.40, 0.38, 0.62, 0.00, 3.0, 0.12),
    (-2.31, 0.68, 0.32, 0.72, 0.00, 3.4, 0.12),
    (-2.27, 0.84, 0.26, 0.79, 0.01, 3.6, 0.12),
    (-2.18, 0.92, 0.22, 0.84, 0.02, 3.8, 0.12),
    (-1.95, 0.95, 0.19, 0.88, 0.03, 3.8, 0.13),
    (-1.55, 0.975, 0.17, 0.90, 0.04, 3.9, 0.14),
    (-1.15, 0.975, 0.17, 0.90, 0.05, 3.9, 0.14),
    (-0.70, 0.945, 0.16, 0.86, 0.05, 3.7, 0.13),
    (0.00, 0.915, 0.16, 0.81, 0.06, 3.5, 0.12),
    (0.60, 0.925, 0.16, 0.82, 0.13, 3.5, 0.12),
    (1.05, 0.955, 0.16, 0.87, 0.20, 3.7, 0.12),
    (1.45, 0.955, 0.17, 0.86, 0.19, 3.6, 0.12),
    (1.80, 0.93, 0.18, 0.78, 0.14, 3.4, 0.12),
    (2.07, 0.86, 0.20, 0.62, 0.08, 3.0, 0.12),
    (2.22, 0.74, 0.23, 0.51, 0.04, 2.6, 0.12),
    (2.29, 0.56, 0.27, 0.43, 0.01, 2.3, 0.12),
    (2.31, 0.36, 0.31, 0.39, 0.00, 2.1, 0.12),
]

CABIN = [
    (-1.98, 0.50, 0.66, 0.82, 0, 2.6, 0.30),
    (-1.65, 0.60, 0.66, 0.90, 0, 2.6, 0.30),
    (-1.15, 0.70, 0.66, 1.05, 0, 2.6, 0.32),
    (-0.65, 0.76, 0.66, 1.21, 0, 2.6, 0.34),
    (-0.15, 0.78, 0.66, 1.23, 0, 2.6, 0.34),
    (0.30, 0.79, 0.66, 1.08, 0, 2.6, 0.32),
    (0.78, 0.78, 0.66, 0.74, 0, 2.6, 0.30),
]


class Loft:
    """Lofted shell over stations. Rings sit exactly on the z breakpoints and section angles on
    the angle breakpoints, so regions (lamps, windows, seams) get clean edges along the grid."""

    def __init__(self, stations, rings, around, zbreaks=(), abreaks=()):
        zs = [s[0] for s in stations]
        self.f = [monotone(zs, [s[i] for s in stations]) for i in range(1, 7)]
        z0, z1 = zs[0], zs[-1]
        base = [z0 + (z1 - z0) * (0.5 - 0.5 * math.cos(math.pi * i / rings)) for i in range(rings + 1)]
        self.z = self._merge(base, [z for z in zbreaks if z0 < z < z1], 0.006)
        # Section angle a: -pi/2 bottom centre .. pi/2 top centre, same on both sides.
        abase = [-math.pi / 2 + math.pi * i / around for i in range(around + 1)]
        self.a = self._merge(abase, [a for a in abreaks if -math.pi / 2 < a < math.pi / 2], 0.012)

    @staticmethod
    def _merge(base, breaks, tol):
        out = [b for b in base if all(abs(b - k) > tol for k in breaks) or b in (base[0], base[-1])]
        return sorted(set(out) | set(breaks))

    def point(self, z, a, side):
        w, bottom, top, dip, n, tumble = (f(z) for f in self.f)
        mid, hh = (top + bottom) / 2, (top - bottom) / 2
        c, s = math.cos(a), math.sin(a)
        x = w * spow(c, 2 / n)
        y = mid + hh * spow(s, 2 / n)
        if s > 0:
            x *= 1 - tumble * s * s
            y -= dip * (1 - (x / w) ** 2) * s * s
        return side * x, y, z

    def build(self, bm):
        """Returns faces with their (z, a, side) parameters at the face centre."""
        # Ring: left side bottom -> top, then right side top -> bottom (sharing the centre line).
        ring = [(a, 1) for a in self.a] + [(a, -1) for a in reversed(self.a[1:-1])]
        grid = []
        for z in self.z:
            grid.append([bm.verts.new(bl(*self.point(z, a, s))) for a, s in ring])
        params = []
        R = len(ring)
        for i in range(len(self.z) - 1):
            for k in range(R):
                k2 = (k + 1) % R
                f = bm.faces.new((grid[i][k], grid[i][k2], grid[i + 1][k2], grid[i + 1][k]))
                (a0, s0), (a1, s1) = ring[k], ring[k2]
                side = s0 if s0 == s1 else 0
                params.append((f, (self.z[i] + self.z[i + 1]) / 2, (a0 + a1) / 2 if s0 == s1 else math.pi / 2 * (1 if a0 > 0 else -1), side))
        caps = []
        for row, flip in ((grid[0], True), (grid[-1], False)):
            caps.append(bm.faces.new(list(reversed(row)) if flip else row))
        return params, caps


def region(params, z0, z1, a0, a1, sides=(1, -1, 0)):
    return [f for f, z, a, s in params if z0 <= z <= z1 and a0 <= a <= a1 and s in sides]


def inset(bm, faces, thick, depth, rim_mat=None):
    faces = [f for f in faces if f.is_valid]
    if not faces:
        return []
    res = bmesh.ops.inset_region(bm, faces=faces, thickness=thick, depth=depth, use_even_offset=True, use_boundary=True)
    for f in res['faces']:
        if rim_mat is not None:
            f.material_index = rim_mat
        for e in f.edges:
            e.smooth = False
    return res['faces']


def deg(d):
    return math.radians(d)


# ---------------------------------------------------------------- body shell

SHELL_MATS = ['paint', 'glass', 'trim', 'black', 'seam', 'carbon', 'housing', 'head', 'brake', 'indicator', 'well']
M = {m: i for i, m in enumerate(SHELL_MATS)}


def body_shell(parent):
    bm = bmesh.new()
    # Breakpoints: lamp edges, intakes, door and hood seams, sill.
    zb = [1.78, 1.80, 2.12, 2.20, 2.16, 2.255, 0.62, 0.628, -0.95, -0.958, -0.46, -0.88, 1.55, 1.95,
          -2.18, -2.26, 1.20, 1.36]
    ab = [deg(x) for x in (-62, -40, -20, -12, 0, 2, 6, 14, 18, 28, 30, 40, 46, 50, 58, 62, 66, 72, 84, 86)]
    L = Loft(BODY, 120, 34, zb, ab)
    params, caps = L.build(bm)
    caps[0].material_index = M['black']
    caps[1].material_index = M['black']

    def paint(name, faces):
        for f in faces:
            f.material_index = M[name]

    # Sills / side skirts and the underside.
    paint('carbon', region(params, -2.4, 2.4, deg(-62), deg(-40)))
    paint('black', region(params, -2.4, 2.4, -math.pi, deg(-62)))

    # Headlights: swept units on the front corners, a DRL strip along their top edge.
    head = region(params, 1.78, 2.20, deg(14), deg(50))
    paint('housing', head)
    paint('head', region(params, 1.80, 2.12, deg(40), deg(46)))
    paint('indicator', region(params, 2.12, 2.20, deg(18), deg(28)))
    inset(bm, head, 0.008, -0.004, M['trim'])

    # Front: big centre grille and corner intakes.
    grille = region(params, 2.255, 2.4, deg(-40), deg(6))
    paint('black', grille)
    inset(bm, grille, 0.012, -0.035, M['trim'])
    for s in (1, -1):
        side_in = region(params, 2.16, 2.255, deg(-40), deg(2), (s,))
        paint('black', side_in)
        inset(bm, side_in, 0.01, -0.02, M['trim'])

    # Hood vents.
    vents = region(params, 1.36, 1.55, deg(72), deg(84))
    paint('black', vents)
    inset(bm, vents, 0.01, -0.012, M['trim'])

    # Side intakes ahead of the rear wheels.
    for s in (1, -1):
        si = region(params, -0.88, -0.46, deg(-20), deg(14), (s,))
        paint('black', si)
        inset(bm, si, 0.012, -0.03, M['trim'])

    # Tail: full-width light bar with corner clusters, black lower fascia.
    paint('brake', region(params, -2.4, -2.26, deg(46), deg(58)))
    for s in (1, -1):
        cl = region(params, -2.26, -2.18, deg(28), deg(58), (s,))
        paint('brake', cl)
        inset(bm, cl, 0.006, -0.004, M['trim'])
    paint('black', region(params, -2.4, -2.18, deg(-40), deg(-12)))

    # Panel gaps: doors, hood shut lines.
    paint('seam', region(params, 0.62, 0.628, deg(-40), deg(62)))
    paint('seam', region(params, -0.958, -0.95, deg(-40), deg(66)))
    paint('seam', region(params, 1.20, 1.95, deg(84), deg(86)))

    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_object('body', bm, parent, SHELL_MATS)
    cut_arches(ob)
    return ob


def cut_arches(ob):
    for z in AXLES:
        for s in (1, -1):
            bm = bmesh.new()
            v = bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=ARCH_R, radius2=ARCH_R, depth=0.7)['verts']
            # Axis along model x.
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=v)
            bmesh.ops.translate(bm, vec=bl(s * (0.55 + 0.35), ARCH_Y, z), verts=v)
            cutter = mesh_object('cut', bm, None, ['well'])
            mod = ob.modifiers.new('arch', 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'EXACT'
            mod.material_mode = 'TRANSFER'
            mod.object = cutter
            apply_mods(ob)
            bpy.data.objects.remove(cutter)


def cabin_shell(parent):
    bm = bmesh.new()
    zb = [0.30, 0.74, -0.92, 0.24, -1.9, -0.95, 0.27, -0.935]
    ab = [deg(x) for x in (4, 30, 32, 58, 60, 86)]
    L = Loft(CABIN, 70, 24, zb, ab)
    params, caps = L.build(bm)
    for f in caps:
        f.material_index = M['paint']
    windows = [
        region(params, 0.30, 0.74, deg(32), math.pi),             # windscreen
        region(params, -1.90, -0.95, deg(32), math.pi),           # rear window
    ]
    for s in (1, -1):
        windows.append(region(params, -0.92, 0.24, deg(4), deg(58), (s,)))  # side windows
    for w in windows:
        for f in w:
            f.material_index = M['glass']
        inset(bm, w, 0.018, -0.006, M['trim'])
    # B-pillar in gloss black between the side glass and the rear window.
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object('cabin', bm, parent, SHELL_MATS)


# ---------------------------------------------------------------- details

def details(parent):
    b = Builder(['black', 'carbon', 'chrome', 'trim', 'plate', 'housing'])
    # Underbody between the wheels.
    b.box('black', (1.3, 0.05, 3.9), at=(0, 0.17, 0))
    # Diffuser with fins.
    b.box('carbon', (1.36, 0.03, 0.42), at=(0, 0.2, -2.1), rot=(-0.18, 0, 0))
    for i in range(-3, 4):
        b.box('carbon', (0.012, 0.12, 0.36), at=(i * 0.2, 0.22, -2.12))
    # Twin centre tailpipes.
    exhausts = []
    for s in (1, -1):
        x = s * 0.13
        b.cyl('chrome', 0.058, 0.052, 0.18, at=(x, 0.3, -2.25), rot=(math.pi / 2, 0, 0), seg=24, caps=False)
        b.cyl('black', 0.05, 0.05, 0.01, at=(x, 0.3, -2.2), rot=(math.pi / 2, 0, 0), seg=24)
        exhausts.append((x, 0.3, -2.34))
    # Front lip under the grille.
    b.box('black', (1.2, 0.04, 0.12), at=(0, 0.22, 2.2))
    # Door handles (flush) and fuel flap.
    for s in (1, -1):
        b.box('trim', (0.012, 0.025, 0.16), at=(s * 0.925, 0.72, -0.1), bevel=0.004, seg=1)
    return b.finish('details', parent), exhausts


def splitter(parent):
    b = Builder(['carbon'])
    pts = []
    for i in range(25):
        t = -math.pi / 2 + math.pi * i / 24
        pts.append((2.0 + 0.27 * math.cos(t) ** 0.6, math.sin(t) * 0.76))
    outline = pts + [(1.9, 0.76), (1.9, -0.76)]
    bm = b.bm
    top = [bm.verts.new(bl(x, 0.18, z)) for z, x in outline]
    bot = [bm.verts.new(bl(x, 0.155, z)) for z, x in outline]
    bm.faces.new(top)
    bm.faces.new(list(reversed(bot)))
    n = len(outline)
    for i in range(n):
        j = (i + 1) % n
        bm.faces.new((top[j], top[i], bot[i], bot[j]))
    for f in bm.faces:
        f.material_index = 0
    ob = b.finish('splitter', parent)
    ob['part'] = 'splitter'
    return ob


def wing(parent):
    b = Builder(['carbon'])
    # Airfoil section (z, y) around a 0.32 m chord, pitched nose-down at the leading edge.
    chord, thick = 0.32, 0.035
    prof = []
    for i in range(13):
        t = i / 12
        yt = 5 * thick * (0.2969 * math.sqrt(t) - 0.126 * t - 0.3516 * t ** 2 + 0.2843 * t ** 3 - 0.1036 * t ** 4)
        prof.append((t, yt))
    upper = [(-1.86 - t * chord, 1.08 + y + t * 0.04) for t, y in prof]
    lower = [(-1.86 - t * chord, 1.08 - y * 0.4 + t * 0.04) for t, y in prof][::-1][1:-1]
    outline = upper + lower
    b.extrude_x('carbon', outline, -0.8, 0.8)
    for s in (1, -1):
        b.box('carbon', (0.01, 0.11, 0.34), at=(s * 0.805, 1.08, -2.02), bevel=0.004, seg=1)
        # Swan-neck struts from the deck lid up to the wing.
        b.box('carbon', (0.025, 0.24, 0.07), at=(s * 0.4, 0.98, -1.98), rot=(0.25, 0, 0), bevel=0.006, seg=1)
    ob = b.finish('wing', parent)
    ob['part'] = 'wing'
    return ob


def mirror(parent, s):
    b = Builder(['paint', 'black', 'glass'])
    b.box('black', (0.13, 0.025, 0.05), at=(s * 0.85, 0.86, 0.5), rot=(0, 0, s * 0.15), bevel=0.008, seg=1)
    b.sphere('paint', 1, at=(s * 0.94, 0.89, 0.47), scale=(0.1, 0.055, 0.12), seg=20, rings=10)
    b.box('glass', (0.13, 0.065, 0.006), at=(s * 0.945, 0.89, 0.418))
    ob = b.finish('mirrorL' if s > 0 else 'mirrorR', parent)
    ob['part'] = ob.name
    return ob


def plate(parent):
    b = Builder(['plate', 'black'])
    b.box('black', (0.54, 0.13, 0.012), at=(0, 0.5, -2.336))
    b.box('plate', (0.52, 0.11, 0.01), at=(0, 0.5, -2.344), bevel=0.004, seg=1)
    ob = b.finish('plate', parent)
    ob['part'] = 'plate'
    return ob


# ---------------------------------------------------------------- wheel

def wheel(parent, lod):
    seg = 64 if lod == 0 else 24
    b = Builder(['tyre', 'rim', 'rimLip', 'disc', 'black'])
    r, tw = WHEEL_R, WHEEL_W
    rim_r = r * 0.7
    # Tyre: sidewalls with shoulder, three circumferential grooves.
    prof = [(rim_r, -tw * 0.47), (r * 0.86, -tw * 0.5), (r * 0.96, -tw * 0.47), (r * 0.995, -tw * 0.42), (r, -tw * 0.36)]
    if lod == 0:
        for g in (-0.2, 0.0, 0.2):
            x = g * tw
            prof += [(r, x - 0.012), (r - 0.007, x - 0.009), (r - 0.007, x + 0.009), (r, x + 0.012)]
    prof += [(r, tw * 0.36), (r * 0.995, tw * 0.42), (r * 0.96, tw * 0.47), (r * 0.86, tw * 0.5), (rim_r, tw * 0.47)]
    b.lathe_x('tyre', prof, seg)
    # Rim barrel, lip and dish (outer face at +x).
    face = tw * 0.36
    b.lathe_x('rim', [(rim_r - 0.01, face - 0.01), (rim_r - 0.01, -tw * 0.44), (rim_r, -tw * 0.46)], seg)
    b.lathe_x('rimLip', [(rim_r, face - 0.01), (rim_r + 0.012, face), (rim_r + 0.006, face + 0.012), (rim_r - 0.014, face + 0.008), (rim_r - 0.02, face - 0.005)], seg)
    # Hub and centre lock.
    b.lathe_x('rim', [(0.0, face - 0.05), (0.075, face - 0.05), (0.085, face - 0.02), (0.06, face + 0.005), (0.0, face + 0.012)], max(16, seg // 3))
    b.lathe_x('rimLip', [(0.0, face + 0.01), (0.035, face + 0.01), (0.03, face + 0.03), (0.0, face + 0.032)], 12)
    # Ten twisted spokes in five pairs, slightly concave.
    spokes = 5 if lod == 0 else 5
    for k in range(spokes):
        for off in ((-0.13, 0.13) if lod == 0 else (0.0,)):
            ang = 2 * math.pi * k / spokes + off
            L = rim_r - 0.07
            w0, w1 = (0.034, 0.024) if lod == 0 else (0.06, 0.05)
            bm = b.bm
            # Spoke as a tapered box from the hub (r=0.07) to the lip, dished inwards.
            pts = []
            for rr, x, w in ((0.07, face - 0.01, w0), (rim_r - 0.005, face - 0.035, w1)):
                for dx, dw in ((0.0, -1), (0.0, 1), (-0.025, 1), (-0.025, -1)):
                    t = dw * w / 2
                    y = rr * math.cos(ang) - t * math.sin(ang)
                    z = rr * math.sin(ang) + t * math.cos(ang)
                    pts.append(bm.verts.new(bl(x + dx, y, z)))
            a, c = pts[:4], pts[4:]
            fs = [bm.faces.new(list(reversed(a))), bm.faces.new(c)]
            for i in range(4):
                j = (i + 1) % 4
                fs.append(bm.faces.new((a[i], a[j], c[j], c[i])))
            for f in fs:
                f.material_index = 1
    # Brake disc with hat.
    disc_r = rim_r * 0.85
    b.lathe_x('disc', [(0.09, face - 0.075 - 0.016), (disc_r, face - 0.075 - 0.016), (disc_r, face - 0.075 + 0.016), (0.09, face - 0.075 + 0.016)], seg)
    b.lathe_x('black', [(0.05, face - 0.06), (0.11, face - 0.06), (0.11, face - 0.085), (0.05, face - 0.085)], max(12, seg // 4), closed=False)
    ob = b.finish('wheel_lod%d' % lod, parent)
    return ob


def caliper(parent):
    b = Builder(['caliper'])
    rim_r = WHEEL_R * 0.7
    face = WHEEL_W * 0.36
    b.box('caliper', (0.07, 0.16, 0.1), at=(face - 0.045, rim_r * 0.6, -rim_r * 0.34), rot=(0.5, 0, 0), bevel=0.015, seg=2)
    return b.finish('caliper', parent)


# ---------------------------------------------------------------- LODs and export

def decimate(ob, ratio, name, parent):
    me = ob.data.copy()
    me.name = name
    cp = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(cp)
    cp.parent = parent
    for k, v in ob.items():
        cp[k] = v
    mod = cp.modifiers.new('dec', 'DECIMATE')
    mod.ratio = ratio
    mod.use_collapse_triangulate = True
    apply_mods(cp)
    smooth(cp)
    return cp


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    materials()
    root = empty('car')
    lods = [empty('lod%d' % i, root) for i in range(3)]

    shell = join('shell_lod0', [body_shell(None), cabin_shell(None)], lods[0])
    smooth(shell)
    shell['dent'] = True
    det, exhausts = details(lods[0])
    smooth(det, 30)
    decimate(shell, 0.35, 'shell_lod1', lods[1])
    d1 = decimate(det, 0.4, 'details_lod1', lods[1])
    decimate(shell, 0.1, 'shell_lod2', lods[2])

    for part in (splitter(root), wing(root), mirror(root, 1), mirror(root, -1), plate(root)):
        smooth(part, 30)

    for s, name in ((1, 'L'), (-1, 'R')):
        empty('exhaust_' + name, root, (s * 0.13, 0.3, -2.34))
        empty('headlight_' + name, root, (s * 0.66, 0.58, 2.05))

    w = empty('wheel', root)
    for lod in (0, 1):
        smooth(wheel(w, lod), 35)
    smooth(caliper(root), 40)

    for ob in bpy.context.scene.objects:
        if ob.type == 'MESH':
            print(f'  {ob.name:14s} {tris(ob):6d} Dreiecke')
    return root


def export(root):
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    stack = [root]
    bpy.ops.object.select_all(action='DESELECT')
    while stack:
        o = stack.pop()
        o.select_set(True)
        stack += list(o.children)
    bpy.ops.export_scene.gltf(filepath=OUT, use_selection=True, export_format='GLB', export_yup=True,
                              export_apply=True, export_extras=True, export_animations=False,
                              export_texcoords=False, export_tangents=False)
    print(f'{OUT}: {os.path.getsize(OUT) // 1024} KB')


if __name__ == '__main__':
    export(build())
