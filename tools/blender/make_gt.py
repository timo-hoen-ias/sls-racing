# Builds a generic front-engined grand tourer (no real make) as an alternative player car: public/models/cars/gt.glb.
# Same node layout as the sports coupé (make_sportscar.py), so src/vehicle/sportsCarGlb.ts loads it unchanged:
#   car (extras: name, length, width, wheel{front, rear, track, radius, width}), lod0..2, splitter, wing (roof spoiler),
#   mirrorL/R, plate, exhaust_L/R, headlight_L/R, wheel (lod0/1), caliper.
# Longer wheelbase than CAR in src/vehicle/tuning.ts: the extras say where the wheels belong (per-car tuning).
# Run: blender --background --factory-startup --python tools/blender/make_gt.py -- [out.glb]
import bpy, bmesh, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, Loft, bl, deg, decimate, empty, export, inset, join, mesh_object, region, smooth, tris
import make_sportscar as sc

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'cars', 'gt.raw.glb')
M = sc.M

F, R = 2.42, -2.30         # front and rear end (m)
AXLES = (1.42, -1.33)      # wheelbase 2.75 m
TRACK = 0.82

# Station: z, half width, bottom, top, dip, n, tumble.
BODY = [
    (R, 0.70, 0.40, 0.70, 0.00, 3.0, 0.10),
    (R + 0.04, 0.84, 0.33, 0.78, 0.00, 3.4, 0.10),
    (-2.05, 0.91, 0.27, 0.84, 0.01, 3.8, 0.10),
    (-1.33, 0.955, 0.24, 0.86, 0.02, 4.0, 0.08),
    (-0.40, 0.92, 0.23, 0.80, 0.03, 3.8, 0.08),
    (0.50, 0.92, 0.23, 0.80, 0.06, 3.8, 0.10),
    (1.42, 0.945, 0.24, 0.85, 0.13, 3.8, 0.10),
    (2.00, 0.90, 0.26, 0.75, 0.10, 3.4, 0.10),
    (2.30, 0.80, 0.30, 0.61, 0.04, 3.0, 0.10),
    (F, 0.66, 0.36, 0.52, 0.00, 2.6, 0.10),
]

CABIN = [
    (-2.15, 0.70, 0.35, 0.86, 0, 3.0, 0.34),
    (-1.70, 0.76, 0.35, 1.05, 0, 3.0, 0.34),
    (-1.00, 0.80, 0.35, 1.24, 0, 3.0, 0.35),
    (-0.40, 0.82, 0.35, 1.30, 0, 3.0, 0.36),
    (0.10, 0.82, 0.35, 1.28, 0, 3.0, 0.36),
    (0.55, 0.80, 0.35, 1.04, 0, 3.0, 0.34),
    (0.95, 0.76, 0.35, 0.84, 0, 3.0, 0.34),
]


def cut_arches(ob):
    """Wheel arches at this car's axles (the coupé's cut_arches uses its own)."""
    for z in AXLES:
        for side in (1, -1):
            bm = bmesh.new()
            v = bmesh.ops.create_cone(bm, cap_ends=True, segments=48, radius1=sc.ARCH_R, radius2=sc.ARCH_R, depth=0.7)['verts']
            bmesh.ops.rotate(bm, cent=(0, 0, 0), matrix=sc.Matrix.Rotation(math.pi / 2, 3, 'Y'), verts=v)
            bmesh.ops.translate(bm, vec=bl(side * (TRACK + 0.12), sc.ARCH_Y, z), verts=v)
            cutter = mesh_object('cut', bm, None, ['well'])
            mod = ob.modifiers.new('arch', 'BOOLEAN')
            mod.operation = 'DIFFERENCE'
            mod.solver = 'EXACT'
            mod.material_mode = 'TRANSFER'
            mod.object = cutter
            sc.apply_mods(ob)
            bpy.data.objects.remove(cutter)


def body_shell():
    bm = bmesh.new()
    zb = [2.0, 2.3, 2.38, R + 0.08, R + 0.12, 0.85, 1.05, 0.62, 0.628, 1.2, 2.1, -2.22]
    ab = [deg(x) for x in (-70, -55, -50, -30, -15, -10, 10, 15, 20, 32, 40, 44, 52, 84, 86)]
    L = Loft(BODY, 120, 32, zb, ab)
    params, caps = L.build(bm)
    caps[0].material_index = M['black']
    caps[1].material_index = M['black']

    def paint(name, faces):
        for f in faces:
            f.material_index = M[name]

    paint('black', region(params, R - 1, F + 1, -math.pi, deg(-70)))
    paint('carbon', region(params, R - 1, F + 1, deg(-70), deg(-55)))                # sills
    for s_ in (1, -1):
        h = region(params, 2.0, 2.38, deg(20), deg(44), (s_,))                         # long slim headlights
        paint('housing', h)
        paint('head', region(params, 2.0, 2.38, deg(32), deg(40), (s_,)))
        inset(bm, h, 0.008, -0.004, M['trim'])
        v = region(params, 0.85, 1.05, deg(-10), deg(15), (s_,))                       # wing vent behind the front wheel
        paint('black', v)
        inset(bm, v, 0.01, -0.02, M['trim'])
        paint('indicator', region(params, R - 1, R + 0.08, deg(32), deg(40), (s_,)))
    paint('brake', region(params, R - 1, R + 0.12, deg(40), deg(52)))                 # slim full-width tail lights
    g = region(params, 2.3, F + 1, deg(-30), deg(10))                                  # wide low grille
    paint('black', g)
    inset(bm, g, 0.012, -0.035, M['trim'])
    paint('black', region(params, R - 1, -2.22, deg(-50), deg(-15)))                  # diffuser fascia
    paint('seam', region(params, 0.62, 0.628, deg(-55), deg(52)))                     # door shut line
    paint('seam', region(params, 1.2, 2.1, deg(84), deg(86)))                         # bonnet shut lines
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_object('body', bm, None, sc.SHELL_MATS)
    cut_arches(ob)
    return ob


def cabin_shell():
    bm = bmesh.new()
    zb = [0.10, 0.80, -1.95, -0.95, -1.0, 0.05, -1.35, -1.05]
    ab = [deg(x) for x in (12, 40, 45)]
    L = Loft(CABIN, 60, 20, zb, ab)
    params, caps = L.build(bm)
    for f in caps:
        f.material_index = M['paint']
    wins = [region(params, 0.10, 0.80, deg(45), math.pi), region(params, -1.95, -0.95, deg(45), math.pi)]
    for s_ in (1, -1):
        wins.append(region(params, -1.0, 0.05, deg(12), deg(40), (s_,)))           # door glass
        wins.append(region(params, -1.35, -1.05, deg(12), deg(40), (s_,)))         # quarter window
    for w in wins:
        for f in w:
            f.material_index = M['glass']
        inset(bm, w, 0.016, -0.006, M['trim'])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object('cabin', bm, None, sc.SHELL_MATS)


def details(parent):
    b = Builder(['black', 'carbon', 'chrome', 'trim', 'plate', 'housing'])
    b.box('black', (1.36, 0.05, 3.9), at=(0, 0.2, 0))                                # underbody
    b.box('carbon', (1.2, 0.04, 0.36), at=(0, 0.26, R + 0.1), rot=(-0.2, 0, 0))       # diffuser
    exhausts = []
    for s_ in (1, -1):                                                                # quad pipes, two per side
        for dx in (0.0, 0.13):
            x = s_ * (0.42 + dx)
            b.cyl('chrome', 0.045, 0.04, 0.16, at=(x, 0.29, R - 0.02), rot=(math.pi / 2, 0, 0), seg=20, caps=False)
            b.cyl('black', 0.038, 0.038, 0.01, at=(x, 0.29, R + 0.03), rot=(math.pi / 2, 0, 0), seg=20)
        exhausts.append((s_ * 0.485, 0.29, R - 0.1))
        b.box('trim', (0.012, 0.025, 0.15), at=(s_ * 0.915, 0.74, 0.0), bevel=0.004, seg=1)  # door handle
    return b.finish('details', parent), exhausts


def splitter(parent):
    b = Builder(['carbon'])
    b.box('carbon', (1.5, 0.025, 0.2), at=(0, 0.3, F - 0.06), bevel=0.01, seg=1)
    ob = b.finish('splitter', parent)
    ob['part'] = 'splitter'
    return ob


def wing(parent):
    """Ducktail lip on the rear deck."""
    b = Builder(['paint'])
    b.box('paint', (1.4, 0.05, 0.22), at=(0, 0.74, R + 0.12), rot=(0.35, 0, 0), bevel=0.015, seg=1)
    ob = b.finish('wing', parent)
    ob['part'] = 'wing'
    return ob


def mirror(parent, s_):
    b = Builder(['paint', 'black', 'glass'])
    b.box('black', (0.1, 0.03, 0.05), at=(s_ * 0.86, 0.86, 0.72), bevel=0.008, seg=1)
    b.sphere('paint', 1, at=(s_ * 0.95, 0.88, 0.7), scale=(0.1, 0.055, 0.12), seg=20, rings=10)
    b.box('glass', (0.13, 0.065, 0.006), at=(s_ * 0.955, 0.88, 0.65))
    ob = b.finish('mirrorL' if s_ > 0 else 'mirrorR', parent)
    ob['part'] = ob.name
    return ob


def plate(parent):
    b = Builder(['plate', 'black'])
    b.box('black', (0.54, 0.13, 0.012), at=(0, 0.52, R - 0.005))
    b.box('plate', (0.52, 0.11, 0.01), at=(0, 0.52, R - 0.013), bevel=0.004, seg=1)
    ob = b.finish('plate', parent)
    ob['part'] = 'plate'
    return ob


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc.materials()
    root = empty('car')
    root['name'] = 'GT'
    root['length'] = round(F - R, 3)
    root['width'] = 1.91
    root['wheel'] = {'front': AXLES[0], 'rear': AXLES[1], 'track': TRACK, 'radius': sc.WHEEL_R, 'width': sc.WHEEL_W}
    lods = [empty('lod%d' % i, root) for i in range(3)]
    shell = join('shell_lod0', [body_shell(), cabin_shell()], lods[0])
    smooth(shell)
    shell['dent'] = True
    det, exhausts = details(lods[0])
    smooth(det, 30)
    decimate(shell, 0.35, 'shell_lod1', lods[1])
    decimate(det, 0.4, 'details_lod1', lods[1])
    decimate(shell, 0.1, 'shell_lod2', lods[2])
    for part in (splitter(root), wing(root), mirror(root, 1), mirror(root, -1), plate(root)):
        smooth(part, 30)
    for (x, y, z), name in zip(exhausts, ('L', 'R')):
        empty('exhaust_' + name, root, (x, y, z))
    for s, name in ((1, 'L'), (-1, 'R')):
        empty('headlight_' + name, root, (s * 0.7, 0.68, 2.25))
    w = empty('wheel', root)
    for lod in (0, 1):
        smooth(sc.wheel(w, lod), 35)
    smooth(sc.caliper(root), 40)
    for ob in bpy.context.scene.objects:
        if ob.type == 'MESH':
            print(f'  {ob.name:14s} {tris(ob):6d} Dreiecke')
    return root


if __name__ == '__main__':
    export(build(), OUT)
