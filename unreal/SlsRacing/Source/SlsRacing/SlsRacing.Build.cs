using UnrealBuildTool;

public class SlsRacing : ModuleRules
{
	public SlsRacing(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] {
			"Core", "CoreUObject", "Engine", "InputCore", "PhysicsCore", "ProceduralMeshComponent", "Json",
			"ChaosVehicles", "ChaosVehiclesCore", "EnhancedInput", "Chaos", "RenderCore",
			"MeshDescription", "StaticMeshDescription",
		});
		// includes like "World/SlsWeather.h" and "SlsRacing.h" are relative to the module root
		PublicIncludePaths.Add(ModuleDirectory);
	}
}
