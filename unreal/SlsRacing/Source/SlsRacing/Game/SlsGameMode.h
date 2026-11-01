#pragma once

#include "CoreMinimal.h"
#include "GameFramework/GameModeBase.h"
#include "GameFramework/DefaultPawn.h"
#include "SlsGameMode.generated.h"

/** Free camera to inspect the world (console 'fly', WASD + mouse, E/Q up/down; fly.speed). */
UCLASS()
class SLSRACING_API ASlsFlyPawn : public ADefaultPawn
{
	GENERATED_BODY()
public:
	ASlsFlyPawn();
	virtual void Tick(float DeltaSeconds) override;
};

/**
 * Starts the world from code (no map assets yet): the sky through USlsEnvironment and the car at the web build's spawn point.
 * The tiles stream in through USlsWorldSubsystem.
 */
UCLASS()
class SLSRACING_API ASlsGameMode : public AGameModeBase
{
	GENERATED_BODY()
public:
	ASlsGameMode();
	virtual void StartPlay() override;
	virtual APawn* SpawnDefaultPawnFor_Implementation(AController* NewPlayer, AActor* StartSpot) override;
};
