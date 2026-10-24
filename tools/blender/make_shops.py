# Builds shop parts for the old-town facades and exports public/models/shops.glb.
# Run: blender --background --factory-startup --python tools/blender/make_shops.py -- [out.glb]
#
# Wall-mounted parts: the facade is the plane z = 0, parts project towards +z (the street); ground at y = 0 with
# the mounting height baked in; +x along the wall. Vertex colours, one material, <name>_lod0 / _lod1.
#   markise           awning, 1 m along x (scale x by the shop width), rail y 3.25, front edge y 2.4, 1.4 m deep;
#                     light greyscale with stripes in the shading so the game tints it per instance
#   markise-kasten    the retracted awning box only (same width rule)
#   nasenschild       projecting sign: wall bracket at y 3.2 and a blank 0.6 m plate (faces: laden-<typ>_nase)
#   ladenschild       fascia board above the shop window, 1 m along x, y 2.6 .. 3.1 (scale x by the width)
#   laden-<typ>_face  fascia lettering, 1.0 x 0.375 m, centred at x = 0, y 2.85, z 0.06: place it unscaled
#   laden-<typ>_nase  both faces of the projecting sign (fits nasenschild_lod0)
# Freestanding: cafe-tisch (table with two chairs), aufsteller (pavement A-board); +z towards the street.
# Faces carry uv into a self-drawn atlas embedded in the GLB. No brands or logos (the pharmacy uses red text only).
import bpy, bmesh, math, os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import Builder, bl, export, tris
import make_props as mp

HERE = os.path.dirname(os.path.abspath(__file__))
args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else []
OUT = os.path.abspath(args[0]) if args else os.path.join(HERE, '..', '..', 'public', 'models', 'shops.raw.glb')
TMP = os.path.join(os.path.dirname(OUT), '.shops-bake')

mp.PAL.update({
    'awning': 0xf0f0f0, 'awning.stripe': 0xc8c8c8, 'awning.edge': 0xb0b0b0, 'metal': 0x3a3d40, 'board': 0x2b2d30,
    'board.edge': 0x6a6d70, 'tabletop': 0xd8d4cc, 'chair': 0x6a6d70, 'aboard': 0x1e2022, 'aboard.frame': 0x8a6a48,
})
mp.COLORS[:] = list(mp.PAL)

SHOPS = [
    # id, fascia text, background, text colour, pictogram
    ('baeckerei', 'Bäckerei', (110, 66, 32), (250, 230, 190), 'brezel'),
    ('metzgerei', 'Metzgerei', (150, 28, 34), (255, 255, 255), 'messer'),
    ('cafe', 'Café', (40, 70, 60), (240, 225, 190), 'tasse'),
    ('restaurant', 'Restaurant', (30, 30, 34), (230, 200, 120), 'besteck'),
    ('apotheke', 'Apotheke', (255, 255, 255), (200, 20, 30), 'apotheke'),
    ('friseur', 'Friseur', (20, 20, 22), (255, 255, 255), 'schere'),
    ('mode', 'Mode', (240, 236, 228), (30, 30, 30), 'buegel'),
    ('buch', 'Bücher', (24, 50, 90), (250, 245, 230), 'buch'),
    ('blumen', 'Blumen', (60, 110, 50), (255, 250, 240), 'blume'),
    ('eis', 'Eiscafé', (240, 200, 210), (120, 40, 70), 'eis'),
    ('kiosk', 'Kiosk', (240, 190, 40), (30, 30, 30), 'zeitung'),
    ('bank', 'Bank', (40, 60, 80), (255, 255, 255), 'euro'),
    ('laden', 'Laden', (60, 62, 66), (255, 255, 255), 'tuete'),
]
FACE_W, FACE_H = 1.0, 0.375
CELL_W, CELL_H = 512, 192          # fascia cells, 2 per row
NASE = 128                          # projecting-sign cells
ATLAS_W, ATLAS_H = 1024, 2048
NASE_Y0 = 7 * CELL_H


# ---------------------------------------------------------------- wall parts

def markise(lod):
    """Sloping awning: wall rail at y 3.25 (above the fascia sign), front edge at y 2.4 and z 1.4, valance 0.25 m."""
    b = mp.B()
    stripes = 8 if lod == 0 else 1
    w = 1.0 / stripes
    slope = math.atan2(0.85, 1.4)
    length = math.hypot(0.85, 1.4)
    for i in range(stripes):
        x = -0.5 + w * (i + 0.5)
        c = 'awning' if i % 2 == 0 else 'awning.stripe'
        b.box(c, (w, 0.01, length), at=(x, 2.825, 0.7), rot=(slope, 0, 0))
        b.box(c, (w, 0.25, 0.01), at=(x, 2.275, 1.4))                    # valance
    if lod == 0:
        b.box('awning.edge', (1.0, 0.03, 0.03), at=(0, 2.4, 1.4))         # front bar
        b.box('metal', (1.0, 0.08, 0.1), at=(0, 3.27, 0.05))             # wall rail
        for x in (-0.5, 0.5):
            b.box('metal', (0.02, 0.02, 1.62), at=(x, 2.8, 0.7), rot=(slope, 0, 0))    # folding arms
    return b


def markise_kasten(lod):
    b = mp.B()
    b.box('metal', (1.0, 0.2, 0.22), at=(0, 3.25, 0.11), bevel=0.03 if lod == 0 else 0, seg=1)
    return b


def nasenschild(lod):
    """Wall bracket at y 3.2 projecting 0.85 m; blank plate 0.6 x 0.6 hanging from it, perpendicular to the wall."""
    b = mp.B()
    b.box('metal', (0.06, 0.04, 0.85), at=(0, 3.25, 0.425))
    b.box('metal', (0.16, 0.25, 0.02), at=(0, 3.2, 0.01))                   # wall plate
    if lod == 0:
        b.box('metal', (0.03, 0.03, 0.62), at=(0, 3.05, 0.25), rot=(-0.45, 0, 0))  # diagonal brace
        b.cyl('metal', 0.02, 0.0, 0.06, at=(0, 3.3, 0.85), seg=6)
    b.box('board', (0.03, 0.6, 0.6), at=(0, 2.9, 0.5))                       # plate (faces sit on both sides)
    return b


def ladenschild(lod):
    b = mp.B()
    b.box('board', (1.0, 0.5, 0.05), at=(0, 2.85, 0.025))
    if lod == 0:
        b.box('board.edge', (1.0, 0.03, 0.06), at=(0, 3.1, 0.03))
        b.box('board.edge', (1.0, 0.03, 0.06), at=(0, 2.6, 0.03))
    return b


def cafe_tisch(lod):
    """Round bistro table (0.7 m) with two chairs facing each other along x."""
    b = mp.B()
    seg = 16 if lod == 0 else 6
    b.cyl('tabletop', 0.35, 0.35, 0.03, at=(0, 0.74, 0), seg=seg)
    b.cyl('metal', 0.03, 0.03, 0.72, at=(0, 0.37, 0), seg=6)
    b.cyl('metal', 0.22, 0.22, 0.02, at=(0, 0.01, 0), seg=seg)
    for s in (1, -1):
        x = s * 0.62
        b.box('chair', (0.42, 0.04, 0.42), at=(x, 0.46, 0))                   # seat
        b.box('chair', (0.04, 0.45, 0.42), at=(x + s * 0.2, 0.7, 0), rot=(0, 0, -s * 0.12))  # back
        if lod == 0:
            for dx in (-0.17, 0.17):
                for dz in (-0.17, 0.17):
                    b.box('metal', (0.025, 0.46, 0.025), at=(x + dx, 0.23, dz))
    return b


def aufsteller(lod):
    """A-board: two chalkboard panels leaning together, 0.6 x 1.0 m."""
    b = mp.B()
    for s in (1, -1):
        b.box('aboard.frame', (0.62, 1.02, 0.03), at=(0, 0.5, s * 0.17), rot=(-s * 0.17, 0, 0))
        b.box('aboard', (0.54, 0.86, 0.01), at=(0, 0.52, s * 0.19), rot=(-s * 0.17, 0, 0))
    return b


PARTS = {'markise': markise, 'markise-kasten': markise_kasten, 'nasenschild': nasenschild, 'ladenschild': ladenschild,
         'cafe-tisch': cafe_tisch, 'aufsteller': aufsteller}


# ---------------------------------------------------------------- atlas

def draw_atlas(path):
    from PIL import Image, ImageDraw, ImageFont
    def font(px):
        for f in ('/usr/share/fonts/TTF/DejaVuSerifCondensed-Bold.ttf', '/usr/share/fonts/TTF/DejaVuSansCondensed-Bold.ttf'):
            try:
                return ImageFont.truetype(f, px)
            except OSError:
                pass
        return ImageFont.load_default()
    img = Image.new('RGBA', (ATLAS_W, ATLAS_H), (43, 45, 48, 255))
    d = ImageDraw.Draw(img)
    for k, (sid, text, bg, fg, icon) in enumerate(SHOPS):
        x0, y0 = (k % 2) * CELL_W, (k // 2) * CELL_H
        d.rectangle([x0 + 4, y0 + 4, x0 + CELL_W - 4, y0 + CELL_H - 4], fill=bg)
        d.rectangle([x0 + 12, y0 + 12, x0 + CELL_W - 12, y0 + CELL_H - 12], outline=fg, width=3)
        size = 92
        f = font(size)
        while d.textlength(text, font=f) > CELL_W - 70 and size > 30:
            size -= 4
            f = font(size)
        w = d.textlength(text, font=f)
        d.text((x0 + (CELL_W - w) / 2, y0 + CELL_H / 2 - size * 0.62), text, fill=fg, font=f)
        # Projecting-sign pictogram.
        nx, ny = (k % 8) * NASE, NASE_Y0 + (k // 8) * NASE
        c = (nx + NASE / 2, ny + NASE / 2)
        d.ellipse([nx + 4, ny + 4, nx + NASE - 4, ny + NASE - 4], fill=bg, outline=fg, width=5)
        pictogram(d, icon, c, fg, font)
    img.save(path)


def pictogram(d, icon, c, col, font):
    x, y = c
    if icon == 'brezel':
        d.arc([x - 34, y - 26, x + 2, y + 18], 100, 400, fill=col, width=9)
        d.arc([x - 2, y - 26, x + 34, y + 18], 140, 440, fill=col, width=9)
        d.line([(x - 22, y + 22), (x + 22, y - 6)], fill=col, width=9)
        d.line([(x + 22, y + 22), (x - 22, y - 6)], fill=col, width=9)
    elif icon == 'tasse':
        d.rounded_rectangle([x - 26, y - 14, x + 14, y + 22], 8, fill=col)
        d.arc([x + 6, y - 6, x + 32, y + 14], 270, 90, fill=col, width=7)
        for dx in (-14, 0):
            d.arc([x + dx - 6, y - 40, x + dx + 6, y - 18], 90, 270, fill=col, width=4)
    elif icon == 'besteck':
        d.line([(x - 14, y - 34), (x - 14, y + 34)], fill=col, width=8)
        for dx in (-24, -14, -4):
            d.line([(x + dx, y - 34), (x + dx, y - 12)], fill=col, width=4)
        d.polygon([(x + 12, y - 34), (x + 24, y - 34), (x + 22, y + 34), (x + 14, y + 34)], fill=col)
    elif icon == 'messer':
        d.polygon([(x - 34, y + 6), (x + 18, y - 22), (x + 18, y + 6)], fill=col)
        d.rectangle([x + 18, y - 6, x + 38, y + 6], fill=col)
    elif icon == 'apotheke':
        f = font(22)
        w = d.textlength('Apotheke', font=f)
        d.text((x - w / 2, y - 14), 'Apotheke', fill=col, font=f)
    elif icon == 'schere':
        d.ellipse([x - 30, y + 6, x - 10, y + 26], outline=col, width=6)
        d.ellipse([x + 10, y + 6, x + 30, y + 26], outline=col, width=6)
        d.line([(x - 14, y + 8), (x + 16, y - 34)], fill=col, width=7)
        d.line([(x + 14, y + 8), (x - 16, y - 34)], fill=col, width=7)
    elif icon == 'buegel':
        d.arc([x - 8, y - 34, x + 8, y - 18], 180, 90, fill=col, width=5)
        d.line([(x, y - 18), (x - 34, y + 14), (x + 34, y + 14), (x, y - 18)], fill=col, width=6)
    elif icon == 'buch':
        d.polygon([(x - 36, y - 20), (x - 2, y - 12), (x - 2, y + 26), (x - 36, y + 18)], fill=col)
        d.polygon([(x + 36, y - 20), (x + 2, y - 12), (x + 2, y + 26), (x + 36, y + 18)], fill=col)
    elif icon == 'blume':
        for a in range(5):
            t = a * 2 * math.pi / 5
            px, py = x + math.cos(t) * 16, y - 10 + math.sin(t) * 16
            d.ellipse([px - 10, py - 10, px + 10, py + 10], fill=col)
        d.line([(x, y + 2), (x, y + 36)], fill=col, width=5)
    elif icon == 'eis':
        d.polygon([(x - 18, y - 2), (x + 18, y - 2), (x, y + 38)], fill=col)
        d.ellipse([x - 20, y - 34, x + 20, y + 4], fill=col)
    elif icon == 'zeitung':
        d.rectangle([x - 30, y - 24, x + 30, y + 26], fill=col)
        for i in range(4):
            d.line([(x - 22, y - 12 + i * 10), (x + 22, y - 12 + i * 10)], fill=(255, 255, 255), width=3)
    elif icon == 'euro':
        f = font(64)
        w = d.textlength('€', font=f)
        d.text((x - w / 2, y - 44), '€', fill=col, font=f)
    else:  # tuete (shopping bag)
        d.rectangle([x - 24, y - 12, x + 24, y + 30], fill=col)
        d.arc([x - 14, y - 34, x + 14, y - 2], 180, 360, fill=col, width=6)


def face_mesh(name, quads, parent):
    """quads: list of (4 model-space corners, 4 uv) -> one textured mesh."""
    bm = bmesh.new()
    lay = bm.loops.layers.uv.new('UVMap')
    for corners, uvs in quads:
        f = bm.faces.new([bm.verts.new(bl(*p)) for p in corners])
        for l, uv in zip(f.loops, uvs):
            l[lay].uv = uv
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(bpy.data.materials['shopsign'])
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.parent = parent
    return ob


def faces_for(k, parent):
    x0, y0 = (k % 2) * CELL_W, (k // 2) * CELL_H
    u0, u1 = (x0 + 6) / ATLAS_W, (x0 + CELL_W - 6) / ATLAS_W
    v1, v0 = 1 - (y0 + 6) / ATLAS_H, 1 - (y0 + CELL_H - 6) / ATLAS_H
    hw, yc, z = FACE_W / 2, 2.85, 0.06
    fascia = [(((-hw, yc - FACE_H / 2, z), (hw, yc - FACE_H / 2, z), (hw, yc + FACE_H / 2, z), (-hw, yc + FACE_H / 2, z)),
               ((u0, v0), (u1, v0), (u1, v1), (u0, v1)))]
    nx, ny = (k % 8) * NASE, NASE_Y0 + (k // 8) * NASE
    a0, a1 = (nx + 2) / ATLAS_W, (nx + NASE - 2) / ATLAS_W
    b1, b0 = 1 - (ny + 2) / ATLAS_H, 1 - (ny + NASE - 2) / ATLAS_H
    # Projecting sign: plate centred at (0, 2.9, 0.5), 0.6 m square, faces on both sides (normals ±x).
    zs, ys = (0.2, 0.8), (2.6, 3.2)
    nase = [
        (((0.02, ys[0], zs[1]), (0.02, ys[0], zs[0]), (0.02, ys[1], zs[0]), (0.02, ys[1], zs[1])), ((a0, b0), (a1, b0), (a1, b1), (a0, b1))),
        (((-0.02, ys[0], zs[0]), (-0.02, ys[0], zs[1]), (-0.02, ys[1], zs[1]), (-0.02, ys[1], zs[0])), ((a0, b0), (a1, b0), (a1, b1), (a0, b1))),
    ]
    sid = SHOPS[k][0]
    return [face_mesh(f'laden-{sid}_face', fascia, parent), face_mesh(f'laden-{sid}_nase', nase, parent)]


def build():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mp.mat('props')
    s = bpy.data.materials.new('shopsign')
    s.use_nodes = True
    root = bpy.data.objects.new('shops', None)
    bpy.context.scene.collection.objects.link(root)
    obs = []
    for name, fn in PARTS.items():
        for lod in (0, 1):
            obs.append(mp.finish(fn(lod), f'{name}_lod{lod}', root))
    os.makedirs(TMP, exist_ok=True)
    atlas = os.path.join(TMP, 'shops.png')
    draw_atlas(atlas)
    from PIL import Image
    Image.open(atlas).convert('RGB').quantize(colors=256, method=Image.Quantize.MEDIANCUT).save(atlas, optimize=True)
    img = bpy.data.images.load(atlas)
    img.pack()
    nt = s.node_tree
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = img
    nt.links.new(tex.outputs['Color'], nt.nodes['Principled BSDF'].inputs['Base Color'])
    for k in range(len(SHOPS)):
        obs += faces_for(k, root)
    total = 0
    for ob in obs:
        t = tris(ob)
        if not ob.name.endswith('_lod1'):
            total += t
        print(f'  {ob.name:26s} {t:5d} Dreiecke')
    print(f'  lod0 + Schilder: {total} Dreiecke')
    return root


if __name__ == '__main__':
    root = build()
    export(root, OUT, texcoords=True)
    import shutil
    shutil.rmtree(TMP, ignore_errors=True)
