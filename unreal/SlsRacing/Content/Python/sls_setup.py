# Builds the project's content from text, so nothing binary has to live in git (like going-vertical's gv_setup.py):
# the PBR atlases exported from the web game (unreal/tools/export-textures.ts → Data/textures), the Material
# Parameter Collection MPC_Sls (tex.* / ground.* / feldweg.* console commands) and the world materials. Every
# surface material is one Custom node calling the HLSL port of the web shaders (Shaders/SlsPbr.ush, included as
# /SlsRacing/SlsPbr.ush through the SlsRacingShaders module).
#   ./unreal/sls.sh setup      (runs the export, the C++ build and this script)
#   UnrealEditor SlsRacing.uproject -ExecutePythonScript="<abs path>/Content/Python/sls_setup.py"
# Re-running replaces everything in place. SLS_QUIT=1 closes the editor when done, SLS_DONE=<file> writes a marker.
import os
import unreal

PROJECT = unreal.Paths.convert_relative_path_to_full(unreal.Paths.project_dir())
TEX_SRC = os.path.join(PROJECT, 'Data', 'textures')
tools = unreal.AssetToolsHelpers.get_asset_tools()
MEL = unreal.MaterialEditingLibrary
EAL = unreal.EditorAssetLibrary
log = unreal.log
F1 = unreal.CustomMaterialOutputType.CMOT_FLOAT1
F3 = unreal.CustomMaterialOutputType.CMOT_FLOAT3
ATLASES = ('street', 'nature', 'building')
MAPS = ('albedo', 'normal', 'rh')
INCLUDE = '/SlsRacing/SlsPbr.ush'


def import_textures():
    names = ['T_Sls_%s_%s.png' % (a, m) for a in ATLASES for m in MAPS] + ['T_Sls_waternormals.jpg', 'T_Sls_puddles.png']
    missing = [n for n in names if not os.path.exists(os.path.join(TEX_SRC, n))]
    if missing:
        raise RuntimeError('Texturen fehlen in %s: %s (node unreal/tools/export-textures.ts)' % (TEX_SRC, ', '.join(missing)))
    tasks = []
    for n in names:
        t = unreal.AssetImportTask()
        t.filename = os.path.join(TEX_SRC, n)
        t.destination_path = '/Game/Textures'
        t.automated = True
        t.replace_existing = True
        t.save = False
        tasks.append(t)
    tools.import_asset_tasks(tasks)
    out = {}
    for n in names:
        name = os.path.splitext(n)[0]
        tex = unreal.load_asset('/Game/Textures/' + name)
        if name.endswith('_albedo'):
            tex.set_editor_property('srgb', True)
        elif name == 'T_Sls_puddles':
            # the mask the road shader and (later) the car's aquaplaning share: exact grey values, wraps over 180 m
            tex.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_GRAYSCALE)
            tex.set_editor_property('srgb', False)
        elif name == 'T_Sls_waternormals':
            tex.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_NORMALMAP)
            tex.set_editor_property('srgb', False)
        else:
            # packed data (normal X in R / Y in A, roughness in G / height in A): keep alpha, no colour curve
            tex.set_editor_property('compression_settings', unreal.TextureCompressionSettings.TC_BC7)
            tex.set_editor_property('srgb', False)
        tex.set_editor_property('max_texture_size', 4096)
        tex.set_editor_property('lod_group', unreal.TextureGroup.TEXTUREGROUP_WORLD)
        EAL.save_loaded_asset(tex)
        out[name] = tex
    return out


def parameter_collection():
    path = '/Game/Materials/MPC_Sls'
    if EAL.does_asset_exist(path):
        mpc = EAL.load_asset(path)
    else:
        mpc = tools.create_asset('MPC_Sls', '/Game/Materials', unreal.MaterialParameterCollection, unreal.MaterialParameterCollectionFactoryNew())
    # defaults as pbrTextures.ts / groundCommands.ts (SlsTexCommands.cpp pushes changes)
    params = []
    # Wx = weather (wetness, snow cover, puddles, rain), Precip = (rain, snow, box cm, light), set by USlsEnvironment
    for name, value in (('Pbr0', (1, 1, 1, 1)), ('Pbr1', (0.85, 1, 0, -1)), ('Pbr2', (1, 1, 1, 1)), ('Pbr3', (0, 0, 0, 0)),
                        ('Wx', (0, 0, 0, 0)), ('Precip', (0, 0, 4000, 1))):
        p = unreal.CollectionVectorParameter()
        p.set_editor_property('parameter_name', name)
        p.set_editor_property('default_value', unreal.LinearColor(*value))
        params.append(p)
    mpc.set_editor_property('vector_parameters', params)
    EAL.save_loaded_asset(mpc)
    return mpc


def material_in_place(name):
    path = '/Game/Materials/' + name
    if EAL.does_asset_exist(path):
        m = EAL.load_asset(path)
        MEL.delete_all_material_expressions(m)
        return m
    return tools.create_asset(name, '/Game/Materials', unreal.Material, unreal.MaterialFactoryNew())


class Graph:
    """Small helper to lay out and wire material expressions."""

    def __init__(self, m):
        self.m = m
        self.y = 0

    def node(self, cls, **props):
        n = MEL.create_material_expression(self.m, cls, -1200, self.y)
        self.y += 110
        for k, v in props.items():
            n.set_editor_property(k, v)
        return n

    def custom(self, code, out_type, ins, outs=()):
        n = self.node(unreal.MaterialExpressionCustom)
        n.set_editor_property('code', code)
        n.set_editor_property('output_type', out_type)
        n.set_editor_property('include_file_paths', [INCLUDE])
        cis = []
        for nm, _ in ins:
            ci = unreal.CustomInput()
            ci.set_editor_property('input_name', nm)
            cis.append(ci)
        n.set_editor_property('inputs', cis)
        cos = []
        for nm, t in outs:
            co = unreal.CustomOutput()
            co.set_editor_property('output_name', nm)
            co.set_editor_property('output_type', t)
            cos.append(co)
        n.set_editor_property('additional_outputs', cos)
        for nm, (src, out) in ins:
            MEL.connect_material_expressions(src, out, n, nm)
        return n

    def out(self, src, prop, out=''):
        MEL.connect_material_property(src, out, prop)


def surface_inputs(g, tex, mpc, uvs=0, vcol=False, puddles=False):
    """WP, VN, P0..P3, Wx, T, the nine atlas textures (SA SN SR NA NN NR BA BN BR), UV0..UVn, VC, PM (puddles)."""
    ins = [('WP', (g.node(unreal.MaterialExpressionWorldPosition), '')),
           ('VN', (g.node(unreal.MaterialExpressionVertexNormalWS), ''))]
    for i in range(4):
        ins.append(('P%d' % i, (g.node(unreal.MaterialExpressionCollectionParameter, collection=mpc, parameter_name='Pbr%d' % i), '')))
    ins.append(('Wx', (g.node(unreal.MaterialExpressionCollectionParameter, collection=mpc, parameter_name='Wx'), '')))
    ins.append(('T', (g.node(unreal.MaterialExpressionTime), '')))
    for a in ATLASES:
        for k, mp in zip('ANR', MAPS):
            ins.append((a[0].upper() + k, (g.node(unreal.MaterialExpressionTextureObject, texture=tex['T_Sls_%s_%s' % (a, mp)]), '')))
    for i in range(uvs):
        ins.append(('UV%d' % i, (g.node(unreal.MaterialExpressionTextureCoordinate, coordinate_index=i), '')))
    if vcol:
        ins.append(('VC', (g.node(unreal.MaterialExpressionVertexColor), '')))
    if puddles:
        ins.append(('PM', (g.node(unreal.MaterialExpressionTextureObject, texture=tex['T_Sls_puddles']), '')))
    return ins


# The web game draws roads, markings, pavements and detail meshes with a polygon offset over the terrain. Here the
# vertices move a few centimetres towards the camera instead (more with distance, like a depth bias).
def depth_bias(g, cm, per_m):
    code = 'float3 d = Cam - WP; float l = length(d); return d / max(l, 1.0) * (%f + l * %f);' % (cm, per_m / 100.0)
    return g.custom(code, F3, [('WP', (g.node(unreal.MaterialExpressionWorldPosition), '')),
                               ('Cam', (g.node(unreal.MaterialExpressionCameraPositionWS), ''))])


def head(body):
    return ('SlsCtx c = SlsBegin(P0, P1, P2, P3);\n'
            'float3 p = SlsToWeb(WP);\n'
            'float3 n = normalize(SlsDirToWeb(VN));\n' + body)


def surface_material(name, tex, mpc, body, uvs=0, vcol=False, bias=None, masked=False, metallic=None, puddles=False, two_sided=False):
    m = material_in_place(name)
    m.set_editor_property('two_sided', two_sided)
    m.set_editor_property('tangent_space_normal', False)
    if masked:
        m.set_editor_property('blend_mode', unreal.BlendMode.BLEND_MASKED)
    g = Graph(m)
    outs = [('Rough', F1), ('NormalWS', F3)] + ([('Keep', F1)] if masked else [])
    c = g.custom(head(body), F3, surface_inputs(g, tex, mpc, uvs, vcol, puddles), outs)
    g.out(c, unreal.MaterialProperty.MP_BASE_COLOR)
    g.out(c, unreal.MaterialProperty.MP_ROUGHNESS, 'Rough')
    g.out(c, unreal.MaterialProperty.MP_NORMAL, 'NormalWS')
    if masked:
        g.out(c, unreal.MaterialProperty.MP_OPACITY_MASK, 'Keep')
    if metallic is not None:
        g.out(g.node(unreal.MaterialExpressionConstant, r=metallic), unreal.MaterialProperty.MP_METALLIC)
    if bias:
        g.out(depth_bias(g, *bias), unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m)
    log('SLS setup: %s' % name)
    return m


# Weather per surface as weatherMaterials.ts: SlsWeather(c, p, n, Wx, T, wet, snow, upFrom, road, roadX, puddle).
def wx(wet, snow, up=0.55):
    return 'SlsWeather(c, p, n, Wx, T, %.2f, %.2f, %.2f, false, 0.0, 0.0);\n' % (wet, snow, up)


END = 'return SlsEnd(c, p, n, 1.0, Rough, NormalWS);'


def world_materials(tex, mpc):
    surface_material('M_SlsGround', tex, mpc,
                     'SlsGround(SLS_TEX_NODE, c, p, UV0, UV1, UV2, SlsSrgbToLinear(VC.rgb));\n' + wx(0.6, 1.0) + END, uvs=3, vcol=True)
    surface_material('M_SlsRoad', tex, mpc,
                     'SlsRoad(SLS_TEX_NODE, c, p, UV0, UV1);\n'
                     'SlsWeather(c, p, n, Wx, T, 1.0, 0.9, 0.55, true, saturate(UV0.x), PM.Sample(PMSampler, p.xz / SLS_PUDDLE_SIZE).r);\n' + END,
                     uvs=2, bias=(2.0, 0.02), puddles=True)
    surface_material('M_SlsMarking', tex, mpc,
                     'Keep = SlsMarking(SLS_TEX_NODE, c, p);\n' + wx(0.8, 0.9) + END, bias=(4.0, 0.04), masked=True)
    surface_material('M_SlsSidewalk', tex, mpc,
                     'SlsSidewalk(SLS_TEX_NODE, c, p, n);\n' + wx(0.9, 1.0) + END, bias=(1.0, 0.01))
    surface_material('M_SlsDetail', tex, mpc,
                     'float l = SlsPaintedMetal(SLS_TEX_NODE, c, p, n);\n'
                     'if (c.Debug < 0.5) c.Albedo = SlsSrgbToLinear(VC.rgb) * l;\n' + wx(0.5, 0.8, 0.6) +
                     'return SlsEnd(c, p, n, 0.75, Rough, NormalWS);', vcol=True, bias=(1.0, 0.01), metallic=0.15)
    # buildings (until the facade shader is ported), tunnel tubes, stalls: the export's sRGB vertex colours
    surface_material('M_SlsVertexColor', tex, mpc,
                     'c.Albedo = SlsSrgbToLinear(VC.rgb);\nc.Rough = 0.8;\n' + wx(0.5, 0.9) + END, vcol=True, two_sided=True)


def light_material():
    # tunnel light strips: warm, self-lit
    m = material_in_place('M_SlsLight')
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    g = Graph(m)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(12.0, 9.5, 6.5, 1.0)), unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m)


def water_material(tex):
    # Unreal's Single Layer Water shading (absorption, scattering, refraction, screen-space reflections) with the
    # web game's water normals panning in two directions; water stays flat (project rule), only the normal moves.
    m = material_in_place('M_SlsWater')
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_SINGLE_LAYER_WATER)
    g = Graph(m)
    ins = [('WP', (g.node(unreal.MaterialExpressionWorldPosition), '')),
           ('T', (g.node(unreal.MaterialExpressionTime), '')),
           ('WN', (g.node(unreal.MaterialExpressionTextureObject, texture=tex['T_Sls_waternormals']), ''))]
    code = ('float2 uv = WP.xy / 900.0;\n'
            'float3 a = WN.Sample(WNSampler, uv + float2(0.012, 0.007) * T).xyz * 2.0 - 1.0;\n'
            'float3 b = WN.Sample(WNSampler, uv * 1.7 + float2(-0.009, 0.013) * T).xyz * 2.0 - 1.0;\n'
            'return normalize(float3((a.xy + b.xy) * 0.35, 1.0));')
    c = g.custom(code, F3, ins)
    g.out(c, unreal.MaterialProperty.MP_NORMAL)
    g.out(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.02, 0.05, 0.06, 1.0)), unreal.MaterialProperty.MP_BASE_COLOR)
    g.out(g.node(unreal.MaterialExpressionConstant, r=0.06), unreal.MaterialProperty.MP_ROUGHNESS)
    try:
        wo = g.node(unreal.MaterialExpressionSingleLayerWaterMaterialOutput)
        absorb = g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.35, 0.12, 0.08, 1.0))
        scatter = g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(0.01, 0.025, 0.02, 1.0))
        MEL.connect_material_expressions(absorb, '', wo, 'AbsorptionCoefficients')
        MEL.connect_material_expressions(scatter, '', wo, 'ScatteringCoefficients')
    except Exception as e:
        unreal.log_warning('SLS setup: water output: %s' % e)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m)


# Rain streaks and snow flakes (web: src/weather/precipitation.ts), like going-vertical's snowfall: every particle is
# a quad whose four corners sit on its seed (ASlsPrecipitation: position = seed in a box at the world origin, UV the
# corner ±1, vertex colour R = random w). All motion is in the World Position Offset: the seeds fall, wrap around
# the camera in a box of Precip.z cm, and only a share of them (rain/snow strength) is drawn.
PRECIP_HLSL = """
float w = Seed.r;
float box = max(Precip.z, 100.0);
float amount = %(amount)s;
float3 p = WP;
p.z -= T * %(speed)f * (0.75 + 0.5 * w);
p.x += sin(T * (0.6 + w) + WP.y / box * 40.0) * %(sway)f;
p.y += cos(T * (0.5 + w) + WP.x / box * 40.0) * %(sway)f;
float3 rel = (frac((p - Cam) / box + 0.5) - 0.5) * box;
float d = length(rel);
float fade = step(w, amount) * smoothstep(0.5 * box, 0.3 * box, d) * smoothstep(30.0, 150.0, d);
float3 q = Cam + rel + (Right * UV.x * %(width)f + float3(0.0, 0.0, 1.0) * UV.y * %(length)f) * fade;
return q - WP;
"""


def precip_material(name, mpc, amount, speed, sway, width, length, opacity):
    m = material_in_place(name)
    m.set_editor_property('blend_mode', unreal.BlendMode.BLEND_TRANSLUCENT)
    m.set_editor_property('shading_model', unreal.MaterialShadingModel.MSM_UNLIT)
    m.set_editor_property('two_sided', True)
    g = Graph(m)
    right = g.node(unreal.MaterialExpressionTransform,
                   transform_source_type=unreal.MaterialVectorCoordTransformSource.TRANSFORMSOURCE_VIEW,
                   transform_type=unreal.MaterialVectorCoordTransform.TRANSFORM_WORLD)
    MEL.connect_material_expressions(g.node(unreal.MaterialExpressionConstant3Vector, constant=unreal.LinearColor(1, 0, 0, 1)), '', right, '')
    precip = (g.node(unreal.MaterialExpressionCollectionParameter, collection=mpc, parameter_name='Precip'), '')
    ins = [('WP', (g.node(unreal.MaterialExpressionWorldPosition), '')), ('Cam', (g.node(unreal.MaterialExpressionCameraPositionWS), '')),
           ('UV', (g.node(unreal.MaterialExpressionTextureCoordinate, coordinate_index=0), '')), ('Seed', (g.node(unreal.MaterialExpressionVertexColor), '')),
           ('Right', (right, '')), ('T', (g.node(unreal.MaterialExpressionTime), '')), ('Precip', precip)]
    code = PRECIP_HLSL % {'amount': amount, 'speed': speed, 'sway': sway, 'width': width, 'length': length}
    wpo = MEL.create_material_expression(m, unreal.MaterialExpressionCustom, -600, 0)
    wpo.set_editor_property('code', code)
    wpo.set_editor_property('output_type', F3)
    cis = []
    for nm, _ in ins:
        ci = unreal.CustomInput()
        ci.set_editor_property('input_name', nm)
        cis.append(ci)
    wpo.set_editor_property('inputs', cis)
    for nm, (src, out) in ins:
        MEL.connect_material_expressions(src, out, wpo, nm)
    g.out(wpo, unreal.MaterialProperty.MP_WORLD_POSITION_OFFSET)
    # soft edges across the quad, brightness follows the daylight (Precip.w)
    em = g.custom('float e = 1.0 - abs(UV.x); return float3(0.75, 0.78, 0.82) * Precip.w * e;', F3,
                  [('UV', (g.node(unreal.MaterialExpressionTextureCoordinate, coordinate_index=0), '')), ('Precip', precip)])
    g.out(em, unreal.MaterialProperty.MP_EMISSIVE_COLOR)
    op = g.custom('return %f * saturate(1.0 - abs(UV.x)) * saturate(1.0 - abs(UV.y) * 0.6);' % opacity, F1,
                  [('UV', (g.node(unreal.MaterialExpressionTextureCoordinate, coordinate_index=0), ''))])
    g.out(op, unreal.MaterialProperty.MP_OPACITY)
    MEL.recompile_material(m)
    EAL.save_loaded_asset(m)


def precip_materials(mpc):
    # rain: thin 1.2 cm x 70 cm streaks falling at 9 m/s; snow: 4 cm flakes at 1.2 m/s, swaying
    precip_material('M_SlsRain', mpc, 'Precip.x', 900.0, 4.0, 0.6, 35.0, 0.35)
    precip_material('M_SlsSnow', mpc, 'Precip.y', 120.0, 60.0, 2.0, 2.0, 0.9)


def setup_done():
    if os.environ.get('SLS_DONE'):
        open(os.environ['SLS_DONE'], 'w').write('done\n')
    log('SLS setup: all done')
    if os.environ.get('SLS_QUIT'):
        unreal.SystemLibrary.quit_editor()


tex = import_textures()
mpc = parameter_collection()
world_materials(tex, mpc)
light_material()
water_material(tex)
precip_materials(mpc)
setup_done()
