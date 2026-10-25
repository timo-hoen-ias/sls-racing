# Builds a generic muscle car (no real make) as an alternative player car: public/models/cars/muscle.glb.
# Long bonnet with a power bulge, short fastback cabin, full-width tail lights, twin pipes each side.
# Same node layout as the sports coupé (make_sportscar.py), so src/vehicle/sportsCarGlb.ts loads it unchanged:
#   car (extras: name, length, width, wheel{front, rear, track, radius, width}), lod0..2, splitter, wing (roof spoiler),
#   mirrorL/R, plate, exhaust_L/R, headlight_L/R, wheel (lod0/1), caliper.
# Longer wheelbase than CAR in src/vehicle/tuning.ts: the extras say where the wheels belong (per-car tuning).
# Run: blender --background --factory-startup --python tools/blender/make_muscle.py -- [out.glb]
import bpy, bmesh, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, Loft, bl, deg, decimate, empty, export, inset, join, mesh_object, region, smooth, tris
import make_sportscar as sc

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'cars', 'muscle.raw.glb')
M = sc.M

F, R = 2.45, -2.32         # front and rear end (m)
AXLES = (1.48, -1.36)      # wheelbase 2.84 m
TRACK = 0.83

# Station: z, half width, bottom, top, dip, n, tumble. Boxy (high n), flat bonnet with a bulge (negative dip).
BODY = [
    (R, 0.62, 0.42, 0.70, 0.00, 3.6, 0.06),
    (R + 0.04, 0.84, 0.32, 0.80, 0.00, 4.4, 0.06),
    (R + 0.12, 0.91, 0.29, 0.85, 0.00, 4.8, 0.06),
    (-2.05, 0.94, 0.26, 0.88, 0.00, 5.0, 0.05),
    (-1.36, 0.97, 0.24, 0.88, 0.00, 5.0, 0.05),
    (-0.40, 0.93, 0.24, 0.84, 0.00, 5.0, 0.05),
    (0.60, 0.93, 0.24, 0.86, -0.03, 5.0, 0.05),
    (1.48, 0.95, 0.25, 0.88, -0.04, 5.0, 0.05),
    (2.10, 0.93, 0.27, 0.86, -0.02, 4.8, 0.05),
    (2.30, 0.91, 0.29, 0.83, 0.00, 4.6, 0.06),
    (2.40, 0.85, 0.32, 0.78, 0.00, 4.2, 0.06),
    (F, 0.62, 0.40, 0.68, 0.00, 3.4, 0.06),
]

CABIN = [
    (-2.10, 0.72, 0.35, 0.89, 0, 3.4, 0.30),
    (-1.55, 0.78, 0.35, 1.10, 0, 3.4, 0.32),
    (-0.90, 0.80, 0.35, 1.27, 0, 3.4, 0.34),
    (-0.20, 0.81, 0.35, 1.30, 0, 3.4, 0.34),
    (0.15, 0.81, 0.35, 1.28, 0, 3.4, 0.34),
    (0.62, 0.79, 0.35, 1.02, 0, 3.4, 0.32),
    (0.92, 0.76, 0.35, 0.88, 0, 3.4, 0.30),
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
    zb = [2.18, 2.30, 2.40, R + 0.04, R + 0.12, 0.82, 0.83, 1.0, 2.1, -2.2, 0.95, 1.10, 0.3, 0.6]
    ab = [deg(x) for x in (-70, -55, -48, -30, -12, -6, 6, 14, 20, 28, 34, 54, 80, 84, 86)]
    L = Loft(BODY, 120, 32, zb, ab)
    params, caps = L.build(bm)
    caps[0].material_index = M['black']
    caps[1].material_index = M['black']

    def paint(name, faces):
        for f in faces:
            f.material_index = M[name]

    paint('black', region(params, R - 1, F + 1, -math.pi, deg(-70)))
    paint('trim', region(params, R - 1, F + 1, deg(-70), deg(-55)))                 # sills
    for s_ in (1, -1):
        h = region(params, 2.30, F + 1, deg(6), deg(28), (s_,))                       # round twin headlights in the grille
        paint('housing', h)
        paint('head', region(params, 2.30, F + 1, deg(14), deg(20), (s_,)))
        inset(bm, h, 0.01, -0.012, M['trim'])
        paint('indicator', region(params, 2.30, F + 1, deg(-12), deg(-6), (s_,)))
        sv = region(params, 0.95, 1.10, deg(-30), deg(-12), (s_,))                   # side gills behind the front wheel
        paint('black', sv)
        inset(bm, sv, 0.008, -0.015, M['trim'])
    paint('brake', region(params, R - 1, R + 0.12, deg(6), deg(34)))                 # full-width tail light bar
    paint('trim', region(params, R - 1, R + 0.12, deg(14), deg(20)))
    g = region(params, 2.40, F + 1, deg(-30), deg(34))                                # wide grille between the lamps
    for f in g:
        if f.material_index == M['paint']:
            f.material_index = M['black']
    paint('black', region(params, R - 1, -2.2, deg(-48), deg(-12)))                  # rear valance
    paint('seam', region(params, 0.82, 0.83, deg(-55), deg(54)))                     # door shut line
    paint('seam', region(params, 0.3, 0.6, deg(80), deg(84)))                        # boot-lid line
    paint('seam', region(params, 1.0, 2.1, deg(84), deg(86)))                        # bonnet shut lines
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = mesh_object('body', bm, None, sc.SHELL_MATS)
    cut_arches(ob)
    return ob


def cabin_shell():
    bm = bmesh.new()
    zb = [0.18, 0.88, -2.0, -0.95, -0.85, 0.12, -1.40, -1.0]
    ab = [deg(x) for x in (12, 40, 45)]
    L = Loft(CABIN, 60, 20, zb, ab)
    params, caps = L.build(bm)
    for f in caps:
        f.material_index = M['paint']
    wins = [region(params, 0.18, 0.88, deg(45), math.pi), region(params, -2.0, -0.95, deg(45), math.pi)]
    for s_ in (1, -1):
        wins.append(region(params, -0.85, 0.12, deg(12), deg(40), (s_,)))          # door glass
        wins.append(region(params, -1.40, -1.0, deg(12), deg(40), (s_,)))          # quarter window
    for w in wins:
        for f in w:
            f.material_index = M['glass']
        inset(bm, w, 0.016, -0.006, M['trim'])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    return mesh_object('cabin', bm, None, sc.SHELL_MATS)


def details(parent):
    b = Builder(['black', 'carbon', 'chrome', 'trim', 'plate', 'housing'])
    b.box('black', (1.4, 0.05, 4.0), at=(0, 0.2, 0))                                 # underbody
    b.box('black', (0.7, 0.06, 0.9), at=(0, 0.9, 1.55), bevel=0.03, seg=2)           # bonnet scoop
    b.box('black', (0.5, 0.05, 0.05), at=(0, 0.93, 1.98))                             # scoop mouth
    b.box('chrome', (1.78, 0.06, 0.06), at=(0, 0.36, F - 0.02), bevel=0.02, seg=2)   # front bumper bar
    b.box('chrome', (1.74, 0.06, 0.06), at=(0, 0.42, R - 0.01), bevel=0.02, seg=2)   # rear bumper bar
    exhausts = []
    for s_ in (1, -1):                                                                # twin pipes each side
        for dx in (0.0, 0.12):
            x = s_ * (0.55 + dx)
            b.cyl('chrome', 0.048, 0.045, 0.18, at=(x, 0.27, R - 0.02), rot=(math.pi / 2, 0, 0), seg=20, caps=False)
            b.cyl('black', 0.041, 0.041, 0.01, at=(x, 0.27, R + 0.04), rot=(math.pi / 2, 0, 0), seg=20)
        exhausts.append((s_ * 0.61, 0.27, R - 0.1))
        b.box('chrome', (0.012, 0.03, 0.16), at=(s_ * 0.945, 0.76, 0.55), bevel=0.004, seg=1)  # door handle
    return b.finish('details', parent), exhausts


def splitter(parent):
    b = Builder(['black'])
    b.box('black', (1.6, 0.03, 0.16), at=(0, 0.28, F - 0.08), bevel=0.01, seg=1)
    ob = b.finish('splitter', parent)
    ob['part'] = 'splitter'
    return ob


def wing(parent):
    """Raised boot spoiler on two posts."""
    b = Builder(['paint', 'black'])
    b.box('paint', (1.5, 0.04, 0.22), at=(0, 1.0, R + 0.2), rot=(0.12, 0, 0), bevel=0.012, seg=1)
    for s_ in (1, -1):
        b.box('black', (0.04, 0.14, 0.12), at=(s_ * 0.6, 0.93, R + 0.22))
    ob = b.finish('wing', parent)
    ob['part'] = 'wing'
    return ob


def mirror(parent, s_):
    b = Builder(['paint', 'black', 'glass'])
    b.box('black', (0.1, 0.03, 0.05), at=(s_ * 0.86, 0.9, 0.78), bevel=0.008, seg=1)
    b.sphere('paint', 1, at=(s_ * 0.95, 0.92, 0.76), scale=(0.1, 0.055, 0.12), seg=20, rings=10)
    b.box('glass', (0.13, 0.065, 0.006), at=(s_ * 0.955, 0.92, 0.71))
    ob = b.finish('mirrorL' if s_ > 0 else 'mirrorR', parent)
    ob['part'] = ob.name
    return ob


def plate(parent):
    b = Builder(['plate', 'black'])
    b.box('black', (0.54, 0.13, 0.012), at=(0, 0.6, R - 0.005))
    b.box('plate', (0.52, 0.11, 0.01), at=(0, 0.6, R - 0.013), bevel=0.004, seg=1)
    ob = b.finish('plate', parent)
    ob['part'] = 'plate'
    return ob


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    sc.materials()
    root = empty('car')
    root['name'] = 'Muscle'
    root['length'] = round(F - R, 3)
    root['width'] = 1.95
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
        empty('headlight_' + name, root, (s * 0.72, 0.62, F - 0.05))
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
