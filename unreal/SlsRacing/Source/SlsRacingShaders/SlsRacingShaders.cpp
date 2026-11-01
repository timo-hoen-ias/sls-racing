#include "Misc/Paths.h"
#include "Modules/ModuleManager.h"
#include "ShaderCore.h"

/** Loads at PostConfigInit, before any shader compiles: /SlsRacing/... → <project>/Shaders/... */
class FSlsRacingShadersModule : public IModuleInterface
{
public:
	virtual void StartupModule() override
	{
		const FString Dir = FPaths::ConvertRelativePathToFull(FPaths::Combine(FPaths::ProjectDir(), TEXT("Shaders")));
		if (!AllShaderSourceDirectoryMappings().Contains(TEXT("/SlsRacing"))) AddShaderSourceDirectoryMapping(TEXT("/SlsRacing"), Dir);
	}
};

IMPLEMENT_MODULE(FSlsRacingShadersModule, SlsRacingShaders)
