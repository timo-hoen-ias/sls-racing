# Renders a contact sheet of the house models straight from make_houses.py (Cycles, CPU), for checking shapes.
# Run: blender --background --factory-startup --python tools/blender/preview_houses.py -- out.png [lod] [id,id,…]
import bpy, math, os, sys
from mathutils import Vector

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_houses as mh
from carlib import srgb

args = sys.argv[sys.argv.index('--') + 1:]
dst = args[0]
lod = int(args[1]) if len(args) > 1 else 0
ids = args[2].split(',') if len(args) > 2 else [c['id'] for c in mh.CAT['models']]

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene


def vc_material(name, rough, metal=0.0, emit=False):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    b = nt.nodes['Principled BSDF']
    a = nt.nodes.new('ShaderNodeVertexColor')
    a.layer_name = 'Color'
    nt.links.new(a.outputs['Color'], b.inputs['Base Color'])
    b.inputs['Roughness'].default_value = rough
    b.inputs['Metallic'].default_value = metal
    return m


body, glass = vc_material('house', 0.85), vc_material('glass', 0.05, 0.6)
cols = int(os.environ.get('COLS', 6 if len(ids) > 6 else 3))
gap = 30
for i, id in enumerate(ids):
    root = bpy.data.objects.new(id, None)
    scene.collection.objects.link(root)
    if id in mh.GARDEN:
        m = mh.M(mh.BASE)
        mh.GARDEN[id](m, lod)
        m.finish(id, root, body)
        root.scale = (4, 4, 4)
    else:
        m, g = mh.build_house(id, lod)
        m.finish(id, root, body)
        g.finish(id + '_g', root, glass)
    root.location = Vector(((i % cols) * gap, -(i // cols) * gap, 0))

ground = bpy.data.meshes.new('g')
S = 400
ground.from_pydata([(-S, -S, 0), (S, -S, 0), (S, S, 0), (-S, S, 0)], [], [(0, 1, 2, 3)])
gob = bpy.data.objects.new('ground', ground)
scene.collection.objects.link(gob)
gm = bpy.data.materials.new('gm')
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.18, 0.26, 0.12, 1)
ground.materials.append(gm)

world = bpy.data.worlds.new('w')
scene.world = world
world.use_nodes = True
world.node_tree.nodes['Background'].inputs[0].default_value = (0.55, 0.65, 0.8, 1)
world.node_tree.nodes['Background'].inputs[1].default_value = 0.8
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.2
sun.rotation_euler = (math.radians(50), 0, math.radians(-35))
scene.collection.objects.link(sun)

rows = (len(ids) + cols - 1) // cols
cx, cy = (cols - 1) * gap / 2, -(rows - 1) * gap / 2
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
scene.collection.objects.link(cam)
scene.camera = cam
# Looking at the fronts (+y in Blender = -z model… fronts face model +z = Blender -y) from front-left above.
d = max(cols * 0.9, rows * 1.3) * gap
cam.location = Vector((cx - d * 0.25, cy - d * 0.9, d * 0.42))
direction = Vector((cx, cy, 2)) - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()
cam.data.lens = 42
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = int(os.environ.get('SAMPLES', 24))
scene.cycles.use_denoising = True
scene.render.resolution_x = int(os.environ.get('RES_X', 1800))
scene.render.resolution_y = int(int(os.environ.get('RES_X', 1800)) * (0.62 if rows > 1 else 0.5))
scene.render.filepath = os.path.abspath(dst)
bpy.ops.render.render(write_still=True)
print('preview', dst)
