# Renders a contact sheet of a car GLB from four angles (for checking the shape).
# Run: blender --background --factory-startup --python tools/blender/preview.py -- in.glb out.png [lod]
import bpy, math, os, sys
from mathutils import Vector

args = sys.argv[sys.argv.index('--') + 1:]
src, dst = args[0], args[1]
lod = args[2] if len(args) > 2 else 'lod0'

bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.gltf(filepath=src)
scene = bpy.context.scene
# Wheels are stored once at the origin; place copies on the axles for the picture.
wheel = bpy.data.objects.get('wheel')
cal = bpy.data.objects.get('caliper')
for ob in list(scene.objects):
    if ob.name.startswith('lod') and ob.name != lod:
        for c in ob.children_recursive:
            c.hide_render = True
    if ob.name.startswith('wheel_lod') and ob.name != 'wheel_' + lod.replace('lod2', 'lod1'):
        ob.hide_render = True
for name in ('wheel', 'caliper'):
    o = bpy.data.objects.get(name)
    if o is None:
        continue
    for z in (1.27, -1.2):
        for s in (1, -1):
            for c in [o] + list(o.children_recursive):
                if c.type != 'MESH' or c.hide_render:
                    continue
                cp = c.copy()
                scene.collection.objects.link(cp)
                cp.parent = None
                cp.matrix_world = c.matrix_world.copy()
                cp.scale.x *= s
                cp.location = Vector((s * 0.8, -z, 0.35))
            for c in [o] + list(o.children_recursive):
                pass
    for c in [o] + list(o.children_recursive):
        c.hide_render = True

ground = bpy.data.meshes.new('g')
ground.from_pydata([(-20, -20, 0), (20, -20, 0), (20, 20, 0), (-20, 20, 0)], [], [(0, 1, 2, 3)])
g = bpy.data.objects.new('ground', ground)
scene.collection.objects.link(g)
gm = bpy.data.materials.new('gm')
gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.35, 0.35, 0.36, 1)
gm.node_tree.nodes['Principled BSDF'].inputs['Roughness'].default_value = 0.8
ground.materials.append(gm)

world = bpy.data.worlds.new('w')
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes['Background']
sky = world.node_tree.nodes.new('ShaderNodeTexSky')
world.node_tree.links.new(sky.outputs[0], bg.inputs[0])
bg.inputs[1].default_value = 0.35
sun = bpy.data.objects.new('sun', bpy.data.lights.new('sun', 'SUN'))
sun.data.energy = 3.5
sun.rotation_euler = (math.radians(50), 0, math.radians(30))
scene.collection.objects.link(sun)

scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x, scene.render.resolution_y = 900, 560
scene.view_settings.view_transform = 'AgX'
cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
cam.data.lens = 50
scene.collection.objects.link(cam)
scene.camera = cam

views = [(-35, 12, 7.5), (145, 14, 7.5), (90, 3, 8.5), (0, 75, 9)]  # front 3/4, rear 3/4, side, top
from PIL import Image
tiles = []
base = os.path.splitext(dst)[0]
for i, (az, el, dist) in enumerate(views):
    a, e = math.radians(az), math.radians(el)
    target = Vector((0, 0, 0.6))
    # Model +z forward = Blender -y; azimuth 0 = in front of the car.
    cam.location = target + Vector((math.sin(a) * math.cos(e), -math.cos(a) * math.cos(e), math.sin(e))) * dist
    cam.rotation_euler = (target - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scene.render.filepath = f'{base}_{i}.png'
    bpy.ops.render.render(write_still=True)
    tiles.append(Image.open(scene.render.filepath))
sheet = Image.new('RGB', (1800, 1120))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % 2) * 900, (i // 2) * 560))
sheet.save(dst)
for i in range(len(views)):
    os.remove(f'{base}_{i}.png')
print('preview', dst)
