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

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import (MATS, Builder, Loft, apply_mods, bl, deg, decimate, empty, export, inset, join, mesh_object, monotone,
                    pbr, region, sel, smooth, spow, srgb, tris)

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



if __name__ == '__main__':
    export(build(), OUT)
