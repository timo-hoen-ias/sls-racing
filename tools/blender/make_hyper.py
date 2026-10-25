# Builds a generic mid-engined hypercar (no real make) as an alternative player car: public/models/cars/hyper.glb.
# Low wedge nose, cab-forward canopy, big side intakes, louvred engine cover and a tall rear wing.
# Same node layout as the sports coupé (make_sportscar.py), so src/vehicle/sportsCarGlb.ts loads it unchanged:
#   car (extras: name, length, width, wheel{front, rear, track, radius, width}), lod0..2, splitter, wing (roof spoiler),
#   mirrorL/R, plate, exhaust_L/R, headlight_L/R, wheel (lod0/1), caliper.
# Longer wheelbase than CAR in src/vehicle/tuning.ts: the extras say where the wheels belong (per-car tuning).
# Run: blender --background --factory-startup --python tools/blender/make_hyper.py -- [out.glb]
import bpy, bmesh, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, Loft, bl, deg, decimate, empty, export, inset, join, mesh_object, region, smooth, tris
import make_sportscar as sc

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'cars', 'hyper.raw.glb')
M = sc.M

F, R = 2.30, -2.36         # front and rear end (m)
AXLES = (1.36, -1.40)      # wheelbase 2.76 m
TRACK = 0.86

# Station: z, half width, bottom, top, dip, n, tumble. Wide hips over the rear wheels, nose low.
BODY = [
    (R, 0.70, 0.36, 0.66, 0.00, 3.0, 0.10),
    (R + 0.05, 0.92, 0.28, 0.80, 0.00, 3.6, 0.10),
    (-2.00, 1.00, 0.24, 0.86, 0.00, 3.8, 0.12),
    (-1.40, 1.03, 0.22, 0.90, 0.04, 4.0, 0.08),
    (-0.70, 0.96, 0.21, 0.80, 0.03, 3.6, 0.14),
    (0.20, 0.92, 0.21, 0.74, 0.08, 3.4, 0.14),
    (1.36, 0.99, 0.22, 0.90, 0.26, 4.0, 0.06),
    (1.90, 0.93, 0.23, 0.72, 0.18, 3.4, 0.10),
    (2.20, 0.80, 0.25, 0.48, 0.04, 2.8, 0.14),
    (F, 0.60, 0.30, 0.40, 0.00, 2.4, 0.12),
]

CABIN = [
    (-1.95, 0.56, 0.35, 0.86, 0, 2.6, 0.30),
    (-1.10, 0.66, 0.35, 1.02, 0, 2.8, 0.34),
    (-0.50, 0.74, 0.35, 1.12, 0, 3.0, 0.38),
    (0.10, 0.76, 0.35, 1.13, 0, 3.0, 0.40),
    (0.60, 0.74, 0.35, 0.98, 0, 3.0, 0.38),
    (1.05, 0.70, 0.35, 0.78, 0, 2.8, 0.34),
    (1.25, 0.66, 0.35, 0.70, 0, 2.6, 0.30),
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
    zb = [1.85, 2.15, R + 0.05, R + 0.14, -0.95, -0.35, -0.10, -0.09, 1.0, 2.0, -2.25]
    ab = [deg(x) for x in (-70, -55, -48, -30, -12, -4, 10, 18, 24, 32, 40, 52, 84, 86)]
    L = Loft(BODY, 120, 32, zb, ab)
    params, caps = L.build(bm)
    caps[0].material_index = M['black']
    caps[1].material_index = M['black']

    def paint(name, faces):
        for f in faces:
            f.material_index = M[name]

    paint('black', region(params, R - 1, F + 1, -math.pi, deg(-70)))
    paint('carbon', region(params, R - 1, F + 1, deg(-70), deg(-48)))                # carbon sills
    for s_ in (1, -1):
        h = region(params, 1.85, 2.15, deg(18), deg(40), (s_,))                       # narrow swept headlights
        paint('housing', h)
        paint('head', region(params, 1.85, 2.15, deg(24), deg(32), (s_,)))
        inset(bm, h, 0.008, -0.004, M['trim'])
        si = region(params, -0.95, -0.35, deg(-30), deg(18), (s_,))                  # big side intake ahead of the rear wheel
        paint('black', si)
        inset(bm, si, 0.015, -0.06, M['carbon'])
        paint('brake', region(params, R - 1, R + 0.14, deg(18), deg(32), (s_,)))     # slim tail lights
    fi = region(params, 2.15, F + 1, deg(-30), deg(10))                               # front intake
    paint('black', fi)
    inset(bm, fi, 0.012, -0.03, M['carbon'])
    paint('black', region(params, R - 1, R + 0.05, deg(-48), deg(10)))                # open rear with the diffuser
    paint('seam', region(params, -0.10, -0.09, deg(-48), deg(52)))                   # door shut line
    paint('seam', region(params, 1.0, 2.0, deg(84), deg(86)))                         # frunk shut lines
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_object('body', bm, None, sc.SHELL_MATS)
    cut_arches(ob)
    return ob


def cabin_shell():
    bm = bmesh.new()
    zb = [0.35, 1.20, -1.85, -0.75, -0.62, 0.30, -1.05, -0.70]
    ab = [deg(x) for x in (12, 40, 45)]
    L = Loft(CABIN, 60, 20, zb, ab)
    params, caps = L.build(bm)
    for f in caps:
        f.material_index = M['paint']
    wins = [region(params, 0.35, 1.20, deg(45), math.pi)]
    for s_ in (1, -1):
        wins.append(region(params, -0.62, 0.30, deg(12), deg(40), (s_,)))          # door glass
    for w in [region(params, -1.85, -0.75, deg(45), math.pi)]:                      # louvred engine cover
        for f in w:
            f.material_index = M['black']
        inset(bm, w, 0.02, -0.01, M['carbon'])
    for w in wins:
        for f in w:
            f.material_index = M['glass']
        inset(bm, w, 0.016, -0.006, M['trim'])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object('cabin', bm, None, sc.SHELL_MATS)


def details(parent):
    b = Builder(['black', 'carbon', 'chrome', 'trim', 'plate', 'housing'])
    b.box('black', (1.5, 0.05, 4.0), at=(0, 0.18, 0))                                # underbody
    b.box('carbon', (1.6, 0.03, 0.5), at=(0, 0.22, R + 0.32), rot=(-0.22, 0, 0))     # diffuser
    for i in range(-3, 4):
        b.box('carbon', (0.012, 0.14, 0.45), at=(i * 0.22, 0.26, R + 0.32))
    exhausts = []
    for s_ in (1, -1):                                                                # two big centre pipes up high
        x = s_ * 0.16
        b.cyl('chrome', 0.065, 0.06, 0.16, at=(x, 0.56, R - 0.0), rot=(math.pi / 2, 0, 0), seg=24, caps=False)
        b.cyl('black', 0.058, 0.058, 0.01, at=(x, 0.56, R + 0.05), rot=(math.pi / 2, 0, 0), seg=24)
        exhausts.append((x, 0.56, R - 0.08))
    return b.finish('details', parent), exhausts


def splitter(parent):
    b = Builder(['carbon'])
    b.box('carbon', (1.7, 0.025, 0.3), at=(0, 0.25, F - 0.1), bevel=0.01, seg=1)
    for s_ in (1, -1):
        b.box('carbon', (0.012, 0.1, 0.3), at=(s_ * 0.84, 0.3, F - 0.12))
    ob = b.finish('splitter', parent)
    ob['part'] = 'splitter'
    return ob


def wing(parent):
    """Tall rear wing on swan-neck struts, with end plates."""
    b = Builder(['carbon'])
    b.box('carbon', (1.7, 0.035, 0.34), at=(0, 1.12, R + 0.36), rot=(-0.12, 0, 0), bevel=0.012, seg=1)
    for s_ in (1, -1):
        b.box('carbon', (0.012, 0.14, 0.38), at=(s_ * 0.855, 1.1, R + 0.36), bevel=0.004, seg=1)
        b.box('carbon', (0.03, 0.3, 0.08), at=(s_ * 0.38, 0.95, R + 0.42), rot=(0.2, 0, 0), bevel=0.006, seg=1)
    ob = b.finish('wing', parent)
    ob['part'] = 'wing'
    return ob


def mirror(parent, s_):
    b = Builder(['paint', 'black', 'glass'])
    b.box('black', (0.12, 0.03, 0.05), at=(s_ * 0.86, 0.8, 0.62), bevel=0.008, seg=1)
    b.sphere('paint', 1, at=(s_ * 0.97, 0.82, 0.6), scale=(0.1, 0.05, 0.12), seg=20, rings=10)
    b.box('glass', (0.13, 0.06, 0.006), at=(s_ * 0.975, 0.82, 0.55))
    ob = b.finish('mirrorL' if s_ > 0 else 'mirrorR', parent)
    ob['part'] = ob.name
    return ob


def plate(parent):
    b = Builder(['plate', 'black'])
    b.box('black', (0.54, 0.13, 0.012), at=(0, 0.42, R + 0.02))
    b.box('plate', (0.52, 0.11, 0.01), at=(0, 0.42, R + 0.012), bevel=0.004, seg=1)
    ob = b.finish('plate', parent)
    ob['part'] = 'plate'
    return ob


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc.materials()
    root = empty('car')
    root['name'] = 'Hyper'
    root['length'] = round(F - R, 3)
    root['width'] = 2.04
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
        empty('headlight_' + name, root, (s * 0.72, 0.5, 2.0))
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
