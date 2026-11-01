#include "SlsGameMode.h"
#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "World/SlsEnvironment.h"
#include "Game/SlsHUD.h"
#include "Vehicle/SlsCarPawn.h"
#include "Components/SphereComponent.h"
#include "Engine/World.h"
#include "GameFramework/FloatingPawnMovement.h"
#include "HAL/IConsoleManager.h"

static float GFlySpeed = 60.f;
static FAutoConsoleVariableRef CVarFlySpeed(TEXT("fly.speed"), GFlySpeed, TEXT("Tempo der freien Kamera in m/s"));

ASlsFlyPawn::ASlsFlyPawn()
{
	PrimaryActorTick.bCanEverTick = true;
	// The camera must not push against road colliders or be caught by the surface rays.
	GetCollisionComponent()->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	bAddDefaultMovementBindings = true;
}

void ASlsFlyPawn::Tick(float DeltaSeconds)
{
	Super::Tick(DeltaSeconds);
	if (UFloatingPawnMovement* M = Cast<UFloatingPawnMovement>(GetMovementComponent()))
	{
		M->MaxSpeed = GFlySpeed * 100.f;
		M->Acceleration = GFlySpeed * 400.f;
		M->Deceleration = GFlySpeed * 800.f;
	}
}

ASlsGameMode::ASlsGameMode()
{
	// The car is the player; the free camera stays available through the 'fly' command.
	DefaultPawnClass = ASlsCarPawn::StaticClass();
	HUDClass = ASlsHUD::StaticClass();
}

void ASlsGameMode::StartPlay()
{
	// Sun, moon, atmosphere, clouds, sky light, fog, exposure and precipitation: USlsEnvironment (time of day, weather).
	if (USlsEnvironment* E = USlsEnvironment::Get(this)) E->SpawnSky();
	Super::StartPlay();
}

APawn* ASlsGameMode::SpawnDefaultPawnFor_Implementation(AController* NewPlayer, AActor* StartSpot)
{
	USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this);
	FVector Loc(0, 0, 50000.0);
	FRotator Rot = FRotator::ZeroRotator;
	if (S && S->IsReady())
	{
		// Web heading: 0 = north, clockwise. Unreal yaw 0 = +X (east), -90 = north (-Y).
		Loc = S->SpawnUE() + FVector(0, 0, 300.0);
		Rot = FRotator(-10.0, FMath::RadiansToDegrees(S->Info().SpawnHeading) - 90.0, 0.0);
	}
	FActorSpawnParameters P;
	P.Instigator = GetInstigator();
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	APawn* Pawn = GetWorld()->SpawnActor<APawn>(GetDefaultPawnClassForController(NewPlayer), Loc, Rot, P);
	if (NewPlayer) NewPlayer->SetControlRotation(Rot);
	return Pawn;
}
