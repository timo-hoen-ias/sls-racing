# The player car for Unreal (called from sls_setup.py, or alone: -ExecutePythonScript=<abs>/sls_car.py): imports the
# web game's sports coupé exported by unreal/tools/export-car.ts (Data/car: body LOD0..2, wheel LOD0..1, caliper as
# GLB in the web's model space) into /Game/Cars and builds its materials like sportsCarGlb.ts: one master
# M_SlsCar with colour / metal / roughness / clear coat / emission parameters and an instance per glTF material
# (MI_SlsCar_<name>), the paint, lights and glass overridden with the web game's values. ASlsCarPawn loads
# /Game/Cars/SM_SlsCar_Body, _Wheel and _Caliper and scales them by VEHICLE.scale.
import json
import os
import unreal

PROJECT = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
CAR_SRC = os.path.join(PROJECT, 'Data', 'car')
DEST = '/Game/Cars'
tools = unreal.AssetToolsHelpers.get_asset_tools()
MEL = unreal.MaterialEditingLibrary
EAL = unreal.EditorAssetLibrary
log = unreal.log


def clear_material(m):
    """Removes every expression. MEL.delete_all_material_expressions deletes while it iterates the same array, so it
    skips every other node: each re-run left half the old graph behind (a stale Single Layer Water output without
    inputs broke M_SlsWater)."""
    for e in list(MEL.get_material_expressions(m)):
        MEL.delete_material_expression(m, e)


def srgb(hex_color):
    """'#c0141c' → linear LinearColor (three.js converts material colours from sRGB the same way)."""
    c = [int(hex_color[i:i + 2], 16) / 255.0 for i in (1, 3, 5)]
    lin = [x / 12.92 if x <= 0.04045 else ((x + 0.055) / 1.055) ** 2.4 for x in c]
    return lin


# sportsCarGlb.ts replaces these glTF materials with its own (colour, metalness, roughness, clear coat, emission).
WEB = {
    'paint': dict(color=srgb('#c0141c'), metal=0.6, rough=0.32, coat=1.0),
    'head': dict(color=srgb('#ffffff'), emissive=[x * 2.4 for x in srgb('#f4f8ff')]),
    'brake': dict(color=srgb('#4a0000'), emissive=[x * 0.7 for x in srgb('#ff1010')]),
    'glass': dict(color=srgb('#0a0e13'), metal=0.3, rough=0.04, coat=1.0),
    'trim': dict(color=srgb('#0b0c0e'), metal=0.2, rough=0.25, coat=0.6),
    'carbon': dict(color=srgb('#16181b'), metal=0.4, rough=0.35, coat=0.8),
    'indicator': dict(color=srgb('#6a3a00'), emissive=[x * 0.3 for x in srgb('#ff8a00')]),
    'well': dict(color=srgb('#08090a'), metal=0.0, rough=0.9),
}


def master():
    path = DEST + '/M_SlsCar'
    if EAL.does_asset_exist(path):
        m = EAL.load_asset(path)
        clear_material(m)
    else:
        m = tools.create_asset('M_SlsCar', DEST, unreal.Material, unreal.MaterialFactoryNew())
    # Clear coat like the web's MeshPhysicalMaterial. Its inputs (CustomData0/1) are hidden from Python, so the
    # parameters go through a Make Material Attributes node into the material's attributes input.
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_CLEAR_COAT)
    m.set_editor_property('use_material_attributes', True)
    m.set_editor_property('two_sided', True)  # the GLB is double-sided (thin parts like mirrors and the wing)
    attrs = MEL.create_material_expression(m, unreal.MaterialExpressionMakeMaterialAttributes, -200, 0)
    pins = [str(n) for n in MEL.get_material_expression_input_names(attrs)]
    y = [0]

    def param(cls, name, value, pin):
        n = MEL.create_material_expression(m, cls, -600, y[0])
        y[0] += 120
        n.set_editor_property('parameter_name', name)
        n.set_editor_property('default_value', value)
        target = next((p for p in pins if p.replace(' ', '').lower() == pin.lower()), None)
        if not target or not MEL.connect_material_expressions(n, '', attrs, target):
            unreal.log_warning('SLS setup: M_SlsCar: Eingang %s fehlt (%s)' % (pin, pins))

    param(unreal.MaterialExpressionVectorParameter, 'Color', unreal.LinearColor(0.5, 0.5, 0.5, 1), 'BaseColor')
    param(unreal.MaterialExpressionScalarParameter, 'Metal', 0.0, 'Metallic')
    param(unreal.MaterialExpressionScalarParameter, 'Rough', 0.5, 'Roughness')
    param(unreal.MaterialExpressionVectorParameter, 'Emissive', unreal.LinearColor(0, 0, 0, 1), 'EmissiveColor')
    param(unreal.MaterialExpressionScalarParameter, 'ClearCoat', 0.0, 'ClearCoat')
    param(unreal.MaterialExpressionScalarParameter, 'ClearCoatRough', 0.04, 'ClearCoatRoughness')
    MEL.connect_material_property(attrs, '', unreal.MaterialProperty.MP_MATERIAL_ATTRIBUTES)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m)
    return m


def instance(parent, spec):
    name = 'MI_SlsCar_' + spec['name']
    path = DEST + '/' + name
    mi = EAL.load_asset(path) if EAL.does_asset_exist(path) else tools.create_asset(
        name, DEST, unreal.MaterialInstanceConstant, unreal.MaterialInstanceConstantFactoryNew())
    mi.set_editor_property('parent', parent)
    web = WEB.get(spec['name'], {})
    color = web.get('color', spec['color'])
    emissive = web.get('emissive', spec['emissive'])
    MEL.set_material_instance_vector_parameter_value(mi, 'Color', unreal.LinearColor(color[0], color[1], color[2], 1))
    MEL.set_material_instance_scalar_parameter_value(mi, 'Metal', web.get('metal', spec['metal']))
    MEL.set_material_instance_scalar_parameter_value(mi, 'Rough', web.get('rough', spec['rough']))
    MEL.set_material_instance_scalar_parameter_value(mi, 'ClearCoat', web.get('coat', 0.0))
    MEL.set_material_instance_vector_parameter_value(mi, 'Emissive', unreal.LinearColor(emissive[0], emissive[1], emissive[2], 1))
    MEL.update_material_instance(mi)
    EAL.save_loaded_asset(mi)
    return mi


def import_mesh(file_name, folder):
    t = unreal.AssetImportTask()
    t.filename = os.path.join(CAR_SRC, file_name)
    t.destination_path = folder
    t.automated = True
    t.replace_existing = True
    t.save = False
    tools.import_asset_tasks([t])
    for path in EAL.list_assets(folder, recursive=True, include_folder=False):
        a = EAL.load_asset(path)
        if isinstance(a, unreal.StaticMesh):
            return a
    raise RuntimeError('kein StaticMesh aus %s' % file_name)


def mesh(name, lods, mats):
    """Imports LOD0..n of one part and puts them into /Game/Cars/<name> (refilled in place on a re-run)."""
    sms = unreal.get_editor_subsystem(unreal.StaticMeshEditorSubsystem)
    tmp = DEST + '/Import'
    if EAL.does_directory_exist(tmp):
        EAL.delete_directory(tmp)
    parts = [import_mesh('%s.glb' % f, '%s/%d' % (tmp, i)) for i, f in enumerate(lods)]
    dest = DEST + '/' + name
    if EAL.does_asset_exist(dest):
        m = EAL.load_asset(dest)
        # start the slot list afresh, otherwise every re-run appends the imported slots again
        m.set_editor_property('static_materials', [])
        sms.set_lod_from_static_mesh(m, 0, parts[0], 0, True)
    else:
        EAL.rename_asset(parts[0].get_path_name(), dest)
        m = EAL.load_asset(dest)
    for i, lod in enumerate(parts[1:], start=1):
        sms.set_lod_from_static_mesh(m, i, lod, 0, True)
    # Interchange names the slots after the glTF materials (paint, glass, tyre …)
    for i, slot in enumerate(m.get_editor_property('static_materials')):
        slot_name = str(slot.get_editor_property('material_slot_name'))
        mi = mats.get(slot_name) or next((v for k, v in mats.items() if slot_name.lower().startswith(k.lower())), None)
        if mi:
            m.set_material(i, mi)
        else:
            unreal.log_warning('SLS setup: %s: kein Material für Slot %s' % (name, slot_name))
    m.set_editor_property('light_map_resolution', 32)
    EAL.save_loaded_asset(m)
    b = m.get_bounding_box()
    log('SLS setup: %s (%d LODs, %d Slots) Box min %s max %s' % (dest, m.get_num_lods(), len(m.get_editor_property('static_materials')), b.min, b.max))
    if EAL.does_directory_exist(tmp):
        EAL.delete_directory(tmp)
    return m


def car():
    info_path = os.path.join(CAR_SRC, 'car.json')
    if not os.path.exists(info_path):
        raise RuntimeError('%s fehlt (node unreal/tools/export-car.ts)' % info_path)
    info = json.load(open(info_path))
    log('SLS setup: car from %s' % CAR_SRC)
    parent = master()
    log('SLS setup: M_SlsCar')
    mats = {spec['name']: instance(parent, spec) for spec in info['materials']}
    log('SLS setup: %d car materials' % len(mats))
    mesh('SM_SlsCar_Body', ['SM_SlsCar_Body_LOD0', 'SM_SlsCar_Body_LOD1', 'SM_SlsCar_Body_LOD2'], mats)
    mesh('SM_SlsCar_Wheel', ['SM_SlsCar_Wheel_LOD0', 'SM_SlsCar_Wheel_LOD1'], mats)
    mesh('SM_SlsCar_Caliper', ['SM_SlsCar_Caliper'], mats)
    log('SLS setup: car done')


if __name__ == '__main__':
    car()
    if os.environ.get('SLS_QUIT'):
        unreal.SystemLibrary.quit_editor()
