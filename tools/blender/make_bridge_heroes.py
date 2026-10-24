# Hero models of the landmark road bridges of Saarlouis (Saar crossings of the B 405, A 8, A 620, ...):
# superstructure with cantilevers and underside, haunched over the piers where the real bridges are, piers on the
# real terrain, abutments with wing walls, edge beam, parapet and railing. They replace the generic bruecke-<id>.glb.
# Run: node tools/bridge-heroes.ts (after world:fetch + world:build), then
#      blender --background --factory-startup --python tools/blender/make_bridge_heroes.py
#
# Same rules and model space as make_bridges.py: the pipeline owns the deck surface and its collision; nothing
# above the deck within halfWidth, the girder stays at least 0.3 m below the surface (inside the pipeline's 1 m
# slab), railings stand outside halfWidth + 0.5 m, colliders cover only piers, abutments and parapets.
# The bridge types follow photos (Wikimedia Commons) where there are any; the rest are the usual prestressed
# concrete girders of the Saar crossings of their era.
import bpy, bmesh, json, math, os, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from carlib import MATS, empty, export, pbr, tris
import make_bridges as mb

ROOT = mb.ROOT
HEROES = {b['id']: b for b in json.load(open(os.path.join(ROOT, 'pipeline', 'bridge-heroes.json')))}
MANIFEST = {l.get('bridge'): l for l in json.load(open(os.path.join(ROOT, 'pipeline', 'landmarks.json'))) if 'bridge' in l}

# Bridge types: girder section, depth at mid-span and over the piers (m), typical span (m), pier style.
TYPES = {
    'peter-neis': dict(section='box', mid=1.8, pier=3.2, span=42, piers='brick'),       # brick-clad pier walls (photo)
    'heinemann': dict(section='box', mid=2.0, pier=2.0, span=40, piers='twin'),         # twin round columns (photo)
    'a8': dict(section='box', mid=2.4, pier=4.2, span=55, piers='wall'),
    'a620': dict(section='box', mid=2.0, pier=3.4, span=45, piers='wall'),
    'brueckenstrasse': dict(section='slab', mid=1.2, pier=1.2, span=28, piers='round'),
    'adenauer': dict(section='slab', mid=1.3, pier=1.3, span=30, piers='round'),
}


def materials():
    mb.materials()
    pbr('stone.brick', 0x8a4a3a, 0.0, 0.9)       # brick cladding
    pbr('plaster.light', 0xc4c0b6, 0.0, 0.85)    # edge beam / cornice


MATS_LIST = ['plaster', 'plaster.dark', 'plaster.light', 'stone', 'stone.brick', 'copper']


def stations(hero, entry):
    """Per 4 m point: position (2D, local), tangent, left normal, deck height, ground height (local), over water, s."""
    pts = [(Vector((p[0] - entry['e'], p[1] - entry['n'])), p[2] - entry['y'], p[3] - entry['y'], bool(p[4])) for p in hero['pts']]
    out, s = [], 0.0
    for i, (q, y, g, w) in enumerate(pts):
        a = pts[max(0, i - 1)][0]
        b = pts[min(len(pts) - 1, i + 1)][0]
        t = (b - a).normalized()
        if i:
            s += (q - pts[i - 1][0]).length
        out.append(dict(q=q, t=t, n=Vector((-t.y, t.x)), y=y, g=g, w=w, s=s))
    return out


def pier_positions(st, typ):
    """Arc lengths of the piers. Girder bridges keep a main span over the water (piers 6 m from the banks, as long
    as that span stays under 2.5 typical spans); everything else is divided into spans of about typ['span']."""
    L = st[-1]['s']
    wet = [p['s'] for p in st if p['w']]
    fixed, open_span = [], None
    if wet and L > 50 and typ['section'] == 'box':
        a, b = min(wet) - 6, max(wet) + 6
        if b - a <= 2.5 * typ['span']:
            fixed = [x for x in (a, b) if 12 < x < L - 12]
            open_span = (a, b)
    bounds = [0.0] + fixed + [L]
    out = list(fixed)
    for lo, hi in zip(bounds, bounds[1:]):
        if open_span and lo >= open_span[0] - 1 and hi <= open_span[1] + 1:
            continue                                                   # the main span stays open
        n = max(0, math.ceil((hi - lo) / typ['span']) - 1)
        for k in range(1, n + 1):
            p = lo + (hi - lo) * k / (n + 1)
            if 10 < p < L - 10:
                out.append(p)
    return sorted(out)


def at(st, s):
    """Interpolated station at arc length s."""
    for a, b in zip(st, st[1:]):
        if a['s'] <= s <= b['s']:
            k = (s - a['s']) / max(1e-6, b['s'] - a['s'])
            return dict(q=a['q'].lerp(b['q'], k), t=a['t'].lerp(b['t'], k).normalized(), n=a['n'].lerp(b['n'], k).normalized(),
                        y=a['y'] + (b['y'] - a['y']) * k, g=a['g'] + (b['g'] - a['g']) * k, w=a['w'], s=s)
    return st[-1]


def depth(typ, s, piers, L):
    """Girder depth: deeper over the piers (parabolic haunch over a fifth of the span)."""
    if not piers or typ['pier'] <= typ['mid']:
        return typ['mid']
    d = min(abs(s - p) for p in piers)
    span = max(20.0, min(typ['span'], L / (len(piers) + 1)))
    k = max(0.0, 1 - d / (0.22 * span))
    return typ['mid'] + (typ['pier'] - typ['mid']) * k * k


def section(typ, hw, d):
    """Cross-section (lateral offset, height below the deck top) from the right edge round to the left edge."""
    W = hw + mb.PARAPET
    if typ['section'] == 'box':
        half = [(W, -0.35), (W, -0.75), (0.6 * hw, -1.05), (0.42 * hw, -1.0 - d)]
    else:
        half = [(W, -0.35), (W, -0.7), (0.85 * hw, -0.95), (0.75 * hw, -1.0 - d)]
    return [(-o, h) for o, h in half] + [(o, h) for o, h in reversed(half)]


def sweep(m, st, typ, hw, piers, L, mat):
    """The superstructure: the cross-section swept along the deck, closed at both ends."""
    rings = []
    for p in st:
        sec = section(typ, hw, depth(typ, p['s'], piers, L))
        rings.append([Vector(((p['q'] + p['n'] * o).x, (p['q'] + p['n'] * o).y, p['y'] + h)) for o, h in sec])
    n = len(rings[0])
    for a, b in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            m.quad(a[i], a[j], b[j], b[i], mat)
    for r in (rings[0], rings[-1]):
        f = m.bm.faces.new([m.bm.verts.new(v) for v in r])
        f.material_index = m.mats.index(mat)


def piers_and_abutments(m, st, typ, hw, piers, L, lod, collider=False):
    seg = 16 if lod == 0 else 8
    for s in piers:
        p = at(st, s)
        top = p['y'] - 1.0 - depth(typ, s, piers, L) + 0.05
        bottom = p['g'] - 1.5
        if top - bottom < 1.0:
            continue
        style = typ['piers']
        if style in ('wall', 'brick'):
            width = 2 * 0.42 * hw * (0.9 if typ['section'] == 'box' else 1.4)
            mat = 'stone.brick' if style == 'brick' and not collider else 'plaster'
            m.box(mat, (p['q'].x, p['q'].y), p['n'], p['t'], width, 1.6, bottom, top)
            if not collider:
                for side in (1, -1):                                   # rounded pier noses
                    m.column(mat, p['q'] + p['n'] * (side * width / 2), 0.8, bottom, top, seg)
                m.box('plaster.dark', (p['q'].x, p['q'].y), p['n'], p['t'], width + 0.6, 2.2, top - 0.6, top)  # bearing cap
        elif style == 'twin':
            for side in (1, -1):
                c = p['q'] + p['n'] * (side * 0.32 * hw)
                if collider:
                    m.box('plaster', (c.x, c.y), p['n'], p['t'], 1.5, 1.5, bottom, top)
                else:
                    m.column('plaster', c, 0.75, bottom, top, seg)
            m.box('plaster.dark', (p['q'].x, p['q'].y), p['n'], p['t'], 0.9 * hw + 1.6, 1.8, top - 0.9, top)
        else:                                                          # round columns across a wide slab
            k = max(2, int((2 * hw) // 5) + 1)
            for i in range(k):
                o = -0.7 * hw + 1.4 * hw * i / (k - 1)
                c = p['q'] + p['n'] * o
                if collider:
                    m.box('plaster', (c.x, c.y), p['n'], p['t'], 1.1, 1.1, bottom, top)
                else:
                    m.column('plaster', c, 0.55, bottom, top, seg)
    # Abutments at both ends: wall across the deck with wing walls back into the embankment.
    for p, back in ((st[0], -1), (st[-1], 1)):
        top = p['y'] - 0.35
        bottom = p['g'] - 1.5
        if top - bottom < 1.5:
            continue
        W = hw + mb.PARAPET
        # The abutment carries the last metres of the deck; short wing walls reach 1 m into the embankment.
        c = p['q'] - p['t'] * (back * 0.8)
        m.box('plaster', (c.x, c.y), p['n'], p['t'], 2 * W, 1.6, bottom, top)
        if not collider:
            for side in (1, -1):
                w = p['q'] + p['n'] * (side * (W - 0.25)) - p['t'] * (back * 1.0)
                m.box('plaster', (w.x, w.y), p['t'], p['n'], 4.0, 0.5, bottom, top)


def build(hero, entry, lod):
    typ = TYPES[hero['type']]
    hw = hero['halfWidth']
    st = stations(hero, entry)
    if lod:
        st = st[::3] + ([st[-1]] if (len(st) - 1) % 3 else [])
    L = st[-1]['s']
    piers = pier_positions(stations(hero, entry), typ)
    m = mb.Mesh(MATS_LIST)
    sweep(m, st, typ, hw, piers, L, 'plaster')
    fr = [(p['q'], p['t'], p['n'], p['y']) for p in st]
    for side in (1, -1):
        mb.ribbon(m, fr, hw, hw + mb.PARAPET, -0.45, 0.35, 'plaster.light', side)        # edge beam + parapet
        if lod == 0:
            mb.ribbon(m, fr, hw + mb.PARAPET - 0.02, hw + mb.PARAPET + 0.05, -0.85, -0.4, 'plaster.dark', side)  # cornice
            mb.ribbon(m, fr, hw + mb.RAIL - 0.035, hw + mb.RAIL + 0.035, 1.02, 1.1, 'copper', side)                # handrail
            mb.ribbon(m, fr, hw + mb.RAIL - 0.015, hw + mb.RAIL + 0.015, 0.62, 0.66, 'copper', side)
            s, nxt = 0.0, 1.0
            for (qa, ta, na, ya), (qb, tb, nb, yb) in zip(fr, fr[1:]):
                seg = (qb - qa).length
                while nxt <= s + seg:
                    k = (nxt - s) / seg
                    q = qa.lerp(qb, k) + na * ((hw + mb.RAIL) * side)
                    y = ya + (yb - ya) * k
                    m.box('copper', (q.x, q.y), ta, na, 0.06, 0.06, y + 0.35, y + 1.1)
                    nxt += 2.0
                s += seg
    piers_and_abutments(m, stations(hero, entry), typ, hw, piers, L, lod)
    return m, piers


def build_collider(hero, entry, piers):
    typ = TYPES[hero['type']]
    hw = hero['halfWidth']
    st = stations(hero, entry)
    L = st[-1]['s']
    m = mb.Mesh(MATS_LIST)
    sparse = st[::5] + ([st[-1]] if (len(st) - 1) % 5 else [])
    fr = [(p['q'], p['t'], p['n'], p['y']) for p in sparse]
    for side in (1, -1):
        mb.ribbon(m, fr, hw + 0.05, hw + mb.PARAPET, -0.2, 1.1, 'plaster', side)
    piers_and_abutments(m, st, typ, hw, piers, L, 1, collider=True)
    return m


def build_one(hero):
    entry = MANIFEST.get(hero['id'])
    if entry is None:
        print(f"  {hero['id']}: kein Manifest-Eintrag (node tools/landmark-footprints.ts)")
        return
    bpy.ops.wm.read_factory_settings(use_empty=True)
    MATS.clear()
    materials()
    root = empty(entry['id'], None)
    obs = []
    piers = []
    for lod in (0, 1):
        m, piers = build(hero, entry, lod)
        obs.append(m.finish(f"{entry['id']}_lod{lod}", root))
    obs.append(build_collider(hero, entry, piers).finish(f"{entry['id']}_collider", root))
    root['hero'] = hero['type']
    for ob in obs:
        print(f"  {ob.name:28s} {tris(ob):6d} Dreiecke  ({hero['type']}, {len(piers)} Pfeiler)")
    export(root, os.path.join(mb.OUT_DIR, entry['id'] + '.raw.glb'))


if __name__ == '__main__':
    for hero in HEROES.values():
        build_one(hero)
