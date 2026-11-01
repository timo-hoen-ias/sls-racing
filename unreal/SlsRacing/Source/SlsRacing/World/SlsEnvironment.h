#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "SlsWeather.h"
#include "SlsEnvironment.generated.h"

class ADirectionalLight;
class ASkyLight;
class AExponentialHeightFog;
class APostProcessVolume;
class ASlsPrecipitation;
class UVolumetricCloudComponent;
class USkyAtmosphereComponent;

/**
 * Time of day and weather (web: src/render/daylight.ts, src/weather/), done with Unreal's own sky: Sky Atmosphere
 * colours the sky from the sun angle, Volumetric Clouds, Exponential Height Fog, a real-time captured Sky Light and
 * auto exposure in an unbound post process volume. The sun follows the web game's clock (Saarlouis, mid-September);
 * a moon lights the night. Weather (FSlsWeather, port of weather.ts) clouds the sky, wets the roads (MPC_Sls Wx),
 * lets rain or snow fall (ASlsPrecipitation) and hands the car its grip.
 */
UCLASS()
class SLSRACING_API USlsEnvironment : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool IsTickableInEditor() const override { return false; }

	static USlsEnvironment* Get(const UObject* WorldContext);

	/** Spawns sun, moon, atmosphere, clouds, sky light, fog, post process and precipitation (GameMode::StartPlay). */
	void SpawnSky();

	/** Local clock hours 0..24. */
	double Hours = 16.5;
	/** Blends to a time (3.5 h per second, like the web game); Set jumps. */
	void GoTo(double H);
	void Set(double H);
	/** Game hours per real minute, 0 = clock stands. */
	double CycleSpeed = 0;
	/** Manual cloud cover 0..1 (sky.overcast); the weather adds its own. */
	float Overcast = 0;
	/** Light factors (sky.sun, sky.ambient, sky.exposure, sky.fog). */
	float SunScale = 1, AmbientScale = 1, ExposureBias = 0, FogScale = 1;

	FSlsWeather Weather;
	/** Overall cloud cover (manual and weather). */
	float CloudCover() const { return FMath::Max(Overcast, Weather.Overcast); }
	/** Sun direction in Unreal space (towards the sun) and its elevation sine. */
	FVector SunDirUE() const;
	static FVector SunDirectionWeb(double Hours);
	/** Daylight factor 0 (night) .. 1 (day), for precipitation brightness and lights. */
	float DayFactor() const;

private:
	void Apply();
	TOptional<double> Target;
	UPROPERTY() TObjectPtr<ADirectionalLight> Sun;
	UPROPERTY() TObjectPtr<ADirectionalLight> Moon;
	UPROPERTY() TObjectPtr<ASkyLight> SkyLight;
	UPROPERTY() TObjectPtr<AExponentialHeightFog> Fog;
	UPROPERTY() TObjectPtr<APostProcessVolume> Post;
	UPROPERTY() TObjectPtr<ASlsPrecipitation> Precip;
	UPROPERTY() TObjectPtr<UVolumetricCloudComponent> Clouds;
	UPROPERTY() TObjectPtr<USkyAtmosphereComponent> Atmosphere;
	float RecaptureIn = 0;
};
