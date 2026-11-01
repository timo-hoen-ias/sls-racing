#include "SlsPrecipitation.h"
#include "ProceduralMeshComponent.h"
#include "Materials/MaterialInterface.h"

ASlsPrecipitation::ASlsPrecipitation()
{
	PrimaryActorTick.bCanEverTick = false;
	Rain = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Rain"));
	SetRootComponent(Rain);
	Snow = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Snow"));
	Snow->SetupAttachment(Rain);
	for (UProceduralMeshComponent* M : {Rain.Get(), Snow.Get()})
	{
		M->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		M->SetCastShadow(false);
		// The mesh sits at the world origin while the material wraps it around the camera: never cull it.
		M->SetBoundsScale(10000.f);
	}
}

void ASlsPrecipitation::BeginPlay()
{
	Super::BeginPlay();
	Build(Rain, 6000, 11, TEXT("M_SlsRain"));
	Build(Snow, 5000, 23, TEXT("M_SlsSnow"));
	SetActive(false);
}

void ASlsPrecipitation::Build(UProceduralMeshComponent* M, int32 Count, int32 Seed, const TCHAR* Material)
{
	FRandomStream R(Seed);
	const float Box = 4000.f; // cm, matches Precip.z
	TArray<FVector> V; TArray<int32> T; TArray<FVector> N; TArray<FVector2D> UV; TArray<FColor> C; TArray<FProcMeshTangent> Tan;
	V.Reserve(Count * 4); UV.Reserve(Count * 4); C.Reserve(Count * 4); T.Reserve(Count * 6);
	static const FVector2D Corner[4] = {FVector2D(-1, -1), FVector2D(1, -1), FVector2D(1, 1), FVector2D(-1, 1)};
	for (int32 I = 0; I < Count; I++)
	{
		const FVector P(R.FRandRange(0, Box), R.FRandRange(0, Box), R.FRandRange(0, Box));
		const uint8 W = uint8(R.RandRange(0, 255));
		const int32 B = V.Num();
		for (int32 K = 0; K < 4; K++) { V.Add(P); UV.Add(Corner[K]); C.Add(FColor(W, 0, 0, 255)); N.Add(FVector::UpVector); }
		T.Append({B, B + 1, B + 2, B, B + 2, B + 3});
	}
	M->CreateMeshSection(0, V, T, N, UV, C, Tan, false);
	const FString Path = FString::Printf(TEXT("/Game/Materials/%s.%s"), Material, Material);
	if (UMaterialInterface* Mat = LoadObject<UMaterialInterface>(nullptr, *Path, nullptr, LOAD_NoWarn | LOAD_Quiet)) M->SetMaterial(0, Mat);
}

void ASlsPrecipitation::SetActive(bool bOn)
{
	Rain->SetVisibility(bOn);
	Snow->SetVisibility(bOn);
}
