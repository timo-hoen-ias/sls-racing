#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SlsPrecipitation.generated.h"

class UProceduralMeshComponent;

/**
 * Rain streaks and snow flakes (web: src/weather/precipitation.ts) as one static particle mesh per kind: every
 * particle is a quad whose corners share a seed position in a 40 m box (UV = corner ±1, vertex colour R = random).
 * The materials M_SlsRain / M_SlsSnow (sls_setup.py) move everything in the World Position Offset: falling,
 * wrapping around the camera, showing only the share given by the rain / snow strength (MPC_Sls Precip).
 */
UCLASS()
class SLSRACING_API ASlsPrecipitation : public AActor
{
	GENERATED_BODY()
public:
	ASlsPrecipitation();
	virtual void BeginPlay() override;
	void SetActive(bool bOn);

	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Rain;
	UPROPERTY() TObjectPtr<UProceduralMeshComponent> Snow;

private:
	void Build(UProceduralMeshComponent* M, int32 Count, int32 Seed, const TCHAR* Material);
};
