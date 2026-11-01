#pragma once

#include "CoreMinimal.h"
#include "ChaosVehicleWheel.h"
#include "SlsWheels.generated.h"

/** Front wheel of the player car: steered, braked, driven (30 % front drive). Values from SlsCarTuning.h. */
UCLASS()
class SLSRACING_API USlsWheelFront : public UChaosVehicleWheel
{
	GENERATED_BODY()
public:
	USlsWheelFront();
};

/** Rear wheel: handbrake, driven (70 %), more grip (rearMu). */
UCLASS()
class SLSRACING_API USlsWheelRear : public UChaosVehicleWheel
{
	GENERATED_BODY()
public:
	USlsWheelRear();
};
