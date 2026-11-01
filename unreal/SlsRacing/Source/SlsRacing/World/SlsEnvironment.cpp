#include "SlsEnvironment.h"
#include "SlsPrecipitation.h"
#include "SlsRacing.h"
#include "Vehicle/SlsCarPawn.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/VolumetricCloudComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/PostProcessVolume.h"
#include "Engine/SkyLight.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "Kismet/KismetMaterialLibrary.h"
#include "Materials/MaterialInterface.h"
#include "Materials/MaterialParameterCollection.h"

namespace
{
	// daylight.ts: Saarlouis, mid-September (sunrise ~7:10, sunset ~19:55 local summer time).
	constexpr double Lat = 49.32 * PI / 180.0;
	constexpr double Decl = 3.0 * PI / 180.0;
	constexpr double SolarNoon = 13.55;
}

bool USlsEnvironment::ShouldCreateSubsystem(UObject* Outer) const
{
	const UWorld* W = Cast<UWorld>(Outer);
	return W && (W->WorldType == EWorldType::Game || W->WorldType == EWorldType::PIE);
}

TStatId USlsEnvironment::GetStatId() const { RETURN_QUICK_DECLARE_CYCLE_STAT(USlsEnvironment, STATGROUP_Tickables); }

USlsEnvironment* USlsEnvironment::Get(const UObject* WorldContext)
{
	const UWorld* W = WorldContext ? WorldContext->GetWorld() : nullptr;
	return W ? W->GetSubsystem<USlsEnvironment>() : nullptr;
}

FVector USlsEnvironment::SunDirectionWeb(double H)
{
	const double Ha = (H - SolarNoon) * 15.0 * PI / 180.0;
	const double SinEl = FMath::Sin(Lat) * FMath::Sin(Decl) + FMath::Cos(Lat) * FMath::Cos(Decl) * FMath::Cos(Ha);
	const double El = FMath::Asin(SinEl);
	const double Az = FMath::Atan2(FMath::Sin(Ha), FMath::Cos(Ha) * FMath::Sin(Lat) - FMath::Tan(Decl) * FMath::Cos(Lat)) + PI;
	return FVector(FMath::Sin(Az) * FMath::Cos(El), FMath::Sin(El), -FMath::Cos(Az) * FMath::Cos(El));
}

FVector USlsEnvironment::SunDirUE() const
{
	const FVector W = SunDirectionWeb(Hours);
	return FVector(W.X, W.Z, W.Y); // web x east, y up, z south → Unreal X east, Y south, Z up
}

float USlsEnvironment::DayFactor() const { return FMath::SmoothStep(-0.12f, 0.12f, float(SunDirUE().Z)); }

void USlsEnvironment::GoTo(double H)
{
	H = FMath::Fmod(FMath::Fmod(H, 24.0) + 24.0, 24.0);
	Target = H < Hours ? H + 24.0 : H;
}

void USlsEnvironment::Set(double H)
{
	Target.Reset();
	Hours = FMath::Fmod(FMath::Fmod(H, 24.0) + 24.0, 24.0);
	Apply();
}

void USlsEnvironment::SpawnSky()
{
	UWorld* W = GetWorld();
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	auto MakeDirectional = [&](int32 Index) {
		ADirectionalLight* L = W->SpawnActor<ADirectionalLight>(FVector::ZeroVector, FRotator(-40.f, 0.f, 0.f), P);
		L->SetMobility(EComponentMobility::Movable);
		if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(L->GetLightComponent()))
		{
			C->SetAtmosphereSunLight(true);
			C->SetAtmosphereSunLightIndex(Index);
			C->SetDynamicShadowDistanceMovableLight(40000.f);
			C->SetCastShadows(true);
		}
		return L;
	};
	Sun = MakeDirectional(0);
	Moon = MakeDirectional(1);
	if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(Moon->GetLightComponent()))
	{
		C->SetLightColor(FLinearColor(0.55f, 0.65f, 1.f));
		C->SetDynamicShadowDistanceMovableLight(15000.f);
	}

	AActor* Sky = W->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, P);
	Atmosphere = NewObject<USkyAtmosphereComponent>(Sky, TEXT("Atmosphere"));
	Sky->SetRootComponent(Atmosphere);
	Atmosphere->RegisterComponent();
	// Volumetric clouds with the engine's stock cloud material (Unreal technique instead of the web's cloud shader).
	Clouds = NewObject<UVolumetricCloudComponent>(Sky, TEXT("Clouds"));
	Clouds->SetupAttachment(Atmosphere);
	if (UMaterialInterface* CM = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineSky/VolumetricClouds/m_SimpleVolumetricCloud_Inst.m_SimpleVolumetricCloud_Inst"), nullptr, LOAD_NoWarn | LOAD_Quiet))
		Clouds->SetMaterial(CM);
	Clouds->RegisterComponent();

	// Captured scene, recaptured every 2 s in Apply(). Real-time capture lit nothing on Linux/Vulkan (RX 7800 XT,
	// UE 5.8): shadow sides of houses and the car were black and sky.ambient changed nothing; light.sky realtime 1
	// switches it back on to test other systems.
	SkyLight = W->SpawnActorDeferred<ASkyLight>(ASkyLight::StaticClass(), FTransform::Identity, nullptr, nullptr, ESpawnActorCollisionHandlingMethod::AlwaysSpawn);
	SkyLight->GetLightComponent()->SetMobility(EComponentMobility::Movable);
	SkyLight->GetLightComponent()->bRealTimeCapture = false;
	SkyLight->FinishSpawning(FTransform::Identity);
	SkyLight->GetLightComponent()->RecaptureSky();

	Fog = W->SpawnActor<AExponentialHeightFog>(FVector(0, 0, 18000.f), FRotator::ZeroRotator, P);
	Fog->GetComponent()->SetFogDensity(0.004f);
	Fog->GetComponent()->SetVolumetricFog(true);

	// Auto exposure over the whole world, wide enough for night streets and noon sun.
	Post = W->SpawnActor<APostProcessVolume>(FVector::ZeroVector, FRotator::ZeroRotator, P);
	Post->bUnbound = true;
	FPostProcessSettings& S = Post->Settings;
	S.bOverride_AutoExposureMinBrightness = true; S.AutoExposureMinBrightness = -3.f;
	S.bOverride_AutoExposureMaxBrightness = true; S.AutoExposureMaxBrightness = 15.f;
	S.bOverride_AutoExposureBias = true; S.AutoExposureBias = 0.f;

	Precip = W->SpawnActor<ASlsPrecipitation>(FVector::ZeroVector, FRotator::ZeroRotator, P);
	Apply();
}

void USlsEnvironment::Tick(float Dt)
{
	if (!Sun) return;
	if (Target.IsSet())
	{
		const double Step = Dt * 3.5;
		if (FMath::Abs(*Target - Hours) <= Step) { Hours = FMath::Fmod(*Target, 24.0); Target.Reset(); }
		else Hours += Step; // may pass 24 while blending towards a target after midnight; Apply wraps
	}
	else if (CycleSpeed > 0) Hours = FMath::Fmod(Hours + Dt * CycleSpeed / 60.0, 24.0);
	Weather.Update(Dt);
	Apply();
}

void USlsEnvironment::Apply()
{
	UWorld* W = GetWorld();
	if (!W || !Sun) return;
	const double H = FMath::Fmod(Hours, 24.0);
	const FVector WebSun = SunDirectionWeb(H);
	const FVector SunUE(WebSun.X, WebSun.Z, WebSun.Y);
	const float Cover = CloudCover();
	const float Up = float(SunUE.Z);
	// The light travels from the sun: the actor faces away from it.
	Sun->SetActorRotation((-SunUE).Rotation());
	if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		const float Day = FMath::SmoothStep(-0.04f, 0.1f, Up);
		C->SetIntensity(10.f * SunScale * Day * (1.f - 0.8f * Cover));
		C->SetVisibility(Day > 0.001f);
	}
	// Moon: opposite the sun, a little higher, only at night.
	const FVector MoonDir = FVector(-SunUE.X, -SunUE.Y, FMath::Abs(SunUE.Z) * 0.6 + 0.35).GetSafeNormal();
	Moon->SetActorRotation((-MoonDir).Rotation());
	if (UDirectionalLightComponent* C = Cast<UDirectionalLightComponent>(Moon->GetLightComponent()))
	{
		const float Night = 1.f - FMath::SmoothStep(-0.15f, 0.02f, Up);
		C->SetIntensity(0.12f * Night * (1.f - 0.7f * Cover));
		C->SetVisibility(Night > 0.001f);
	}
	if (SkyLight)
	{
		SkyLight->GetLightComponent()->SetIntensity(AmbientScale * FMath::Lerp(1.f, 0.7f, Cover));
		// The captured cubemap follows sun and clouds through this periodic recapture (no real-time capture, see SpawnSky).
		RecaptureIn -= W->GetDeltaSeconds();
		if (RecaptureIn <= 0) { SkyLight->GetLightComponent()->RecaptureSky(); RecaptureIn = 2.f; }
	}
	if (Fog)
	{
		const float Haze = 0.004f + 0.012f * Cover + 0.02f * FMath::Max(Weather.Rain, Weather.Snow);
		Fog->GetComponent()->SetFogDensity(Haze * FogScale);
	}
	if (Post) Post->Settings.AutoExposureBias = ExposureBias;
	// Roads and precipitation read the weather from the parameter collection.
	if (UMaterialParameterCollection* MPC = LoadObject<UMaterialParameterCollection>(nullptr, TEXT("/Game/Materials/MPC_Sls.MPC_Sls"), nullptr, LOAD_NoWarn | LOAD_Quiet))
	{
		UKismetMaterialLibrary::SetVectorParameterValue(W, MPC, TEXT("Wx"), FLinearColor(Weather.Wet, Weather.SnowCover, Weather.Puddles(), Weather.Rain));
		UKismetMaterialLibrary::SetVectorParameterValue(W, MPC, TEXT("Precip"), FLinearColor(Weather.Rain, Weather.Snow, 4000.f, 0.08f + 0.92f * DayFactor()));
	}
	if (Precip) Precip->SetActive(Weather.Rain > 0.01f || Weather.Snow > 0.01f);
	// Grip for every car in the world (players and later traffic).
	const FSlsSurfaceGrip G = Weather.Surface();
	for (TActorIterator<ASlsCarPawn> It(W); It; ++It) It->WeatherGrip = G;
}
