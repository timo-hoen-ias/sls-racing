#include "SlsGameMode.h"
#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "Components/DirectionalLightComponent.h"
#include "Components/ExponentialHeightFogComponent.h"
#include "Components/SkyAtmosphereComponent.h"
#include "Components/SkyLightComponent.h"
#include "Components/SphereComponent.h"
#include "Engine/DirectionalLight.h"
#include "Engine/ExponentialHeightFog.h"
#include "Engine/SkyLight.h"
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
	DefaultPawnClass = ASlsFlyPawn::StaticClass();
}

void ASlsGameMode::StartPlay()
{
	UWorld* W = GetWorld();
	FActorSpawnParameters P;
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	// Sun (afternoon over Saarlouis), physical sky, sky light from the atmosphere, height fog.
	ADirectionalLight* Sun = W->SpawnActor<ADirectionalLight>(FVector::ZeroVector, FRotator(-38.f, 210.f, 0.f), P);
	Sun->SetMobility(EComponentMobility::Movable);
	if (UDirectionalLightComponent* L = Cast<UDirectionalLightComponent>(Sun->GetLightComponent()))
	{
		L->SetIntensity(10.f);
		L->SetAtmosphereSunLight(true);
		L->SetDynamicShadowDistanceMovableLight(40000.f);
	}
	AActor* Sky = W->SpawnActor<AActor>(AActor::StaticClass(), FTransform::Identity, P);
	USkyAtmosphereComponent* Atmo = NewObject<USkyAtmosphereComponent>(Sky, TEXT("Atmosphere"));
	Sky->SetRootComponent(Atmo);
	Atmo->RegisterComponent();
	ASkyLight* SkyLight = W->SpawnActor<ASkyLight>(FVector::ZeroVector, FRotator::ZeroRotator, P);
	SkyLight->GetLightComponent()->SetMobility(EComponentMobility::Movable);
	SkyLight->GetLightComponent()->bRealTimeCapture = true;
	SkyLight->GetLightComponent()->RecaptureSky();
	AExponentialHeightFog* Fog = W->SpawnActor<AExponentialHeightFog>(FVector(0, 0, 18000.f), FRotator::ZeroRotator, P);
	Fog->GetComponent()->SetFogDensity(0.004f);
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
