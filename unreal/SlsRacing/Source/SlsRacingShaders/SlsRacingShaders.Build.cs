using UnrealBuildTool;

/** Maps Shaders/ to the virtual path /SlsRacing so the materials' Custom nodes can include SlsPbr.ush. */
public class SlsRacingShaders : ModuleRules
{
	public SlsRacingShaders(ReadOnlyTargetRules Target) : base(Target)
	{
		PCHUsage = PCHUsageMode.UseExplicitOrSharedPCHs;
		PrivateDependencyModuleNames.AddRange(new string[] { "Core", "RenderCore", "Projects" });
	}
}
