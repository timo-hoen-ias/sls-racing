// Compile check of Shaders/SlsPbr.ush without Unreal: the same calls the Custom nodes of sls_setup.py make,
// wrapped in a pixel shader. unreal/tools/check-shaders.sh compiles it with DXC (DXIL + SPIR-V).
#include "/SlsRacing/SlsPbr.ush"
Texture2D SA; Texture2D SN; Texture2D SR; SamplerState SASampler;
Texture2D NA; Texture2D NN; Texture2D NR; SamplerState NASampler;
Texture2D BA; Texture2D BN; Texture2D BR; SamplerState BASampler;
Texture2D WN; SamplerState WNSampler;
Texture2D PM; SamplerState PMSampler;
cbuffer C { float4 P0, P1, P2, P3, Wx; float T; float3 Cam; };

float3 Ground(float3 WP, float3 VN, float2 UV0, float2 UV1, float2 UV2, float4 VC, inout float Rough, inout float3 NormalWS)
{
SlsCtx c = SlsBegin(P0, P1, P2, P3);
float3 p = SlsToWeb(WP);
float3 n = normalize(SlsDirToWeb(VN));
SlsGround(SLS_TEX_NODE, c, p, UV0, UV1, UV2, SlsSrgbToLinear(VC.rgb));
SlsWeather(c, p, n, Wx, T, 0.6, 1.00, 0.55, false, 0.0, 0.0);
return SlsEnd(c, p, n, 1.0, Rough, NormalWS);
}
float3 Road(float3 WP, float3 VN, float2 UV0, float2 UV1, inout float Rough, inout float3 NormalWS)
{
SlsCtx c = SlsBegin(P0, P1, P2, P3);
float3 p = SlsToWeb(WP);
float3 n = normalize(SlsDirToWeb(VN));
SlsRoad(SLS_TEX_NODE, c, p, UV0, UV1);
SlsWeather(c, p, n, Wx, T, 1.0, 0.9, 0.55, true, saturate(UV0.x), PM.Sample(PMSampler, p.xz / SLS_PUDDLE_SIZE).r);
return SlsEnd(c, p, n, 1.0, Rough, NormalWS);
}
float3 Mark(float3 WP, float3 VN, inout float Rough, inout float3 NormalWS, inout float Keep)
{
SlsCtx c = SlsBegin(P0, P1, P2, P3);
float3 p = SlsToWeb(WP);
float3 n = normalize(SlsDirToWeb(VN));
Keep = SlsMarking(SLS_TEX_NODE, c, p);
return SlsEnd(c, p, n, 1.0, Rough, NormalWS);
}
float3 Side(float3 WP, float3 VN, inout float Rough, inout float3 NormalWS)
{
SlsCtx c = SlsBegin(P0, P1, P2, P3);
float3 p = SlsToWeb(WP);
float3 n = normalize(SlsDirToWeb(VN));
SlsSidewalk(SLS_TEX_NODE, c, p, n);
return SlsEnd(c, p, n, 1.0, Rough, NormalWS);
}
float3 Detail(float3 WP, float3 VN, float4 VC, inout float Rough, inout float3 NormalWS)
{
SlsCtx c = SlsBegin(P0, P1, P2, P3);
float3 p = SlsToWeb(WP);
float3 n = normalize(SlsDirToWeb(VN));
float l = SlsPaintedMetal(SLS_TEX_NODE, c, p, n);
if (c.Debug < 0.5) c.Albedo = SlsSrgbToLinear(VC.rgb) * l;
SlsWeather(c, p, n, Wx, T, 0.50, 0.80, 0.60, false, 0.0, 0.0);
return SlsEnd(c, p, n, 0.75, Rough, NormalWS);
}
float3 Water(float3 WP)
{
float2 uv = WP.xy / 900.0;
float3 a = WN.Sample(WNSampler, uv + float2(0.012, 0.007) * T).xyz * 2.0 - 1.0;
float3 b = WN.Sample(WNSampler, uv * 1.7 + float2(-0.009, 0.013) * T).xyz * 2.0 - 1.0;
return normalize(float3((a.xy + b.xy) * 0.35, 1.0));
}
struct In { float3 WP : P; float3 VN : N; float2 a : A; float2 b : B; float2 d : D; float4 VC : COLOR; };
float4 main(In i) : SV_Target
{
  float r = 0, k = 0; float3 nw = 0;
  float3 s = Ground(i.WP, i.VN, i.a, i.b, i.d, i.VC, r, nw) + Road(i.WP, i.VN, i.a, i.b, r, nw) + Mark(i.WP, i.VN, r, nw, k) + Side(i.WP, i.VN, r, nw) + Detail(i.WP, i.VN, i.VC, r, nw) + Water(i.WP);
  return float4(s + nw, r + k);
}
