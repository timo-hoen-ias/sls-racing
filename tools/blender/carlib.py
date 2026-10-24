# Shared building blocks for the car scripts (make_sportscar.py, make_traffic.py).
# Model space is the game's: ground at y = 0, +z forward, +x left, 1 unit = 1 m; in Blender (x, -z, y).
import bpy, bmesh, math, os
from mathutils import Vector, Matrix


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



def export(root, out):
    os.makedirs(os.path.dirname(out), exist_ok=True)
    stack = [root]
    bpy.ops.object.select_all(action='DESELECT')
    while stack:
        o = stack.pop()
        o.select_set(True)
        stack += list(o.children)
    bpy.ops.export_scene.gltf(filepath=out, use_selection=True, export_format='GLB', export_yup=True,
                              export_apply=True, export_extras=True, export_animations=False,
                              export_texcoords=False, export_tangents=False, export_vertex_color='ACTIVE')
    print(f'{out}: {os.path.getsize(out) // 1024} KB')
