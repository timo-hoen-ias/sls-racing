using UnrealBuildTool;

public class SlsRacingTarget : TargetRules
{
	public SlsRacingTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Game;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.AddRange(new string[] { "SlsRacing", "SlsRacingShaders" });
	}
}
