# Builds trees, bushes and a hedge for instancing and exports them as one GLB (public/models/vegetation.glb).
# Run: blender --background --factory-startup --python tools/blender/make_vegetation.py -- [out.glb]
# Then compress: npm run models:build (see package.json).
#
# Per species "<id>" (node with extras {height, crown, kind}):
#   <id>_lod0       400-800 triangles: trunk, main branches and a crown of lumpy leaf clusters
#   <id>_lod1       at most 120 triangles
#   <id>_billboard  two crossed quads with a baked picture of lod0 (trees only; texture atlas embedded)
# Vertex colours (COLOR_0) carry all colour on lod0/lod1; crown normals point away from the crown centre so
# the canopy shades softly as one volume. Trunk base at the origin, +Y up. Trees are normalised to 8 m tall
# (the game scales by LiDAR height / 8 and crown radius / crown); bushes are about 1.5 m; the hedge is a
# 1 m segment along z that tiles end to end.
import bpy, bmesh, math, os, random, sys
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import export, srgb, tris

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'vegetation.raw.glb')
TMP = os.path.join(os.path.dirname(OUT), '.veg-bake')

H = 8.0                    # normalised tree height
CELL = (256, 512)          # billboard atlas cell (w, h) in pixels
ATLAS = (2048, 1024)


def rgb(hexcol, k=1.0):
    c = srgb(hexcol)
    return (min(1, c[0] * k), min(1, c[1] * k), min(1, c[2] * k), 1.0)


class Plant:
    """One mesh in Blender coordinates (Z up), with per-corner colours and custom normals."""

    def __init__(self, seed):
        self.bm = bmesh.new()
        self.col = self.bm.loops.layers.float_color.new('Color')
        self.rnd = random.Random(seed)
        self.normals = {}       # loop -> normal override

    def limb(self, p0, p1, r0, r1, bark, seg=6, bands=None):
        """Tapered cylinder from p0 to p1 (no caps)."""
        p0, p1 = Vector(p0), Vector(p1)
        axis = (p1 - p0).normalized()
        side = axis.orthogonal().normalized()
        up = axis.cross(side)
        rings = []
        for t, r in ((0.0, r0), (1.0, r1)):
            c = p0.lerp(p1, t)
            rings.append([self.bm.verts.new(c + (side * math.cos(a) + up * math.sin(a)) * r)
                          for a in (2 * math.pi * k / seg for k in range(seg))])
        for k in range(seg):
            k2 = (k + 1) % seg
            f = self.bm.faces.new((rings[0][k], rings[0][k2], rings[1][k2], rings[1][k]))
            base = bark if not isinstance(bark, list) else self.rnd.choice(bark)
            shade = 0.8 + 0.3 * max(0, (f.calc_center_median() - p0).normalized().dot(Vector((0.4, -0.6, 0.6))))
            for l in f.loops:
                c = base
                if bands and (int(l.vert.co.z * bands[0]) % bands[1] == 0):
                    c = bands[2]
                l[self.col] = rgb(c, shade)
        return rings[1]

    def cluster(self, centre, radius, scale, leaf, crown_c, sub=1, jitter=0.28, hue=0.08, fruit=None):
        """Lumpy leaf cluster (icosphere) coloured darker underneath and towards the crown centre."""
        centre = Vector(centre)
        before = set(self.bm.verts)
        # Blender counts the plain icosahedron (20 faces) as subdivision 1.
        verts = bmesh.ops.create_icosphere(self.bm, subdivisions=sub + 1, radius=radius)['verts']
        for v in verts:
            h = math.sin(v.co.x * 12.9898 + v.co.y * 78.233 + v.co.z * 37.719 + self.rnd.random()) * 43758.5453
            k = 1 + (h - math.floor(h) - 0.5) * 2 * jitter
            v.co = Vector((v.co.x * scale[0], v.co.y * scale[1], v.co.z * scale[2])) * k + centre
        tint = 1 + self.rnd.uniform(-hue, hue)
        new = [v for v in self.bm.verts if v not in before]
        faces = {f for v in new for f in v.link_faces}
        crown_c = Vector(crown_c)
        for f in faces:
            fc = f.calc_center_median()
            out = (fc - crown_c)
            depth = min(1.0, out.length / max(radius, 1e-3) / 2.2)
            up = 0.5 + 0.5 * f.normal.z
            k = tint * (0.55 + 0.35 * up + 0.3 * depth)
            col = rgb(leaf, k)
            if fruit and self.rnd.random() < fruit[1]:
                col = rgb(fruit[0], 0.9 + 0.2 * up)
            for l in f.loops:
                l[self.col] = col
                # Canopy normal: mostly away from the crown centre, a little of the cluster's own shape.
                n = ((l.vert.co - crown_c).normalized() * 0.75 + (l.vert.co - centre).normalized() * 0.25).normalized()
                self.normals[l] = n
        return faces

    def finish(self, name, parent):
        bmesh.ops.recalc_face_normals(self.bm, faces=self.bm.faces)
        # Remember the custom normals per (face index, corner) before converting.
        order = []
        for f in self.bm.faces:
            for l in f.loops:
                order.append(tuple(self.normals[l]) if l in self.normals else None)
        me = bpy.data.meshes.new(name)
        self.bm.to_mesh(me)
        self.bm.free()
        me.color_attributes.active_color = me.color_attributes['Color']
        me.color_attributes.render_color_index = 0
        for p in me.polygons:
            p.use_smooth = True
        me.update()
        # Trunk faces keep flat-ish normals: use the face normal.
        corner = 0
        fixed = []
        for p in me.polygons:
            for li in p.loop_indices:
                fixed.append(order[corner] if order[corner] is not None else tuple(p.normal))
                corner += 1
        me.normals_split_custom_set(fixed)
        me.materials.append(bpy.data.materials['vegetation'])
        ob = bpy.data.objects.new(name, me)
        bpy.context.scene.collection.objects.link(ob)
        ob.parent = parent
        return ob


# ---------------------------------------------------------------- species

def broadleaf_tree(p, lod, trunk_h, trunk_r, bark, leaf, crown_c, crown_r, clusters, branches=4, squash=1.0, fruit=None,
                   bands=None, n_lod1=1):
    """Trunk with a few main branches ending in leaf clusters; crown_c/crown_r give the canopy volume."""
    rnd = p.rnd
    seg = 7 if lod == 0 else 5
    top = (0, 0, trunk_h)
    p.limb((0, 0, -0.3), top, trunk_r, trunk_r * 0.7, bark, seg, bands)
    cc = Vector(crown_c)
    if lod == 0:
        ends = []
        for i in range(branches):
            a = 2 * math.pi * (i + rnd.uniform(-0.2, 0.2)) / branches
            end = cc + Vector((math.cos(a) * crown_r * 0.55, math.sin(a) * crown_r * 0.55, rnd.uniform(-0.3, 0.6) * crown_r * squash))
            p.limb(top, end, trunk_r * 0.55, trunk_r * 0.2, bark, 5, bands)
            ends.append(end)
        p.limb(top, cc + Vector((0, 0, crown_r * 0.5 * squash)), trunk_r * 0.5, trunk_r * 0.2, bark, 5, bands)
        # Clusters: on the branch ends, the top and fill-ins around the canopy shell.
        pts = ends + [cc + Vector((0, 0, crown_r * 0.55 * squash))]
        while len(pts) < clusters:
            d = Vector((rnd.gauss(0, 1), rnd.gauss(0, 1), rnd.gauss(0, 0.8))).normalized()
            pts.append(cc + Vector((d.x * crown_r * 0.6, d.y * crown_r * 0.6, d.z * crown_r * 0.55 * squash)))
        for q in pts[:clusters]:
            r = crown_r * rnd.uniform(0.42, 0.55)
            p.cluster(q, r, (1, 1, 0.85 * squash), leaf, cc, sub=1, fruit=fruit)
    else:
        if n_lod1 == 1:
            p.cluster(cc, crown_r, (1, 1, squash), leaf, cc, sub=1, jitter=0.18)
        else:
            for k in range(n_lod1):
                off = Vector((0, 0, (k - (n_lod1 - 1) / 2) * crown_r * 0.7 * squash))
                p.cluster(cc + off, crown_r * 0.85, (1, 1, 0.75 * squash), leaf, cc, sub=0, jitter=0.15, fruit=fruit)


def platane(p, lod):
    broadleaf_tree(p, lod, 3.0, 0.24, [0x8a8f78, 0xb7b49a, 0x6f6a55, 0x9a9a80], 0x5b7a34, (0, 0, 5.3), 3.3, 8, branches=5, squash=0.8)


def linde(p, lod):
    broadleaf_tree(p, lod, 2.2, 0.22, 0x4a3f33, 0x4f7330, (0, 0, 5.1), 2.8, 8, branches=4, squash=1.05)


def kastanie(p, lod):
    broadleaf_tree(p, lod, 2.0, 0.26, 0x3f342a, 0x3e6229, (0, 0, 4.9), 3.3, 8, branches=5, squash=0.85)


def ahorn(p, lod):
    broadleaf_tree(p, lod, 2.5, 0.21, 0x5a5145, 0x5f8a33, (0, 0, 5.3), 2.9, 7, branches=4, squash=0.95)


def obstbaum(p, lod):
    broadleaf_tree(p, lod, 1.7, 0.2, 0x5a4632, 0x5c7a34, (0, 0, 4.9), 3.4, 7, branches=5, squash=0.7, fruit=(0xb8402a, 0.03))


def birke(p, lod):
    broadleaf_tree(p, lod, 3.4, 0.14, 0xd8d4c8, 0x7f9a45, (0.2, 0, 5.4), 2.2, 9, branches=4, squash=1.25,
                   bands=(3.0, 3, 0x2a2622))


def pappel(p, lod):
    rnd = p.rnd
    p.limb((0, 0, -0.3), (0, 0, 2.0), 0.24, 0.18, 0x4d4436, 7 if lod == 0 else 5)
    cc = Vector((0, 0, 4.9))
    if lod == 0:
        p.limb((0, 0, 2.0), (0, 0, 7.4), 0.18, 0.05, 0x4d4436, 5)
        for k in range(8):
            z = 2.4 + k * 0.72
            w = 1.25 * math.sin(math.pi * (0.15 + 0.85 * (k + 0.5) / 8)) + 0.2
            p.cluster((rnd.uniform(-0.15, 0.15), rnd.uniform(-0.15, 0.15), z + 0.3), w, (1, 1, 1.0), 0x56742f, cc, sub=1, jitter=0.25)
    else:
        p.cluster(cc, 1.0, (1.3, 1.3, 3.0), 0x56742f, cc, sub=1, jitter=0.12)


def fichte(p, lod):
    """Spruce: stacked jagged tiers narrowing to a point."""
    rnd = p.rnd
    p.limb((0, 0, -0.3), (0, 0, 1.2), 0.2, 0.17, 0x3f3125, 6 if lod == 0 else 5)
    tiers = 7 if lod == 0 else 2
    for k in range(tiers):
        t = k / tiers
        z0 = 0.8 + t * 6.6
        r = 2.5 * (1 - t) + 0.25
        h = (7.2 / tiers) * 1.6
        seg = 14 if lod == 0 else 6
        before = set(p.bm.verts)
        res = bmesh.ops.create_cone(p.bm, cap_ends=True, segments=seg, radius1=r, radius2=0.0, depth=h)
        rim = [v for v in res['verts'] if abs(v.co.z + h / 2) < 1e-4 and v.co.length > 1e-3]
        for j, v in enumerate(sorted(rim, key=lambda v: math.atan2(v.co.y, v.co.x))):
            k = (1.1 if j % 2 == 0 else 0.72) * rnd.uniform(0.9, 1.08) if lod == 0 else rnd.uniform(0.85, 1.1)
            v.co.x *= k
            v.co.y *= k
            v.co.z -= rnd.uniform(0.0, 0.35)       # drooping tips
        bmesh.ops.rotate(p.bm, cent=(0, 0, 0), matrix=Matrix.Rotation(rnd.uniform(0, 6.3), 3, 'Z'), verts=res['verts'])
        bmesh.ops.translate(p.bm, vec=(0, 0, z0 + h / 2), verts=res['verts'])
        cc = Vector((0, 0, z0 + h * 0.3))
        for f in {f for v in res['verts'] for f in v.link_faces}:
            up = 0.5 + 0.5 * f.normal.z
            col = rgb(0x2c4628, 0.65 + 0.45 * up + 0.15 * t)
            for l in f.loops:
                l[p.col] = col
                p.normals[l] = ((l.vert.co - Vector((0, 0, l.vert.co.z - 0.6))).normalized() * 0.7 + Vector((0, 0, 0.3))).normalized()


def kiefer(p, lod):
    """Pine: tall bare trunk (orange-brown higher up) and a flat, irregular umbrella crown."""
    rnd = p.rnd
    seg = 7 if lod == 0 else 5
    p.limb((0, 0, -0.3), (0, 0, 2.8), 0.22, 0.17, 0x5e4433, seg)
    p.limb((0, 0, 2.8), (0.25, 0.1, 5.6), 0.17, 0.12, 0x9a6a45, seg)
    cc = Vector((0.25, 0.1, 6.5))
    if lod == 0:
        for i in range(4):
            a = 2 * math.pi * i / 4 + rnd.uniform(-0.3, 0.3)
            end = cc + Vector((math.cos(a) * 1.6, math.sin(a) * 1.6, rnd.uniform(-0.6, 0.3)))
            p.limb((0.25, 0.1, 5.4), end, 0.09, 0.04, 0x9a6a45, 4)
            p.cluster(end, 1.15, (1.2, 1.2, 0.55), 0x3d5a2d, cc, sub=1, jitter=0.3)
        p.cluster(cc + Vector((0, 0, 0.7)), 1.2, (1.2, 1.2, 0.55), 0x3d5a2d, cc, sub=1, jitter=0.3)
        p.cluster(cc + Vector((0.4, -0.3, 1.1)), 0.9, (1.2, 1.2, 0.5), 0x3d5a2d, cc, sub=1, jitter=0.3)
    else:
        p.cluster(cc + Vector((0, 0, 0.3)), 2.3, (1, 1, 0.45), 0x3d5a2d, cc, sub=1, jitter=0.2)


def busch(p, lod):
    cc = Vector((0, 0, 0.75))
    if lod == 0:
        for q, r in (((0, 0, 0.75), 0.75), ((0.45, 0.2, 0.55), 0.55), ((-0.4, -0.3, 0.6), 0.55), ((0.0, 0.45, 0.95), 0.5)):
            p.cluster(q, r, (1, 1, 0.9), 0x48662b, cc, sub=1, jitter=0.3)
    else:
        p.cluster(cc, 0.9, (1, 1, 0.85), 0x48662b, cc, sub=1, jitter=0.2)


def gebuesch(p, lod):
    cc = Vector((0, 0, 0.7))
    if lod == 0:
        rnd = p.rnd
        for i in range(6):
            q = (rnd.uniform(-0.9, 0.9), rnd.uniform(-0.6, 0.6), rnd.uniform(0.4, 0.9))
            p.cluster(q, rnd.uniform(0.45, 0.65), (1.1, 1, 0.9), 0x4a5f2c, cc, sub=1, jitter=0.35)
        for i in range(3):
            a = rnd.uniform(0, 6.3)
            p.limb((0, 0, 0), (math.cos(a) * 0.8, math.sin(a) * 0.5, 1.4), 0.04, 0.015, 0x4a3b2c, 4)
    else:
        p.cluster(cc, 1.0, (1.3, 0.9, 0.7), 0x4a5f2c, cc, sub=0, jitter=0.2)


def hecke(p, lod):
    """1 m hedge segment along z (Blender -y), 0.8 m wide, 1.6 m high; flat ends so segments join."""
    bm = p.bm
    nx, ny, nz = (3, 4, 4) if lod == 0 else (1, 1, 1)
    before = set(bm.verts)
    res = bmesh.ops.create_cube(bm, size=1)
    bmesh.ops.scale(bm, vec=(0.8, 1.0, 1.6), verts=res['verts'])
    bmesh.ops.translate(bm, vec=(0, 0, 0.8), verts=res['verts'])
    if lod == 0:
        edges = [e for e in bm.edges if all(v in res['verts'] for v in e.verts)]
        bmesh.ops.subdivide_edges(bm, edges=edges, cuts=3, use_grid_fill=True)
        rnd = p.rnd
        for v in bm.verts:
            if v in before:
                continue
            # Lumpy sides and top; the end faces (y = ±0.5) stay flat so segments tile.
            if abs(abs(v.co.y) - 0.5) > 1e-4:
                v.co.x *= 1 + rnd.uniform(-0.08, 0.08)
                if v.co.z > 1.5:
                    v.co.z += rnd.uniform(-0.06, 0.06)
    for f in bm.faces:
        up = 0.5 + 0.5 * f.normal.z
        end = abs(f.normal.y) > 0.9
        col = rgb(0x3f5f27, (0.55 if end else 0.65) + 0.4 * up * (0.9 + 0.2 * p.rnd.random()))
        for l in f.loops:
            l[p.col] = col
            n = Vector((l.vert.co.x * 1.6, 0, (l.vert.co.z - 0.8) * 0.8)).normalized() if not end else Vector(f.normal)
            p.normals[l] = n


SPECIES = [
    # id, builder, kind (vegKinds name), tree?
    ('platane', platane, 'laubbaum', True),
    ('linde', linde, 'laubbaum', True),
    ('kastanie', kastanie, 'laubbaum', True),
    ('ahorn', ahorn, 'laubbaum', True),
    ('birke', birke, 'birke', True),
    ('pappel', pappel, 'pappel', True),
    ('fichte', fichte, 'nadelbaum', True),
    ('kiefer', kiefer, 'nadelbaum', True),
    ('obstbaum', obstbaum, 'obstbaum', True),
    ('busch', busch, 'busch', False),
    ('gebuesch', gebuesch, 'gebuesch', False),
    ('hecke', hecke, 'hecke', False),
]


def bounds(ob):
    vs = [ob.matrix_world @ v.co for v in ob.data.vertices]
    lo = Vector([min(v[i] for v in vs) for i in range(3)])
    hi = Vector([max(v[i] for v in vs) for i in range(3)])
    return lo, hi


def normalise(obs, tree):
    """Trees: scale so the tallest point is at 8 m (base stays at the origin)."""
    lo, hi = bounds(obs[0])
    k = H / hi.z if tree else 1.0
    for ob in obs:
        for v in ob.data.vertices:
            v.co *= k
    return k


# ---------------------------------------------------------------- billboards

def setup_bake():
    sc = bpy.context.scene
    sc.render.engine = 'BLENDER_EEVEE'
    sc.render.film_transparent = True
    sc.view_settings.view_transform = 'Standard'
    w = bpy.data.worlds.new('w')
    sc.world = w
    w.use_nodes = True
    w.node_tree.nodes['Background'].inputs[0].default_value = (0.75, 0.8, 0.85, 1)
    w.node_tree.nodes['Background'].inputs[1].default_value = 0.9
    sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
    sun.data.energy = 2.2
    sun.rotation_euler = (math.radians(40), 0, math.radians(-30))
    sc.collection.objects.link(sun)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    cam.data.type = 'ORTHO'
    sc.collection.objects.link(cam)
    sc.camera = cam
    return cam


def bake(ob, cam, path):
    """Orthographic side picture of ob filling one atlas cell; returns the used pixel size."""
    sc = bpy.context.scene
    lo, hi = bounds(ob)
    w = max(hi.x - lo.x, hi.y - lo.y)
    h = hi.z - max(lo.z, 0)
    px_per_m = min(CELL[0] / w, CELL[1] / h)
    pw, ph = max(8, int(w * px_per_m)), max(8, int(h * px_per_m))
    sc.render.resolution_x, sc.render.resolution_y = pw, ph
    cam.data.ortho_scale = max(w, h)
    cam.location = Vector(((lo.x + hi.x) / 2, -50, max(lo.z, 0) + h / 2))
    cam.rotation_euler = (math.pi / 2, 0, 0)
    for o in sc.objects:
        o.hide_render = o.type == 'MESH' and o is not ob
    sc.render.filepath = path
    bpy.ops.render.render(write_still=True)
    return pw, ph, w, h


def billboard(name, parent, w, h, uv):
    """Two crossed quads w x h (base at the origin) mapped to the atlas rectangle uv = (u0, v0, u1, v1)."""
    bm = bmesh.new()
    lay = bm.loops.layers.uv.new('UVMap')
    u0, v0, u1, v1 = uv
    for a in (0.0, math.pi / 2):
        d = Vector((math.cos(a), math.sin(a), 0)) * (w / 2)
        q = [bm.verts.new(-d), bm.verts.new(d), bm.verts.new(d + Vector((0, 0, h))), bm.verts.new(-d + Vector((0, 0, h)))]
        f = bm.faces.new(q)
        for l, t in zip(f.loops, ((u0, v0), (u1, v0), (u1, v1), (u0, v1))):
            l[lay].uv = t
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials['billboard'])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


# ---------------------------------------------------------------- build

def materials():
    m = bpy.data.materials.new('vegetation')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.9
    attr = nt.nodes.new('ShaderNodeVertexColor')
    attr.layer_name = 'Color'
    nt.links.new(attr.outputs['Color'], bsdf.inputs['Base Color'])
    b = bpy.data.materials.new('billboard')
    b.use_nodes = True
    b.use_backface_culling = False
    return m, b


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    materials()
    root = bpy.data.objects.new('vegetation', None)
    bpy.context.scene.collection.objects.link(root)
    cam = setup_bake()
    os.makedirs(TMP, exist_ok=True)
    cells = []
    for i, (sid, fn, kind, tree) in enumerate(SPECIES):
        node = bpy.data.objects.new(sid, None)
        bpy.context.scene.collection.objects.link(node)
        node.parent = root
        obs = []
        for lod in (0, 1):
            p = Plant(seed=1000 + i)
            fn(p, lod)
            obs.append(p.finish(f'{sid}_lod{lod}', node))
        normalise(obs, tree)
        lo, hi = bounds(obs[0])
        node['kind'] = kind
        node['height'] = round(hi.z, 3)
        node['crown'] = round(max(-lo.x, hi.x, -lo.y, hi.y), 3)
        if tree:
            path = os.path.join(TMP, f'{sid}.png')
            pw, ph, w, h = bake(obs[0], cam, path)
            cells.append((sid, node, path, pw, ph, w, h))
        for ob in obs:
            print(f'  {ob.name:18s} {tris(ob):5d} Dreiecke')
    # Pack the pictures into the atlas: cells of CELL px, 8 per row, bottom-centred.
    from PIL import Image
    atlas = Image.new('RGBA', ATLAS, (0, 0, 0, 0))
    per_row = ATLAS[0] // CELL[0]
    for k, (sid, node, path, pw, ph, w, h) in enumerate(cells):
        cx, cy = (k % per_row) * CELL[0], (k // per_row) * CELL[1]
        img = Image.open(path).convert('RGBA')
        x0 = cx + (CELL[0] - pw) // 2
        y0 = cy + CELL[1] - ph
        atlas.paste(img, (x0, y0))
        # glTF uv: v = 0 at the top of the image.
        uv = (x0 / ATLAS[0], 1 - (y0 + ph) / ATLAS[1], (x0 + pw) / ATLAS[0], 1 - y0 / ATLAS[1])
        billboard(f'{sid}_billboard', node, w, h, uv)
        print(f'  {sid + "_billboard":18s}     4 Dreiecke')
    # Bleed colour into transparent pixels so mipmaps do not darken the edges.
    alpha = atlas.getchannel('A')
    bled = atlas.copy()
    for r in (1, 2, 4, 8):
        from PIL import ImageFilter
        spread = bled.filter(ImageFilter.MaxFilter(2 * r + 1))
        bled = Image.composite(bled, spread, bled.getchannel('A').point(lambda a: 255 if a > 0 else 0))
    rgb_part = bled.convert('RGB')
    final = Image.merge('RGBA', (*rgb_part.split(), alpha))
    atlas_path = os.path.join(TMP, 'atlas.png')
    # Palette PNG keeps the embedded atlas small (flat low-poly colours quantise well).
    final.quantize(colors=256, method=Image.Quantize.FASTOCTREE).save(atlas_path, optimize=True)
    img = bpy.data.images.load(atlas_path)
    img.pack()
    b = bpy.data.materials['billboard']
    nt = b.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    bsdf = nt.nodes['Principled BSDF']
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    nt.links.new(tex.outputs['Alpha'], bsdf.inputs['Alpha'])
    bsdf.inputs['Roughness'].default_value = 0.9
    return root


if __name__ == '__main__':
    root = build()
    export(root, OUT, texcoords=True)
    import shutil
    shutil.rmtree(TMP, ignore_errors=True)
