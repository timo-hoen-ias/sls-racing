#include "SlsWorldSubsystem.h"
#include "SlsTileActor.h"
#include "SlsTileFile.h"
#include "SlsRacing.h"
#include "Async/Async.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "Kismet/GameplayStatics.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "HAL/IConsoleManager.h"

// Same names, units and defaults as the web game's stream.* commands (src/world/streamCommands.ts, quality "hoch").
static float GStreamRadius = 720.f;
static float GStreamPhysRadius = 420.f;
static float GStreamBudget = 4.f;
static int32 GStreamInflight = 6;
static FAutoConsoleVariableRef CVarStreamRadius(TEXT("stream.radius"), GStreamRadius, TEXT("Sichtweite der Detailkacheln in m"));
static FAutoConsoleVariableRef CVarStreamPhysRadius(TEXT("stream.physradius"), GStreamPhysRadius, TEXT("Kollider nur bis zu diesem Abstand in m"));
static FAutoConsoleVariableRef CVarStreamBudget(TEXT("stream.budget"), GStreamBudget, TEXT("Hauptthread-Zeit pro Frame für Kachelaufbau in ms (mindestens ein Schritt pro Frame)"));
static FAutoConsoleVariableRef CVarStreamInflight(TEXT("stream.inflight"), GStreamInflight, TEXT("Gleichzeitig gelesene Kacheln"));
static TAutoConsoleVariable<FString> CVarDataDir(TEXT("sls.data"), TEXT(""), TEXT("Ordner der exportierten Welt (leer = <Projekt>/WorldData)"));

bool USlsWorldSubsystem::ShouldCreateSubsystem(UObject* Outer) const
{
	const UWorld* W = Cast<UWorld>(Outer);
	return W && (W->WorldType == EWorldType::Game || W->WorldType == EWorldType::PIE);
}

void USlsWorldSubsystem::Initialize(FSubsystemCollectionBase& Collection)
{
	Super::Initialize(Collection);
	FString Err;
	bReady = LoadIndex(Err);
	if (!bReady) UE_LOG(LogSls, Error, TEXT("Welt nicht geladen: %s (erst `node unreal/tools/export-tiles.ts` laufen lassen)"), *Err);
	else UE_LOG(LogSls, Log, TEXT("Welt: %d Kacheln aus %s"), World.Tiles.Num(), *DataDir());
}

void USlsWorldSubsystem::Deinitialize()
{
	UnloadAll();
	Super::Deinitialize();
}

TStatId USlsWorldSubsystem::GetStatId() const
{
	RETURN_QUICK_DECLARE_CYCLE_STAT(USlsWorldSubsystem, STATGROUP_Tickables);
}

USlsWorldSubsystem* USlsWorldSubsystem::Get(const UObject* WorldContext)
{
	const UWorld* W = WorldContext ? WorldContext->GetWorld() : nullptr;
	return W ? W->GetSubsystem<USlsWorldSubsystem>() : nullptr;
}

FString USlsWorldSubsystem::DataDir() const
{
	const FString Custom = CVarDataDir.GetValueOnGameThread();
	return Custom.IsEmpty() ? FPaths::Combine(FPaths::ProjectDir(), TEXT("WorldData")) : Custom;
}

bool USlsWorldSubsystem::LoadIndex(FString& Err)
{
	FString Text;
	const FString Path = FPaths::Combine(DataDir(), TEXT("index.json"));
	if (!FFileHelper::LoadFileToString(Text, *Path)) { Err = Path + TEXT(" fehlt"); return false; }
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J.IsValid()) { Err = Path + TEXT(" nicht lesbar"); return false; }
	if (J->GetStringField(TEXT("format")) != TEXT("slsu")) { Err = Path + TEXT(" ist kein Unreal-Export"); return false; }
	const TSharedPtr<FJsonObject>& Wo = J->GetObjectField(TEXT("world"));
	World.Zone = int32(Wo->GetNumberField(TEXT("zone")));
	World.OriginE = Wo->GetNumberField(TEXT("originE"));
	World.OriginN = Wo->GetNumberField(TEXT("originN"));
	World.TileSize = Wo->GetNumberField(TEXT("tileSize"));
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("tiles")))
	{
		const TArray<TSharedPtr<FJsonValue>>& A = V->AsArray();
		const FIntPoint T(int32(A[0]->AsNumber()), int32(A[1]->AsNumber()));
		World.Tiles.Add(T);
		TileSet.Add(T);
	}
	const TSharedPtr<FJsonObject>& S = J->GetObjectField(TEXT("spawn"));
	World.SpawnLocal = FVector(S->GetNumberField(TEXT("x")), S->GetNumberField(TEXT("y")), S->GetNumberField(TEXT("z")));
	World.SpawnHeading = S->GetNumberField(TEXT("heading"));
	J->TryGetStringField(TEXT("roadProfile"), World.RoadProfile);
	return true;
}

FIntPoint USlsWorldSubsystem::TileOfLocal(double X, double Z) const
{
	const FVector2D U = LocalToUtm(X, Z);
	return FIntPoint(FMath::FloorToInt(U.X / World.TileSize), FMath::FloorToInt(U.Y / World.TileSize));
}

FVector2D USlsWorldSubsystem::TileOriginLocal(FIntPoint T) const
{
	return UtmToLocal(T.X * World.TileSize, (T.Y + 1) * World.TileSize);
}

UMaterialInterface* USlsWorldSubsystem::MaterialFor(const FString& Layer, bool bVertexColor)
{
	// Placeholder looks until the PBR materials are ported (unreal/PLAN.md, phase 3): vertex colours where the
	// web tiles carry them (terrain survey tint, buildings, details), flat colours per layer otherwise.
	const FString Key = Layer + (bVertexColor ? TEXT("#c") : TEXT(""));
	if (TObjectPtr<UMaterialInterface>* Found = Materials.Find(Key)) return *Found;
	UMaterialInterface* M = nullptr;
	if (bVertexColor)
		M = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/EngineDebugMaterials/VertexColorMaterial.VertexColorMaterial"));
	if (!M)
	{
		static const TMap<FString, FLinearColor> Colors = {
			{TEXT("terrain"), FLinearColor(0.12f, 0.17f, 0.07f)}, {TEXT("roads"), FLinearColor(0.05f, 0.05f, 0.055f)},
			{TEXT("markings"), FLinearColor(0.8f, 0.8f, 0.78f)}, {TEXT("stalls"), FLinearColor(0.8f, 0.8f, 0.78f)},
			{TEXT("sidewalks"), FLinearColor(0.25f, 0.24f, 0.22f)}, {TEXT("paths"), FLinearColor(0.2f, 0.17f, 0.13f)},
			{TEXT("buildings"), FLinearColor(0.45f, 0.4f, 0.36f)}, {TEXT("water"), FLinearColor(0.03f, 0.08f, 0.1f)},
			{TEXT("tunnel"), FLinearColor(0.3f, 0.3f, 0.3f)}, {TEXT("tunnelLights"), FLinearColor(1.f, 0.9f, 0.7f)},
		};
		UMaterialInterface* Base = LoadObject<UMaterialInterface>(nullptr, TEXT("/Engine/BasicShapes/BasicShapeMaterial.BasicShapeMaterial"));
		UMaterialInstanceDynamic* D = UMaterialInstanceDynamic::Create(Base, this);
		const FLinearColor* C = Colors.Find(Layer);
		D->SetVectorParameterValue(TEXT("Color"), C ? *C : FLinearColor(0.5f, 0.5f, 0.5f));
		M = D;
	}
	Materials.Add(Key, M);
	return M;
}

ASlsTileActor* USlsWorldSubsystem::Spawn(const FSlsTileFile& File, bool bCollision, bool bAsyncCooking)
{
	FActorSpawnParameters P;
	P.Name = MakeUniqueObjectName(GetWorld(), ASlsTileActor::StaticClass(), *FString::Printf(TEXT("Tile_%d_%d"), File.IX, File.IY));
	P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
	const FVector Loc(File.OriginUE.X, File.OriginUE.Y, 0.0);
	ASlsTileActor* A = GetWorld()->SpawnActor<ASlsTileActor>(ASlsTileActor::StaticClass(), Loc, FRotator::ZeroRotator, P);
	A->BuildVisual(File, [this](const FString& L, bool bC) { return MaterialFor(L, bC); });
	if (bCollision) A->BuildCollision(File, bAsyncCooking);
	Tiles.Add(FIntPoint(File.IX, File.IY), A);
	return A;
}

ASlsTileActor* USlsWorldSubsystem::LoadTileSync(FIntPoint T, bool bCollision)
{
	if (ASlsTileActor* Have = FindTile(T))
	{
		if (bCollision && !Have->HasCollision())
		{
			TSharedPtr<FSlsTileFile> F = Files.FindRef(T);
			if (!F)
			{
				F = MakeShared<FSlsTileFile>();
				FString Err;
				if (!F->Load(FPaths::Combine(DataDir(), TEXT("t"), FString::Printf(TEXT("%d_%d.slsu"), T.X, T.Y)), Err)) { UE_LOG(LogSls, Error, TEXT("%s"), *Err); return Have; }
			}
			Have->BuildCollision(*F, false);
		}
		return Have;
	}
	if (!TileSet.Contains(T)) return nullptr;
	TSharedPtr<FSlsTileFile> F = MakeShared<FSlsTileFile>();
	FString Err;
	if (!F->Load(FPaths::Combine(DataDir(), TEXT("t"), FString::Printf(TEXT("%d_%d.slsu"), T.X, T.Y)), Err))
	{
		UE_LOG(LogSls, Error, TEXT("%s"), *Err);
		return nullptr;
	}
	Files.Add(T, F);
	return Spawn(*F, bCollision, false);
}

ASlsTileActor* USlsWorldSubsystem::FindTile(FIntPoint T) const
{
	const TObjectPtr<ASlsTileActor>* A = Tiles.Find(T);
	return A ? A->Get() : nullptr;
}

void USlsWorldSubsystem::UnloadTile(FIntPoint T)
{
	if (TObjectPtr<ASlsTileActor> A; Tiles.RemoveAndCopyValue(T, A) && IsValid(A)) A->Destroy();
	Files.Remove(T);
}

void USlsWorldSubsystem::UnloadAll()
{
	for (auto& [T, A] : Tiles) if (IsValid(A)) A->Destroy();
	Tiles.Reset();
	Files.Reset();
}

void USlsWorldSubsystem::StartLoad(FIntPoint T)
{
	Pending.Add(T);
	const FString Path = FPaths::Combine(DataDir(), TEXT("t"), FString::Printf(TEXT("%d_%d.slsu"), T.X, T.Y));
	TWeakObjectPtr<USlsWorldSubsystem> Weak(this);
	Async(EAsyncExecution::ThreadPool, [Weak, Path, T]() {
		TSharedPtr<FSlsTileFile> F = MakeShared<FSlsTileFile>();
		FString Err;
		if (!F->Load(Path, Err))
		{
			UE_LOG(LogSls, Error, TEXT("%s"), *Err);
			F->IX = T.X;
			F->IY = T.Y;
			F->Layers.Reset();
		}
		if (USlsWorldSubsystem* S = Weak.Get()) S->Done.Enqueue(F);
	});
}

double USlsWorldSubsystem::GroundZ(double X, double Y, double Fallback) const
{
	FHitResult Hit;
	const FVector A(X, Y, 200000.0), B(X, Y, -50000.0);
	FCollisionQueryParams Q(SCENE_QUERY_STAT(SlsGround), false);
	return GetWorld()->LineTraceSingleByChannel(Hit, A, B, ECC_SlsWheel, Q) ? Hit.ImpactPoint.Z : Fallback;
}

void USlsWorldSubsystem::Tick(float DeltaTime)
{
	if (!bReady) return;
	const double T0 = FPlatformTime::Seconds();
	const double Budget = GStreamBudget / 1000.0;

	// Finished reads: build them within the budget (at least one per frame).
	TSharedPtr<FSlsTileFile> F;
	int32 Built = 0;
	while ((Built == 0 || FPlatformTime::Seconds() - T0 < Budget) && Done.Dequeue(F))
	{
		const FIntPoint T(F->IX, F->IY);
		Pending.Remove(T);
		if (bPaused || FindTile(T) || F->Layers.Num() == 0) continue;
		Files.Add(T, F);
		const FVector2D O = FVector2D(F->OriginUE) + FVector2D(World.TileSize * 50.0);
		const bool bPhys = FVector2D::Distance(O, FVector2D(Focus)) < GStreamPhysRadius * 100.0 + World.TileSize * 71.0;
		Spawn(*F, bPhys, true);
		Built++;
	}
	if (bPaused) return;

	if (const APlayerController* PC = GetWorld()->GetFirstPlayerController())
	{
		FVector Loc; FRotator Rot;
		PC->GetPlayerViewPoint(Loc, Rot);
		if (const APawn* P = PC->GetPawn()) Loc = P->GetActorLocation();
		Focus = Loc;
	}
	const FVector L = UEToLocal(Focus);
	const FIntPoint C = TileOfLocal(L.X, L.Z);
	const int32 R = FMath::CeilToInt(GStreamRadius / World.TileSize) + 1;
	auto CentreDist = [&](FIntPoint T) {
		const FVector2D O = TileOriginLocal(T) + FVector2D(World.TileSize / 2, World.TileSize / 2);
		return FVector2D::Distance(O, FVector2D(L.X, L.Z));
	};
	// Nearest first.
	TArray<TPair<double, FIntPoint>> Want;
	for (int32 DX = -R; DX <= R; DX++)
		for (int32 DY = -R; DY <= R; DY++)
		{
			const FIntPoint T(C.X + DX, C.Y + DY);
			if (!TileSet.Contains(T) || FindTile(T) || Pending.Contains(T)) continue;
			const double D = CentreDist(T);
			if (D < GStreamRadius) Want.Add({D, T});
		}
	Want.Sort([](const auto& A, const auto& B) { return A.Key < B.Key; });
	for (const auto& [D, T] : Want)
	{
		if (Pending.Num() >= GStreamInflight) break;
		StartLoad(T);
	}

	// Drop far tiles; colliders follow the physics radius (always the 3 × 3 around the focus).
	TArray<FIntPoint> Drop;
	for (auto& [T, A] : Tiles)
	{
		const double D = CentreDist(T);
		if (D > GStreamRadius + 200.0) { Drop.Add(T); continue; }
		const bool bAround = FMath::Abs(T.X - C.X) <= 1 && FMath::Abs(T.Y - C.Y) <= 1;
		if (!A->HasCollision() && (bAround || D < GStreamPhysRadius) && FPlatformTime::Seconds() - T0 < Budget)
		{
			if (const TSharedPtr<FSlsTileFile>* File = Files.Find(T)) A->BuildCollision(**File, true);
		}
		else if (A->HasCollision() && !bAround && D > GStreamPhysRadius + 150.0)
			A->RemoveCollision();
	}
	for (const FIntPoint& T : Drop) UnloadTile(T);
}
