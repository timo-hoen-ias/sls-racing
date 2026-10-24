# Builds a generic three-door hot hatch (no real make) as an alternative player car: public/models/cars/hothatch.glb.
# Same node layout as the sports coupé (make_sportscar.py), so src/vehicle/sportsCarGlb.ts loads it unchanged:
#   car (extras: name, length, width, wheel{front, rear, track, radius, width}), lod0..2, splitter, wing (roof spoiler),
#   mirrorL/R, plate, exhaust_L/R, headlight_L/R, wheel (lod0/1), caliper.
# The wheels sit where CAR in src/vehicle/tuning.ts puts them, so it drives with today's physics.
# Run: blender --background --factory-startup --python tools/blender/make_hothatch.py -- [out.glb]
import bpy, bmesh, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, Loft, bl, deg, decimate, empty, export, inset, join, mesh_object, region, smooth, tris
import make_sportscar as sc

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'cars', 'hothatch.raw.glb')
M = sc.M

F, R = 2.0, -1.97          # front and rear end (m)

# Station: z, half width, bottom, top, dip, n, tumble.
BODY = [
    (R, 0.80, 0.36, 0.95, 0.00, 3.4, 0.10),
    (R + 0.03, 0.86, 0.30, 1.00, 0.00, 3.8, 0.10),
    (-1.75, 0.89, 0.25, 1.02, 0.01, 4.2, 0.08),
    (-1.20, 0.905, 0.23, 1.02, 0.02, 4.4, 0.06),
    (0.00, 0.89, 0.22, 1.00, 0.03, 4.2, 0.06),
    (1.00, 0.90, 0.23, 0.95, 0.05, 4.2, 0.08),
    (1.27, 0.90, 0.23, 0.93, 0.06, 4.2, 0.10),
    (1.75, 0.88, 0.25, 0.88, 0.05, 4.0, 0.10),
    (1.95, 0.84, 0.28, 0.83, 0.03, 3.6, 0.10),
    (F, 0.76, 0.33, 0.77, 0.00, 3.2, 0.10),
]

CABIN = [
    (-1.96, 0.80, 0.40, 0.98, 0, 3.4, 0.36),
    (-1.90, 0.84, 0.40, 1.32, 0, 3.4, 0.36),
    (-1.72, 0.86, 0.40, 1.43, 0, 3.4, 0.37),
    (-0.60, 0.87, 0.40, 1.46, 0, 3.4, 0.38),
    (0.15, 0.87, 0.40, 1.44, 0, 3.4, 0.38),
    (0.85, 0.85, 0.40, 1.00, 0, 3.4, 0.36),
    (1.00, 0.83, 0.40, 0.92, 0, 3.4, 0.36),
]


def body_shell():
    bm = bmesh.new()
    zb = [1.70, 1.97, -1.86, -1.80, 0.20, 0.208, 1.10, 1.90, -1.5]
    ab = [deg(x) for x in (-70, -55, -50, -30, -25, -15, 8, 14, 18, 30, 34, 42, 48, 58, 84, 86)]
    L = Loft(BODY, 90, 30, zb, ab)
    params, caps = L.build(bm)
    caps[0].material_index = M['black']
    caps[1].material_index = M['black']

    def paint(name, faces):
        for f in faces:
            f.material_index = M[name]

    paint('black', region(params, R - 1, F + 1, -math.pi, deg(-70)))
    paint('trim', region(params, R - 1, F + 1, deg(-70), deg(-55)))                 # side skirts
    for s in (1, -1):                                                                 # headlights
        h = region(params, 1.70, 1.97, deg(14), deg(48), (s,))
        paint('housing', h)
        paint('head', region(params, 1.70, 1.97, deg(34), deg(42), (s,)))
        inset(bm, h, 0.008, -0.004, M['trim'])
        t = region(params, R - 1, -1.86, deg(30), deg(58), (s,))                     # tail lights
        paint('brake', t)
        inset(bm, t, 0.006, -0.004, M['trim'])
        paint('indicator', region(params, R - 1, -1.86, deg(18), deg(30), (s,)))
    g = region(params, 1.97, F + 1, deg(-25), deg(8))                                 # honeycomb grille
    paint('black', g)
    inset(bm, g, 0.012, -0.03, M['trim'])
    low = region(params, 1.70, F + 1, deg(-55), deg(-30))                             # lower intake
    paint('black', low)
    inset(bm, low, 0.01, -0.02, M['trim'])
    paint('black', region(params, R - 1, -1.80, deg(-55), deg(-15)))                  # rear diffuser fascia
    paint('seam', region(params, 0.20, 0.208, deg(-55), deg(58)))                     # door shut line
    paint('seam', region(params, 1.10, 1.90, deg(84), deg(86)))                       # bonnet shut lines
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_object('body', bm, None, sc.SHELL_MATS)
    sc.cut_arches(ob)
    return ob


def cabin_shell():
    bm = bmesh.new()
    zb = [0.10, 0.95, -1.95, -1.55, -1.5, 0.05, -0.55, -0.47]
    ab = [deg(x) for x in (12, 45, 50)]
    L = Loft(CABIN, 50, 20, zb, ab)
    params, caps = L.build(bm)
    for f in caps:
        f.material_index = M['paint']
    wins = [region(params, 0.10, 0.95, deg(45), math.pi), region(params, -1.95, -1.55, deg(45), math.pi)]
    for s in (1, -1):
        wins.append(region(params, -1.5, -0.55, deg(12), deg(45), (s,)))
        wins.append(region(params, -0.47, 0.05, deg(12), deg(45), (s,)))
    for w in wins:
        for f in w:
            f.material_index = M['glass']
        inset(bm, w, 0.016, -0.006, M['trim'])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object('cabin', bm, None, sc.SHELL_MATS)


def details(parent):
    b = Builder(['black', 'carbon', 'chrome', 'trim', 'plate', 'housing'])
    b.box('black', (1.3, 0.05, 3.3), at=(0, 0.2, 0))                                 # underbody
    exhausts = []
    for s in (1, -1):                                                                 # twin pipes, one each side
        x = s * 0.55
        b.cyl('chrome', 0.05, 0.045, 0.16, at=(x, 0.3, R - 0.02), rot=(math.pi / 2, 0, 0), seg=20, caps=False)
        b.cyl('black', 0.043, 0.043, 0.01, at=(x, 0.3, R + 0.03), rot=(math.pi / 2, 0, 0), seg=20)
        exhausts.append((x, 0.3, R - 0.1))
        b.box('trim', (0.012, 0.025, 0.14), at=(s * 0.895, 0.86, 0.05), bevel=0.004, seg=1)  # door handle
    b.box('carbon', (1.1, 0.05, 0.25), at=(0, 0.28, R + 0.05), rot=(-0.25, 0, 0))     # rear diffuser
    return b.finish('details', parent), exhausts


def splitter(parent):
    b = Builder(['carbon'])
    b.box('carbon', (1.5, 0.025, 0.14), at=(0, 0.3, F - 0.02), bevel=0.01, seg=1)
    ob = b.finish('splitter', parent)
    ob['part'] = 'splitter'
    return ob


def wing(parent):
    """Roof spoiler over the hatch."""
    b = Builder(['paint', 'black'])
    b.box('paint', (1.36, 0.04, 0.3), at=(0, 1.44, -1.82), rot=(0.12, 0, 0), bevel=0.012, seg=1)
    for s in (1, -1):
        b.box('paint', (0.03, 0.08, 0.26), at=(s * 0.67, 1.41, -1.8))
    ob = b.finish('wing', parent)
    ob['part'] = 'wing'
    return ob


def mirror(parent, s):
    b = Builder(['paint', 'black', 'glass'])
    b.box('black', (0.1, 0.03, 0.05), at=(s * 0.83, 0.97, 0.82), bevel=0.008, seg=1)
    b.sphere('paint', 1, at=(s * 0.92, 1.0, 0.8), scale=(0.1, 0.06, 0.12), seg=20, rings=10)
    b.box('glass', (0.13, 0.07, 0.006), at=(s * 0.925, 1.0, 0.75))
    ob = b.finish('mirrorL' if s > 0 else 'mirrorR', parent)
    ob['part'] = ob.name
    return ob


def plate(parent):
    b = Builder(['plate', 'black'])
    b.box('black', (0.54, 0.13, 0.012), at=(0, 0.58, R - 0.01))
    b.box('plate', (0.52, 0.11, 0.01), at=(0, 0.58, R - 0.018), bevel=0.004, seg=1)
    ob = b.finish('plate', parent)
    ob['part'] = 'plate'
    return ob


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc.materials()
    root = empty('car')
    root['name'] = 'Hot Hatch'
    root['length'] = round(F - R, 3)
    root['width'] = 1.81
    root['wheel'] = {'front': sc.AXLES[0], 'rear': sc.AXLES[1], 'track': sc.TRACK, 'radius': sc.WHEEL_R, 'width': sc.WHEEL_W}
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
        empty('headlight_' + name, root, (s * 0.64, 0.8, 1.93))
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
