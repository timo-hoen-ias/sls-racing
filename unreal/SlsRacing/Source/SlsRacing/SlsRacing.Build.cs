using UnrealBuildTool;

public class SlsRacing : ModuleRules
{
	public SlsRacing(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PublicDependencyModuleNames.AddRange(new string[] {
			"Core", "CoreUObject", "Engine", "InputCore", "PhysicsCore", "ProceduralMeshComponent", "Json",
			"ChaosVehicles", "ChaosVehiclesCore", "EnhancedInput", "Chaos",
		});
	}
}
