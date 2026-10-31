#pragma once

#include "CoreMinimal.h"

DECLARE_LOG_CATEGORY_EXTERN(LogSls, Log, All);

/** Collision channels (Config/DefaultEngine.ini). Same split as the web game's Rapier groups (carPhysics.ts). */
// Object type of road, pavement and path surfaces: only the wheels ride on them (ROAD_GROUPS).
#define ECC_SlsRoad ECC_GameTraceChannel1
// Wheel rays: hit everything, roads included.
#define ECC_SlsWheel ECC_GameTraceChannel2
// Chassis rays and the car body: pass through road surfaces (CAR_GROUPS).
#define ECC_SlsChassis ECC_GameTraceChannel3
