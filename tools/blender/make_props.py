# Builds street furniture, traffic lights, traffic signs and pedestrians for instancing; exports public/models/props.glb.
# Run: blender --background --factory-startup --python tools/blender/make_props.py -- [out.glb]
# Then compress: npm run models:build (see package.json).
#
# Model space (as src/world/propModels.ts): ground at y = 0, +z is the side the prop faces (sign faces, bench
# seats, shelter openings), +x to the right when looking at that face. Linear props are 1 m long along z.
# Meshes:
#   <prop>_lod0 / <prop>_lod1        vertex-coloured, names as PROP_NAMES in src/world/propKinds.ts
#   ampel_lod0/1 + ampel_lamp_red|yellow|green   lamps white (tinted per instance), as in signalView
#   schild_mast_lod0/1 + schild-<typ>_face        faces carry uv into the sign atlas embedded in the GLB
#   fussgaenger-<n>_torso|head|leg|arm           parts with the pivots of src/peds/pedView.ts
# No brands or logos. Sign faces follow the German StVO designs (drawn here, no external artwork).
import bpy, bmesh, math, os, sys
from mathutils import Matrix, Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, bl, export, srgb, tris

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'props.raw.glb')
TMP = os.path.join(os.path.dirname(OUT), '.props-bake')

PAL = {
    'pole': 0x8f969c, 'galv': 0xb4b9bd, 'anthracite': 0x2f3236, 'black': 0x141516, 'wood': 0x7a5232,
    'concrete': 0xa9a59c, 'concrete.dark': 0x86827a, 'white': 0xf2f2ee, 'red': 0xc8202a, 'yellow': 0xf4c400,
    'green': 0x1f7a3a, 'bin': 0x2f4a3a, 'glass': 0x9fb8c4, 'sandstone': 0xb9a58a, 'post': 0xf2c200,
    'poster1': 0xd8553a, 'poster2': 0x3a76b8, 'poster3': 0xe8d25a, 'poster4': 0x5a9a4a, 'lamp': 0xffffff,
    'skin1': 0xe0b294, 'skin2': 0xb98563, 'skin3': 0x8a5a3c, 'hair1': 0x3a2a1e, 'hair2': 0x8a6a3a, 'hair3': 0xb0b0ae,
    'jeans': 0x3b4a66, 'chino': 0x9a8a6a, 'darkgrey': 0x3e4044, 'jacket1': 0x5a6a4a, 'jacket2': 0x8a2a2a,
    'coat': 0x6a5a48, 'hoodie': 0x3a5a8a, 'shirt': 0xd8d6cc, 'skirt': 0x4a3a5a, 'shoe': 0x1c1a18, 'sneaker': 0xe8e8e2,
    'backpack': 0x2a5a4a,
}
COLORS = list(PAL)


def mat(name):
    m = bpy.data.materials.get(name)
    if m:
        return m
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    return m


def finish(b, name, parent):
    """Builder -> object with the material colours baked into a vertex colour attribute and one material."""
    for c in b.mats:
        if c not in bpy.data.materials:
            m = bpy.data.materials.new(c)
            m.diffuse_color = srgb(PAL[c])
    from carlib import MATS
    for c in b.mats:
        MATS[c] = bpy.data.materials[c]
    ob = b.finish(name, parent)
    me = ob.data
    bm = bmesh.new()
    bm.from_mesh(me)
    lay = bm.loops.layers.float_color.new('Color')
    names = [m.name for m in me.materials]
    for f in bm.faces:
        col = srgb(PAL[names[f.material_index]])
        for l in f.loops:
            l[lay] = col
        f.material_index = 0
    bm.to_mesh(me)
    bm.free()
    me.materials.clear()
    me.materials.append(mat('props'))
    me.color_attributes.active_color = me.color_attributes['Color']
    me.color_attributes.render_color_index = 0
    for p in me.polygons:
        p.use_smooth = False
    return ob


def B():
    return Builder(COLORS)


def cyl(b, c, r, h, x=0, y=0, z=0, seg=10, r2=None):
    """Vertical cylinder from y to y + h."""
    b.cyl(c, r, r if r2 is None else r2, h, at=(x, y + h / 2, z), seg=seg)


LAMPS = {'red': 3.15, 'yellow': 2.85, 'green': 2.55}


# ---------------------------------------------------------------- furniture

def bank(lod):
    b = B()
    for x in (-0.75, 0.75):
        b.box('concrete' if lod else 'anthracite', (0.08, 0.42, 0.5), at=(x, 0.21, 0.0))
        if lod == 0:
            b.box('anthracite', (0.06, 0.5, 0.06), at=(x, 0.65, -0.24), rot=(-0.2, 0, 0))
    n = 4 if lod == 0 else 1
    for i in range(n):
        z = -0.18 + i * 0.12 if lod == 0 else 0
        b.box('wood', (1.8, 0.04, 0.1 if lod == 0 else 0.48), at=(0, 0.44, z))
    for i in range(3 if lod == 0 else 1):
        b.box('wood', (1.8, 0.1 if lod == 0 else 0.35, 0.035), at=(0, 0.58 + i * 0.13 if lod == 0 else 0.7, -0.27 - i * 0.025), rot=(-0.2, 0, 0))
    return b


def muelleimer(lod):
    b = B()
    seg = 12 if lod == 0 else 6
    cyl(b, 'pole', 0.035, 1.0, z=-0.05, seg=6)
    cyl(b, 'bin', 0.2, 0.62, y=0.35, z=0.18, seg=seg)
    if lod == 0:
        cyl(b, 'black', 0.205, 0.04, y=0.97, z=0.18, seg=seg)
        cyl(b, 'black', 0.15, 0.01, y=1.0, z=0.18, seg=seg)
    return b


def poller(lod):
    b = B()
    cyl(b, 'anthracite', 0.08, 0.9, seg=10 if lod == 0 else 6)
    if lod == 0:
        cyl(b, 'white', 0.083, 0.06, y=0.7, seg=10)
        b.sphere('anthracite', 0.08, at=(0, 0.9, 0), seg=10, rings=5, scale=(1, 0.5, 1))
    return b


def betonblock(lod):
    b = B()
    b.box('concrete', (0.6, 0.6, 1.2), at=(0, 0.3, 0), bevel=0.04 if lod == 0 else 0, seg=1)
    return b


def hydrant(lod):
    b = B()
    seg = 10 if lod == 0 else 6
    cyl(b, 'red', 0.11, 0.75, seg=seg)
    cyl(b, 'white', 0.12, 0.12, y=0.75, seg=seg, r2=0.06)
    if lod == 0:
        for x in (-0.13, 0.13):
            b.cyl('red', 0.045, 0.045, 0.08, at=(x, 0.5, 0), rot=(0, 0, math.pi / 2), seg=8)
        cyl(b, 'red', 0.13, 0.05, y=0.05, seg=seg)
    return b


def briefkasten(lod):
    b = B()
    cyl(b, 'pole', 0.035, 0.9, z=-0.05, seg=6)
    b.box('post', (0.42, 0.55, 0.3), at=(0, 1.05, 0.05), bevel=0.02 if lod == 0 else 0, seg=1)
    if lod == 0:
        b.box('post', (0.44, 0.06, 0.33), at=(0, 1.35, 0.05))
        b.box('black', (0.24, 0.02, 0.01), at=(0, 1.2, 0.205))                   # slot
    return b


def fahrradstaender(lod):
    b = B()
    if lod == 0:
        # Anlehnbügel: inverted U of galvanised tube along z.
        pts = []
        for i in range(9):
            a = math.pi * i / 8
            pts.append((0.0, 0.25 + 0.55 * math.sin(a) + 0.2, -0.4 * math.cos(a)))
        for p0, p1 in zip(pts, pts[1:]):
            mid = [(u + v) / 2 for u, v in zip(p0, p1)]
            d = Vector(p1) - Vector(p0)
            ang = math.atan2(d.z, d.y)
            b.cyl('galv', 0.03, 0.03, d.length + 0.01, at=mid, rot=(ang, 0, 0), seg=6)
        for z in (-0.4, 0.4):
            b.cyl('galv', 0.03, 0.03, 0.45, at=(0, 0.225, z), seg=6)
    else:
        b.box('galv', (0.06, 1.0, 0.86), at=(0, 0.5, 0))
    return b


def litfasssaeule(lod):
    b = B()
    seg = 16 if lod == 0 else 8
    cyl(b, 'concrete.dark', 0.62, 0.3, seg=seg)
    cyl(b, 'white', 0.58, 2.6, y=0.3, seg=seg)
    if lod == 0:
        for i, c in enumerate(('poster1', 'poster2', 'poster3', 'poster4')):
            a = i * math.pi / 2
            b.box(c, (0.75, 1.9, 0.02), at=(math.sin(a) * 0.585, 1.45, math.cos(a) * 0.585), rot=(0, a, 0))
    cyl(b, 'green', 0.7, 0.18, y=2.9, seg=seg)
    cyl(b, 'green', 0.55, 0.45, y=3.08, seg=seg, r2=0.05)
    return b


def container(lod):
    b = B()
    b.box('green', (1.4, 1.5, 1.4), at=(0, 0.75, 0), bevel=0.12 if lod == 0 else 0, seg=2)
    if lod == 0:
        cyl(b, 'black', 0.12, 0.05, y=1.5, seg=8)
        b.box('black', (0.3, 0.3, 0.01), at=(0, 1.1, 0.705))
    return b


def bushaltestelle(lod):
    b = B()
    cyl(b, 'pole', 0.04, 2.6, z=-0.03, seg=6)
    # Round sign: green H in a yellow disc (both sides).
    for s in (1, -1):
        b.cyl('yellow', 0.22, 0.22, 0.02, at=(0, 2.35, 0.01 * s), rot=(math.pi / 2, 0, 0), seg=20 if lod == 0 else 8)
    if lod == 0:
        for s in (1, -1):
            z = 0.025 * s
            b.box('green', (0.05, 0.22, 0.01), at=(-0.07, 2.35, z))
            b.box('green', (0.05, 0.22, 0.01), at=(0.07, 2.35, z))
            b.box('green', (0.14, 0.045, 0.01), at=(0, 2.35, z))
        b.box('white', (0.32, 0.45, 0.06), at=(0, 1.45, 0.03))              # timetable box
    return b


def bushaltestelle_dach(lod):
    b = B()
    b.box('anthracite', (3.2, 0.08, 1.6), at=(0, 2.45, -0.9))
    if lod == 0:
        b.box('glass', (3.2, 1.9, 0.03), at=(0, 1.25, -1.65))
        for x in (-1.58, 1.58):
            b.box('glass', (0.03, 1.9, 1.3), at=(x, 1.25, -0.98))
            b.box('anthracite', (0.08, 2.4, 0.08), at=(x, 1.2, -0.25))
            b.box('anthracite', (0.08, 2.4, 0.08), at=(x, 1.2, -1.65))
        b.box('anthracite', (3.2, 0.08, 0.08), at=(0, 0.25, -1.65))
        b.box('poster2', (1.2, 1.7, 0.04), at=(1.0, 1.25, -1.62))          # advertising panel (blank)
        b.box('wood', (2.0, 0.05, 0.4), at=(-0.4, 0.48, -1.4))
        b.box('anthracite', (0.06, 0.45, 0.06), at=(-1.3, 0.24, -1.4))
        b.box('anthracite', (0.06, 0.45, 0.06), at=(0.5, 0.24, -1.4))
    else:
        b.box('glass', (3.2, 2.3, 0.05), at=(0, 1.2, -1.65))
        for x in (-1.58, 1.58):
            b.box('glass', (0.05, 2.3, 1.4), at=(x, 1.2, -0.95))
    return b


def zaun(lod):
    b = B()
    b.box('anthracite', (0.04, 0.04, 1.0), at=(0, 1.0, 0))
    b.box('anthracite', (0.04, 0.04, 1.0), at=(0, 0.15, 0))
    if lod == 0:
        for i in range(8):
            b.box('anthracite', (0.02, 0.88, 0.02), at=(0, 0.58, -0.4375 + i * 0.125))
    else:
        b.box('anthracite', (0.02, 0.85, 1.0), at=(0, 0.58, 0))
    b.box('anthracite', (0.06, 1.05, 0.06), at=(0, 0.52, -0.5))
    return b


def mauer(lod):
    b = B()
    b.box('sandstone', (0.4, 1.2, 1.0), at=(0, 0.6, 0))
    b.box('concrete', (0.48, 0.08, 1.0), at=(0, 1.24, 0))
    return b


def leitplanke(lod):
    b = B()
    b.box('galv', (0.1, 0.18 if lod else 0.3, 0.06), at=(0, 0.6, -0.5))
    if lod == 0:
        for y in (0.5, 0.6, 0.7):
            b.box('galv', (0.03, 0.09, 1.0), at=(0.1 + (0.02 if y == 0.6 else 0), y, 0))
        b.box('galv', (0.08, 0.75, 0.1), at=(0, 0.375, -0.5))
    else:
        b.box('galv', (0.05, 0.3, 1.0), at=(0.1, 0.6, 0))
    return b


def ampel(lod):
    """Traffic light: pole behind the housing (z -0.2), back plate (z -0.14), housing centred at (0, 2.85, 0)
    0.34 x 1.0 x 0.26 with a visor over each lamp; the lamps themselves are separate meshes (see LAMPS)."""
    b = B()
    cyl(b, 'pole', 0.06, 3.5, z=-0.2, seg=8 if lod == 0 else 5)
    b.box('black', (0.34, 1.0, 0.26), at=(0, 2.85, 0), bevel=0.03 if lod == 0 else 0, seg=1)
    b.box('black', (0.5, 1.14, 0.03), at=(0, 2.85, -0.14))
    if lod == 0:
        for y in LAMPS.values():
            b.box('black', (0.26, 0.025, 0.16), at=(0, y + 0.13, 0.21))       # visor
            b.box('black', (0.025, 0.12, 0.14), at=(-0.12, y + 0.07, 0.2))
            b.box('black', (0.025, 0.12, 0.14), at=(0.12, y + 0.07, 0.2))
        b.box('white', (0.5, 0.05, 0.035), at=(0, 2.3, -0.14))              # reflective strip
    return b




def lamp(y):
    b = B()
    b.cyl('lamp', 0.1, 0.1, 0.04, at=(0, y, 0.14), rot=(math.pi / 2, 0, 0), seg=14)
    return b


def schild_mast(lod):
    b = B()
    cyl(b, 'galv', 0.03, 2.65 if lod == 0 else 2.6, z=-0.05, seg=8 if lod == 0 else 5)
    if lod == 0:
        cyl(b, 'galv', 0.035, 0.04, y=2.65, z=-0.05, seg=8)
    return b


# ---------------------------------------------------------------- signs (atlas)

SIGNS = [
    # id, outline kind, size (m)
    ('vorfahrtstrasse', 'diamond', 0.6),
    ('vorfahrt', 'triangle', 0.9),
    ('vorfahrt-achten', 'triangle_down', 0.9),
    ('stop', 'octagon', 0.6),
    ('einfahrt-verboten', 'circle', 0.6),
    ('tempo-30', 'circle', 0.6),
    ('tempo-50', 'circle', 0.6),
    ('tempo-70', 'circle', 0.6),
    ('tempo-100', 'circle', 0.6),
    ('ortsschild', 'rect', (1.0, 0.5)),
    ('zusatz', 'rect', (0.6, 0.3)),
    ('fussgaenger', 'square', 0.6),
]
CELL = 256
ATLAS_W, ATLAS_H = 1024, 768


def outline(kind, n=32):
    """Unit outline (-1..1) of a sign shape, counter-clockwise."""
    if kind == 'circle':
        return [(math.cos(2 * math.pi * i / n), math.sin(2 * math.pi * i / n)) for i in range(n)]
    if kind == 'octagon':
        return [(math.cos(math.pi / 8 + 2 * math.pi * i / 8), math.sin(math.pi / 8 + 2 * math.pi * i / 8)) for i in range(8)]
    if kind == 'diamond':
        return [(0, -1), (1, 0), (0, 1), (-1, 0)]
    if kind == 'triangle':
        return [(-1, -0.75), (1, -0.75), (0, 1)]
    if kind == 'triangle_down':
        return [(-1, 0.75), (0, -1), (1, 0.75)]
    if kind in ('rect', 'square'):
        return [(-1, -1), (1, -1), (1, 1), (-1, 1)]


def draw_atlas(path):
    from PIL import Image, ImageDraw, ImageFont
    font_path = '/usr/share/fonts/TTF/DejaVuSansCondensed-Bold.ttf'
    def font(px):
        try:
            return ImageFont.truetype(font_path, px)
        except OSError:
            return ImageFont.load_default()
    img = Image.new('RGBA', (ATLAS_W, ATLAS_H), (120, 124, 128, 255))   # grey: backs and edges
    cells = {}
    RED, WHITE, BLACK, YELLOW = (200, 32, 42), (245, 245, 240), (20, 20, 20), (244, 196, 0)
    for k, (sid, kind, size) in enumerate(SIGNS):
        cx, cy = (k % 4) * CELL, (k // 4) * CELL
        d = ImageDraw.Draw(img)
        c = (cx + CELL / 2, cy + CELL / 2)
        r = CELL / 2 - 4
        pts = lambda s, rr=r, kind=kind: [(c[0] + x * rr * s[0], c[1] - y * rr * s[1]) for x, y in outline(kind)]
        if sid == 'zusatz':
            d.rectangle([cx + 4, cy + CELL / 4 + 4, cx + CELL - 4, cy + 3 * CELL / 4 - 4], fill=WHITE, outline=BLACK, width=6)
        elif sid == 'fussgaenger':
            BLUE = (0, 92, 170)
            d.rectangle([cx + 4, cy + 4, cx + CELL - 4, cy + CELL - 4], fill=WHITE)
            d.rectangle([cx + 12, cy + 12, cx + CELL - 12, cy + CELL - 12], fill=BLUE)
            d.polygon([(c[0], cy + 34), (cx + CELL - 34, cy + CELL - 44), (cx + 34, cy + CELL - 44)], fill=WHITE)
            # Pedestrian on a zebra crossing, walking right.
            for i in range(4):
                d.rectangle([c[0] - 60 + i * 32, cy + CELL - 70, c[0] - 46 + i * 32, cy + CELL - 54], fill=BLACK)
            d.ellipse([c[0] - 8, c[1] - 48, c[0] + 12, c[1] - 28], fill=BLACK)
            d.line([(c[0] + 2, c[1] - 26), (c[0] - 4, c[1] + 12)], fill=BLACK, width=12)
            d.line([(c[0] - 4, c[1] + 10), (c[0] - 22, c[1] + 42)], fill=BLACK, width=10)
            d.line([(c[0] - 4, c[1] + 10), (c[0] + 18, c[1] + 40)], fill=BLACK, width=10)
            d.line([(c[0] + 0, c[1] - 16), (c[0] + 22, c[1] + 2)], fill=BLACK, width=8)
            d.line([(c[0] + 0, c[1] - 16), (c[0] - 20, c[1] - 2)], fill=BLACK, width=8)
        elif kind == 'rect':
            d.rectangle([cx + 4, cy + CELL / 4 + 4, cx + CELL - 4, cy + 3 * CELL / 4 - 4], fill=YELLOW, outline=BLACK, width=6)
            t = 'Saarlouis'
            f = font(44)
            w = d.textlength(t, font=f)
            d.text((c[0] - w / 2, c[1] - 26), t, fill=BLACK, font=f)
        elif sid == 'vorfahrtstrasse':
            d.polygon(pts((1, 1)), fill=WHITE)
            d.polygon(pts((0.93, 0.93)), fill=BLACK)
            d.polygon(pts((0.88, 0.88)), fill=WHITE)
            d.polygon(pts((0.62, 0.62)), fill=YELLOW)
        elif kind in ('triangle', 'triangle_down'):
            d.polygon(pts((1, 1)), fill=RED)
            d.polygon(pts((0.68, 0.68)), fill=WHITE)
            if sid == 'vorfahrt':
                d.rectangle([c[0] - 9, c[1] - 52, c[0] + 9, c[1] + 50], fill=BLACK)
                d.rectangle([c[0] - 30, c[1] - 8, c[0] + 30, c[1] + 8], fill=BLACK)
        elif sid == 'stop':
            d.polygon(pts((1, 1)), fill=WHITE)
            d.polygon(pts((0.92, 0.92)), fill=RED)
            f = font(64)
            w = d.textlength('STOP', font=f)
            d.text((c[0] - w / 2, c[1] - 40), 'STOP', fill=WHITE, font=f)
        elif sid == 'einfahrt-verboten':
            d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=RED)
            d.rectangle([c[0] - r * 0.72, c[1] - r * 0.17, c[0] + r * 0.72, c[1] + r * 0.17], fill=WHITE)
        else:  # speed limit
            d.ellipse([c[0] - r, c[1] - r, c[0] + r, c[1] + r], fill=RED)
            d.ellipse([c[0] - r * 0.8, c[1] - r * 0.8, c[0] + r * 0.8, c[1] + r * 0.8], fill=WHITE)
            t = sid.split('-')[1]
            f = font(110 if len(t) < 3 else 84)
            w = d.textlength(t, font=f)
            d.text((c[0] - w / 2, c[1] - (68 if len(t) < 3 else 52)), t, fill=BLACK, font=f)
        cells[sid] = (cx, cy)
    img.save(path)
    return cells


def sign_face(sid, kind, size, cell, parent):
    """Plate 2 cm thick at y = 2.3, front (+z) mapped to its atlas cell, back and edges to the grey area."""
    sx, sy = (size, size) if not isinstance(size, tuple) else size
    if kind == 'rect':
        sy = sx * 0.5
    poly = outline(kind)
    if kind in ('circle', 'octagon', 'diamond', 'triangle', 'triangle_down', 'square'):
        hx, hy = sx / 2, sx / 2
    else:
        hx, hy = sx / 2, sy / 2
    yc = {'rect': 2.2}.get(kind, 2.3) if sid != 'zusatz' else 1.88
    bm = bmesh.new()
    uv = bm.loops.layers.uv.new('UVMap')
    front = [bm.verts.new(bl(x * hx, yc + y * hy, 0.0)) for x, y in poly]
    back = [bm.verts.new(bl(x * hx, yc + y * hy, -0.02)) for x, y in poly]
    cx, cy = cell
    grey = ((ATLAS_W - 8) / ATLAS_W, 4 / ATLAS_H)
    ff = bm.faces.new(front)
    rect_k = (0.5 if kind == 'rect' else 1.0)
    for l, (x, y) in zip(ff.loops, poly):
        u = (cx + CELL / 2 + x * (CELL / 2 - 4)) / ATLAS_W
        v = (cy + CELL / 2 - y * (CELL / 2 - 4) * rect_k) / ATLAS_H
        l[uv].uv = (u, 1 - v)
    fb = bm.faces.new(list(reversed(back)))
    for l in fb.loops:
        l[uv].uv = (grey[0], 1 - grey[1])
    n = len(poly)
    for i in range(n):
        j = (i + 1) % n
        f = bm.faces.new((front[j], front[i], back[i], back[j]))
        for l in f.loops:
            l[uv].uv = (grey[0], 1 - grey[1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    me = bpy.data.meshes.new(f'schild-{sid}_face')
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials['sign'])
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


# ---------------------------------------------------------------- pedestrians
# Light greyscale only: the game multiplies by per-person shirt, trouser, skin and hair colours (instanceColor).

GREY = {'cloth': 0xe6e6e6, 'fold': 0xc4c4c4, 'skin': 0xeeeeee, 'shoe': 0x6a6a6a, 'hair': 0xdedede, 'bag': 0x9a9a9a}
PAL.update({f'g-{k}': v for k, v in GREY.items()})
COLORS[:] = list(PAL)

PEDS = [
    # name, extras: a long coat, a skirt, a backpack, or a child (drawn at adult pivots, shown at scale 0.67)
    dict(name='mantel', coat=True),
    dict(name='rock', skirt=True),
    dict(name='rucksack', bag=True),
    dict(name='kind', child=True),
]


def ped_parts(i, p, parent):
    """Feet space (y = 0 at the feet, +z forward). Torso and head as placed; the leg hangs 0.92 m down from the hip
    pivot at its origin (the game puts it at x ±0.1, y 0.93), the arm 0.6 m from the shoulder (x ±0.27, y 1.52)."""
    node = bpy.data.objects.new(f'fussgaenger-{i}', None)
    bpy.context.scene.collection.objects.link(node)
    node.parent = parent
    node['variant'] = p['name']
    node['scale'] = 0.67 if p.get('child') else 1.0
    out = []
    t = B()
    shoulders = 0.4 if not p.get('child') else 0.36
    t.box('g-cloth', (shoulders, 0.32, 0.23), at=(0, 1.39, 0), bevel=0.04, seg=1)          # chest
    t.box('g-cloth', (0.34, 0.3, 0.21), at=(0, 1.1, 0))                                    # belly
    if not p.get('skirt'):
        t.box('g-fold', (0.35, 0.05, 0.22), at=(0, 0.96, 0))                               # belt line
    if p.get('coat'):
        t.box('g-cloth', (0.42, 0.5, 0.27), at=(0, 0.78, 0))                               # coat skirt to the knees
        t.box('g-fold', (0.02, 0.85, 0.01), at=(0, 1.0, 0.136))                            # front opening
        t.box('g-cloth', (0.3, 0.08, 0.16), at=(0, 1.58, -0.02))                           # collar
    if p.get('skirt'):
        t.cyl('g-cloth', 0.26, 0.17, 0.42, at=(0, 0.78, 0), seg=8)
    if p.get('bag'):
        t.box('g-bag', (0.3, 0.38, 0.15), at=(0, 1.3, -0.19))
        for x in (-0.12, 0.12):
            t.box('g-bag', (0.04, 0.32, 0.03), at=(x, 1.38, 0.12))
    t.box('g-skin', (0.09, 0.07, 0.09), at=(0, 1.57, 0))                                   # neck
    out.append(finish(t, f'fussgaenger-{i}_torso', node))
    hs = 1.18 if p.get('child') else 1.0                                                   # children: bigger head
    h = B()
    h.sphere('g-skin', 0.115 * hs, at=(0, 1.7, 0.01), scale=(0.9, 1.1, 1.0), seg=8, rings=6)
    out.append(finish(h, f'fussgaenger-{i}_head', node))
    hr = B()
    hr.sphere('g-hair', 0.123 * hs, at=(0, 1.745, -0.012), scale=(0.95, 0.82, 1.02), seg=8, rings=4)
    if p.get('skirt'):
        hr.sphere('g-hair', 0.07, at=(0, 1.66, -0.12), scale=(1, 1.6, 0.8), seg=6, rings=3)   # ponytail
    out.append(finish(hr, f'fussgaenger-{i}_hair', node))
    l = B()
    l.box('g-cloth', (0.15, 0.84, 0.17), at=(0, -0.42, 0))
    l.box('g-fold', (0.155, 0.04, 0.175), at=(0, -0.45, 0))                                # knee crease
    l.box('g-shoe', (0.13, 0.08, 0.27), at=(0, -0.88, 0.05))
    out.append(finish(l, f'fussgaenger-{i}_leg', node))
    a = B()
    a.box('g-cloth', (0.1, 0.5, 0.12), at=(0, -0.25, 0))
    a.box('g-fold', (0.105, 0.03, 0.125), at=(0, -0.27, 0))                                # elbow
    a.box('g-skin', (0.08, 0.1, 0.09), at=(0, -0.55, 0))
    out.append(finish(a, f'fussgaenger-{i}_arm', node))
    return out


# ---------------------------------------------------------------- build

PROPS = {
    'bank': bank, 'muelleimer': muelleimer, 'poller': poller, 'betonblock': betonblock, 'hydrant': hydrant,
    'briefkasten': briefkasten, 'fahrradstaender': fahrradstaender, 'litfasssaeule': litfasssaeule,
    'container': container, 'bushaltestelle': bushaltestelle, 'bushaltestelle-dach': bushaltestelle_dach,
    'zaun': zaun, 'mauer': mauer, 'leitplanke': leitplanke, 'ampel': ampel, 'schild_mast': schild_mast,
}


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mat('props')
    s = bpy.data.materials.new('sign')
    s.use_nodes = True
    root = bpy.data.objects.new('props', None)
    bpy.context.scene.collection.objects.link(root)
    obs = []
    for name, fn in PROPS.items():
        for lod in (0, 1):
            obs.append(finish(fn(lod), f'{name}_lod{lod}', root))
    for c, y in LAMPS.items():
        obs.append(finish(lamp(y), f'ampel_lamp_{c}', root))
    os.makedirs(TMP, exist_ok=True)
    atlas = os.path.join(TMP, 'signs.png')
    cells = draw_atlas(atlas)
    img = bpy.data.images.load(atlas)
    img.pack()
    nt = s.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
    for sid, kind, size in SIGNS:
        obs.append(sign_face(sid, kind, size, cells[sid], root))
    for i, p in enumerate(PEDS, 1):
        obs += ped_parts(i, p, root)
    for ob in obs:
        print(f'  {ob.name:26s} {tris(ob):5d} Dreiecke')
    return root


if __name__ == '__main__':
    root = build()
    export(root, OUT, texcoords=True)
    import shutil
    shutil.rmtree(TMP, ignore_errors=True)
