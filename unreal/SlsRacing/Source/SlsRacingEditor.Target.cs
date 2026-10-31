using UnrealBuildTool;

public class SlsRacingEditorTarget : TargetRules
{
	public SlsRacingEditorTarget(TargetInfo Target) : base(Target)
	{
		Type = TargetType.Editor;
		DefaultBuildSettings = BuildSettingsVersion.Latest;
		IncludeOrderVersion = EngineIncludeOrderVersion.Latest;
		ExtraModuleNames.Add("SlsRacing");
	}
}
