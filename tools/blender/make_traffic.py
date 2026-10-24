# Builds the AI traffic and parked cars (generic, no real makes) and exports them as one GLB.
# Run: blender --background --factory-startup --python tools/blender/make_traffic.py -- [out.glb]
# Then compress: npm run models:build (see package.json).
#
# Same parts as src/traffic/vehicleModels.ts so they can be instanced: paint (tinted per instance),
# detail (glass, tyres, trim; colours as vertex colours), lights (head and tail lights, always lit),
# brake and blink (shown on demand). Each variant is exported as meshes "<kind>-<variant>_<part>"
# plus "<kind>-<variant>_<part>_lod1" for paint and detail (src/traffic/vehicleGlb.ts reads them).
# Model space: ground at y = 0, +z forward, +x left; sizes follow KINDS in src/traffic/trafficSim.ts.
import bpy, bmesh, math, os, sys
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import (Builder, Loft, apply_mods, bl, deg, decimate, empty, export, inset, join, mesh_object, pbr, region,
                    smooth, srgb, tris)

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'traffic.raw.glb')

# Colours of the fixed parts (sRGB hex), matching vehicleModels.ts where they overlap.
PALETTE = {
    'paint': 0xffffff, 'glass': 0x1d242c, 'tyre': 0x18181a, 'trim': 0x2a2b2e, 'black': 0x111214, 'rim': 0x8d9196,
    'chrome': 0xb9bdc2, 'plate': 0xe8e8e2, 'well': 0x0b0c0d, 'grille': 0x15161a, 'housing': 0x3a3d42,
    'indicator': 0x8a5a00, 'sign': 0x2b2200, 'head': 0xfff6e0, 'tail': 0x7a0d0d,
}
COLORS = list(PALETTE)
LIGHTS = {'head', 'tail'}
BRAKE = 0xff2a1a
BLINK = 0xffa000


def materials():
    for name, col in PALETTE.items():
        pbr(name, col, 0.0, 0.5)
    for name in ('detail', 'lights', 'brake', 'blink'):
        pbr(name, 0xffffff, 0.0, 0.5)


# ---------------------------------------------------------------- splitting into instanced parts

def split(ob, name, parent, extra_lod1=True, ratio=0.35):
    """Splits a multi-material object into the five instanced parts, with vertex colours."""
    me = ob.data
    names = [m.name for m in me.materials]
    groups = {'paint': [], 'detail': [], 'lights': []}
    for i, n in enumerate(names):
        groups['paint' if n == 'paint' else 'lights' if n in LIGHTS else 'detail'].append(i)
    out = {}
    for part, idx in groups.items():
        out[part] = sub_mesh(ob, f'{name}_{part}', parent, set(idx), names, colors=part != 'paint')
    # Brake and hazard lights: copies of the tail lights / indicators, pushed out so they cover them.
    out['brake'] = sub_mesh(ob, f'{name}_brake', parent, {names.index('tail')}, names, colors=True, push=0.006, flat=BRAKE)
    out['blink'] = sub_mesh(ob, f'{name}_blink', parent, {names.index('indicator')}, names, colors=True, push=0.008, flat=BLINK)
    bpy.data.objects.remove(ob)
    if extra_lod1:
        for part in ('paint', 'detail'):
            src = out[part]
            d = decimate(src, ratio, f'{name}_{part}_lod1', parent)
            d.data.materials.clear()
            d.data.materials.append(bpy.data.materials[part])
    for o in out.values():
        o.data.materials.clear()
        o.data.materials.append(bpy.data.materials[o.name.rsplit('_', 1)[1]])
        smooth(o, 35)
    return out


def sub_mesh(ob, name, parent, keep, names, colors, push=0.0, flat=None):
    bm = bmesh.new()
    bm.from_mesh(ob.data)
    bmesh.ops.delete(bm, geom=[f for f in bm.faces if f.material_index not in keep], context='FACES')
    bmesh.ops.delete(bm, geom=[v for v in bm.verts if not v.link_faces], context='VERTS')
    if push:
        bm.normal_update()
        for v in bm.verts:
            v.co += v.normal * push
    me = bpy.data.meshes.new(name)
    if colors:
        layer = bm.loops.layers.float_color.new('Color')
        for f in bm.faces:
            col = srgb(flat) if flat is not None else srgb(PALETTE[names[f.material_index]])
            for l in f.loops:
                l[layer] = col
    bm.to_mesh(me)
    bm.free()
    if colors:
        me.color_attributes.active_color = me.color_attributes['Color']
        me.color_attributes.render_color_index = 0
    o = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(o)
    o.parent = parent
    return o


def cut_arches(ob, axles, radius, cy, inner, outer):
    for z in axles:
        for s in (1, -1):
            bm = bmesh.new()
            v = bmesh.ops.create_cone(bm, cap_ends=True, segments=32, radius1=radius, radius2=radius, depth=outer - inner)['verts']
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=v)
            bmesh.ops.translate(bm, vec=bl(s * (inner + outer) / 2, cy, z), verts=v)
            cutter = mesh_object('cut', bm, None, ['well'])
            mod = ob.modifiers.new('arch', 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'EXACT'
            mod.material_mode = 'TRANSFER'
            mod.object = cutter
            apply_mods(ob)
            bpy.data.objects.remove(cutter)


def wheels(b, r, w, axles, x, seg=16):
    """Static wheels (traffic wheels do not turn): tyre with sidewall bulge, rim and hub."""
    for z in axles:
        for s in (1, -1):
            cx = s * x
            prof = [(r * 0.62, -w / 2), (r * 0.94, -w / 2), (r, -w * 0.35), (r, w * 0.35), (r * 0.94, w / 2), (r * 0.62, w / 2)]
            b.lathe_x('tyre', [(rr, cx + s * xx) for rr, xx in prof], seg, at=(0, r, z))
            b.lathe_x('rim', [(r * 0.62, cx + s * w * 0.42), (r * 0.5, cx + s * w * 0.46), (0.0, cx + s * w * 0.4)], seg, at=(0, r, z))
            b.lathe_x('tyre', [(r * 0.62, cx - s * w * 0.45), (0.0, cx - s * w * 0.45)], seg, at=(0, r, z))


# ---------------------------------------------------------------- passenger cars

def car_stations(L, front_top, rear_top):
    f, r = L / 2, -L / 2
    return [
        (r, 0.70, 0.42, rear_top - 0.10, 0.0, 2.6, 0.10),
        (r + 0.04, 0.84, 0.34, rear_top - 0.03, 0.0, 3.0, 0.10),
        (r + 0.18, 0.88, 0.30, rear_top, 0.0, 3.4, 0.10),
        (r + 0.9, 0.89, 0.29, 0.94, 0.0, 3.6, 0.10),
        (0.0, 0.89, 0.28, 0.93, 0.0, 3.6, 0.10),
        (f - 0.9, 0.89, 0.29, front_top + 0.04, 0.02, 3.6, 0.10),
        (f - 0.35, 0.87, 0.30, front_top, 0.02, 3.4, 0.10),
        (f - 0.08, 0.82, 0.33, front_top - 0.08, 0.01, 3.0, 0.10),
        (f, 0.66, 0.40, front_top - 0.16, 0.0, 2.6, 0.10),
    ]


CARS = {
    # length, hood and tail height, cabin (z, roof) profile, windows (windscreen, rear, side, pillars), axles
    'hatch': dict(L=4.05, front=0.86, rear=0.95,
                  cabin=[(-1.95, 0.95), (-1.86, 1.30), (-1.66, 1.42), (-0.2, 1.47), (0.25, 1.44), (0.85, 1.02), (1.0, 0.90)],
                  screen=(0.27, 0.93), back=(-1.95, -1.84), side=(-1.74, 0.22), pillars=[(-0.62, -0.54)], axles=(1.2, -1.35)),
    'sedan': dict(L=4.45, front=0.88, rear=0.98,
                  cabin=[(-1.25, 0.93), (-0.85, 1.28), (-0.55, 1.42), (0.15, 1.45), (0.45, 1.42), (1.0, 1.02), (1.2, 0.92)],
                  screen=(0.47, 1.15), back=(-1.2, -0.58), side=(-0.8, 0.42), pillars=[(-0.26, -0.18)], axles=(1.37, -1.33)),
    'estate': dict(L=4.5, front=0.88, rear=0.97,
                   cabin=[(-2.17, 0.97), (-2.08, 1.36), (-1.85, 1.44), (0.15, 1.46), (0.45, 1.43), (1.02, 1.02), (1.22, 0.92)],
                   screen=(0.47, 1.17), back=(-2.16, -2.0), side=(-1.98, 0.42), pillars=[(-0.32, -0.24), (-1.28, -1.2)], axles=(1.4, -1.35)),
}
CAR_WHEEL = dict(r=0.31, w=0.21, x=0.77)


def car(variant, parent):
    v = CARS[variant]
    L = v['L']
    f, r = L / 2, -L / 2
    b = Builder(COLORS)
    bm = b.bm
    M = {c: i for i, c in enumerate(COLORS)}
    # Lower body.
    zb = [f - 0.3, f - 0.08, r + 0.25, r + 0.06, f - 0.02]
    ab = [deg(x) for x in (-70, -55, -30, 10, 14, 20, 25, 45, 50)]
    lo = Loft(car_stations(L, v['front'], v['rear']), 26, 10, zb, ab)
    params, caps = lo.build(bm)
    for fc in [fc for fc, *_ in params] + caps:
        fc.material_index = M['paint']
    caps[0].material_index = M['trim']

    def paint(name, faces):
        for fc in faces:
            fc.material_index = M[name]
    paint('trim', region(params, r - 1, f + 1, deg(-70), deg(-55)))       # sills
    paint('black', region(params, r - 1, f + 1, -math.pi, deg(-70)))       # underside
    paint('trim', region(params, f - 0.3, f + 1, deg(-55), deg(-30)))      # front bumper
    paint('trim', region(params, r - 1, r + 0.25, deg(-55), deg(-30)))     # rear bumper
    for s in (1, -1):
        h = region(params, f - 0.3, f - 0.02, deg(20), deg(45), (s,))
        paint('head', h)
        inset(bm, h, 0.006, -0.003, M['housing'])
        paint('indicator', region(params, f - 0.3, f - 0.02, deg(14), deg(20), (s,)))
        t = region(params, r - 1, r + 0.25, deg(25), deg(50), (s,))
        paint('tail', t)
        paint('indicator', region(params, r - 1, r + 0.25, deg(14), deg(25), (s,)))
    g = region(params, f - 0.08, f + 1, deg(-30), deg(10))
    paint('grille', g)
    inset(bm, g, 0.01, -0.015, M['trim'])

    # The arches are cut from the closed lower body alone; everything else is added afterwards.
    wh = CAR_WHEEL
    shell = b.finish(f'car-{variant}', None)
    cut_arches(shell, v['axles'], wh['r'] + 0.06, wh['r'] + 0.02, 0.62, 1.2)
    b = Builder(COLORS)
    bm = b.bm

    # Cabin.
    prof = v['cabin']
    st = [(z, 0.74 if i in (0, len(prof) - 1) else 0.78, 0.86, top, 0, 3.0, 0.28) for i, (z, top) in enumerate(prof)]
    zc = [v['screen'][0], v['screen'][1], v['back'][0], v['back'][1], v['side'][0], v['side'][1]] + [z for p in v['pillars'] for z in p]
    cab = Loft(st, 18, 8, zc, [deg(x) for x in (8, 56, 62)])
    cp, ccaps = cab.build(bm)
    for fc in [fc for fc, *_ in cp] + ccaps:
        fc.material_index = M['paint']
    wins = [region(cp, *v['screen'], deg(62), math.pi), region(cp, *v['back'], deg(62), math.pi)]
    for s in (1, -1):
        z0, z1 = v['side']
        edges = [z0] + [z for p in v['pillars'] for z in p] + [z1]
        for a, c in zip(edges[::2], edges[1::2]):
            wins.append(region(cp, a, c, deg(8), deg(56), (s,)))
    for w in wins:
        paint('glass', w)
        inset(bm, w, 0.012, -0.004, M['trim'])

    # Mirrors, plates, underbody.
    zm = v['screen'][1] - 0.08
    for s in (1, -1):
        b.box('trim', (0.1, 0.03, 0.05), at=(s * 0.86, 0.96, zm))
        b.sphere('paint', 1, at=(s * 0.93, 0.98, zm - 0.02), scale=(0.07, 0.05, 0.09), seg=10, rings=6)
    b.box('plate', (0.52, 0.11, 0.012), at=(0, 0.52, r - 0.005))
    b.box('plate', (0.52, 0.11, 0.012), at=(0, 0.4, f + 0.005))
    b.box('black', (1.4, 0.05, L - 1.0), at=(0, 0.3, 0))
    wheels(b, wh['r'], wh['w'], v['axles'], wh['x'])
    ob = join(f'car-{variant}', [shell, b.finish('rest', None)], parent)
    return split(ob, f'car-{variant}', parent)


# ---------------------------------------------------------------- vans, buses and lorries

def slab(b, mat, p0, p1, x0, x1, t0=0.0, t1=1.0, off=0.01, thick=0.012):
    """Thin panel on the side-profile segment p0 -> p1 (each (z, y)), across x0..x1, pushed off the surface."""
    (z0, y0), (z1, y1) = p0, p1
    za, ya = z0 + (z1 - z0) * t0, y0 + (y1 - y0) * t0
    zb, yb = z0 + (z1 - z0) * t1, y0 + (y1 - y0) * t1
    ln = math.hypot(zb - za, yb - ya)
    # Outward normal of a profile going front -> top (anticlockwise seen from +x).
    nz, ny = (yb - ya) / ln, -(zb - za) / ln
    ang = math.atan2(yb - ya, zb - za)
    c = ((za + zb) / 2 + nz * off, (ya + yb) / 2 + ny * off)
    b.box(mat, (x1 - x0, thick, ln), at=((x0 + x1) / 2, c[1], c[0]), rot=(-ang, 0, 0))


def side(b, mat, z0, z1, y0, y1, x, thick=0.012):
    """Panel on both flanks at |x|."""
    for s in (1, -1):
        b.box(mat, (thick, y1 - y0, z1 - z0), at=(s * x, (y0 + y1) / 2, (z0 + z1) / 2))


def face(b, mat, x0, x1, y0, y1, z, thick=0.012, mirror=True):
    """Panel on the front or back face at z (mirrored to -x when x0 > 0)."""
    for s in ((1, -1) if mirror and x0 > 0 else (1,)):
        b.box(mat, (x1 - x0, y1 - y0, thick), at=(s * (x0 + x1) / 2, (y0 + y1) / 2, z))


def body(b, profile, width, mat='paint', bevel=0.05):
    """Prism from a side profile [(z, y), ...] across the width, edges rounded."""
    before = set(b.bm.verts)
    b.extrude_x(mat, profile, -width / 2, width / 2)
    v = [x for x in b.bm.verts if x not in before]
    edges = list({e for x in v for e in x.link_edges})
    bmesh.ops.bevel(b.bm, geom=v + edges, offset=bevel, segments=2, affect='EDGES', profile=0.5)
    bmesh.ops.recalc_face_normals(b.bm, faces=b.bm.faces)


def van(parent):
    L, W, H = 5.3, 2.0, 2.25
    f, r = L / 2, -L / 2
    b = Builder(COLORS)
    prof = [(r, 0.35), (f - 0.05, 0.35), (f, 0.5), (f, 0.95), (f - 0.6, 1.12), (f - 1.25, 2.15), (f - 1.45, H), (r, H)]
    body(b, prof, W)
    axles = (f - 0.85, r + 1.05)
    shell = b.finish('van-panel', None)
    cut_arches(shell, axles, 0.4, 0.36, 0.7, 1.3)
    b = Builder(COLORS)
    hw = W / 2 + 0.005
    slab(b, 'glass', prof[4], prof[5], -0.86, 0.86, 0.05, 0.95)
    side(b, 'glass', f - 1.85, f - 0.75, 1.15, 1.95, hw)
    side(b, 'trim', r + 0.05, f - 0.05, 0.35, 0.55, hw)              # rubbing strip
    side(b, 'black', -0.45, -0.43, 0.6, 2.0, hw)                     # sliding door gap
    face(b, 'grille', -0.55, 0.55, 0.55, 0.85, f + 0.005)
    face(b, 'head', 0.6, 0.92, 0.72, 0.88, f + 0.006)
    face(b, 'indicator', 0.6, 0.92, 0.62, 0.7, f + 0.006)
    face(b, 'trim', -1.0, 1.0, 0.3, 0.52, f + 0.02, thick=0.05, mirror=False)
    face(b, 'tail', 0.84, 0.97, 0.8, 1.25, r - 0.006)
    face(b, 'indicator', 0.84, 0.97, 1.25, 1.38, r - 0.006)
    face(b, 'glass', 0.1, 0.8, 1.45, 2.05, r - 0.006)
    face(b, 'black', -0.01, 0.01, 0.4, 2.1, r - 0.006, mirror=False)
    face(b, 'plate', -0.26, 0.26, 0.5, 0.61, r - 0.008, mirror=False)
    face(b, 'trim', -1.0, 1.0, 0.3, 0.5, r - 0.02, thick=0.05, mirror=False)
    for s in (1, -1):
        b.box('trim', (0.06, 0.25, 0.12), at=(s * 1.06, 1.45, f - 1.2))
    wheels(b, 0.34, 0.24, axles, 0.86)
    ob = join('van-panel', [shell, b.finish('rest', None)], parent)
    return split(ob, 'van-panel', parent, ratio=0.5)


def bus(parent):
    L, W, H = 12.0, 2.55, 3.1
    f, r = L / 2, -L / 2
    b = Builder(COLORS)
    prof = [(r, 0.35), (f, 0.35), (f, 2.95), (f - 0.12, H), (r + 0.1, H), (r, 2.95)]
    body(b, prof, W, bevel=0.1)
    axles = (f - 2.6, r + 3.2)
    shell = b.finish('bus-city', None)
    cut_arches(shell, axles, 0.58, 0.52, 0.8, 1.5)
    b = Builder(COLORS)
    hw = W / 2 + 0.005
    # Window band with pillars, doors on the right (-x) side.
    for s in (1, -1):
        b.box('glass', (0.012, 1.45, L - 0.9), at=(s * hw, 2.02, 0.1))
        for i in range(10):
            b.box('trim', (0.018, 1.45, 0.1), at=(s * (hw + 0.004), 2.02, r + 0.6 + i * 1.18))
    for z in (f - 1.0, -0.3):
        b.box('glass', (0.016, 2.25, 1.15), at=(-(hw + 0.006), 1.55, z))
        b.box('black', (0.02, 2.25, 0.02), at=(-(hw + 0.008), 1.55, z))
    face(b, 'glass', -1.18, 1.18, 1.0, 2.7, f + 0.006, mirror=False)
    face(b, 'sign', -0.9, 0.9, 2.78, 3.0, f + 0.006, mirror=False)
    face(b, 'head', 0.82, 1.15, 0.55, 0.72, f + 0.006)
    face(b, 'indicator', 0.82, 1.15, 0.75, 0.83, f + 0.006)
    face(b, 'grille', -0.6, 0.6, 0.45, 0.8, f + 0.006, mirror=False)
    face(b, 'trim', -1.28, 1.28, 0.3, 0.45, f + 0.03, thick=0.06, mirror=False)
    face(b, 'glass', -0.9, 0.9, 1.6, 2.6, r - 0.006, mirror=False)
    face(b, 'tail', 0.95, 1.2, 0.8, 1.35, r - 0.006)
    face(b, 'indicator', 0.95, 1.2, 1.38, 1.5, r - 0.006)
    face(b, 'grille', -0.8, 0.8, 0.5, 1.3, r - 0.006, mirror=False)
    face(b, 'plate', -0.26, 0.26, 0.42, 0.53, r - 0.008, mirror=False)
    b.box('trim', (1.6, 0.25, 2.4), at=(0, H + 0.12, -2.0), bevel=0.05, seg=1)   # roof AC unit
    wheels(b, 0.5, 0.3, axles, 1.0)
    ob = join('bus-city', [shell, b.finish('rest', None)], parent)
    return split(ob, 'bus-city', parent, ratio=0.5)


def truck(parent):
    L, W, H = 10.5, 2.5, 3.6
    f, r = L / 2, -L / 2
    cab = 2.3
    b = Builder(COLORS)
    cprof = [(f - cab, 0.6), (f, 0.6), (f, 2.75), (f - 0.15, 2.95), (f - cab, 2.95)]
    body(b, cprof, W - 0.05, bevel=0.08)
    # Box body and chassis.
    b.box('paint', (W, H - 1.0, L - cab - 0.15), at=(0, (H + 1.0) / 2, (r + f - cab - 0.15) / 2), bevel=0.03, seg=1)
    b.box('trim', (W - 0.6, 0.45, L - 0.4), at=(0, 0.78, 0.0))
    hw = (W - 0.05) / 2 + 0.005
    face(b, 'glass', -1.08, 1.08, 1.75, 2.6, f + 0.006, mirror=False)
    side(b, 'glass', f - 1.2, f - 0.25, 1.75, 2.55, hw)
    face(b, 'grille', -0.85, 0.85, 0.9, 1.6, f + 0.006, mirror=False)
    face(b, 'head', 0.8, 1.15, 0.85, 1.02, f + 0.006)
    face(b, 'indicator', 0.8, 1.15, 1.05, 1.14, f + 0.006)
    face(b, 'trim', -1.25, 1.25, 0.5, 0.8, f + 0.03, thick=0.06, mirror=False)
    face(b, 'tail', 0.85, 1.15, 1.02, 1.18, r - 0.006)
    face(b, 'indicator', 0.6, 0.82, 1.02, 1.18, r - 0.006)
    face(b, 'black', -0.01, 0.01, 1.1, 3.5, r - 0.006, mirror=False)
    face(b, 'plate', -0.26, 0.26, 0.82, 0.93, r - 0.008, mirror=False)
    for s in (1, -1):
        b.box('trim', (0.06, 0.4, 0.14), at=(s * 1.32, 2.2, f - 0.3))
    axles = (f - 1.4, r + 2.4, r + 1.1)
    wheels(b, 0.52, 0.36, axles, 1.02)
    ob = b.finish('truck-box', parent)
    return split(ob, 'truck-box', parent, ratio=0.5)


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    materials()
    root = empty('traffic')
    for v in CARS:
        car(v, root)
    van(root)
    bus(root)
    truck(root)
    for ob in sorted(bpy.context.scene.objects, key=lambda o: o.name):
        if ob.type == 'MESH':
            print(f'  {ob.name:24s} {tris(ob):6d} Dreiecke')
    return root


if __name__ == '__main__':
    export(build(), OUT)
