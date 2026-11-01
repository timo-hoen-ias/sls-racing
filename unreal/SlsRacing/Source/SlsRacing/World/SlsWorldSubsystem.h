#pragma once

#include "CoreMinimal.h"
#include "Subsystems/WorldSubsystem.h"
#include "Containers/Queue.h"
#include "SlsRoadGraph.h"
#include "SlsWorldSubsystem.generated.h"

class ASlsTileActor;
class FSlsTileFile;
class UMaterialInterface;

/** World info from WorldData/index.json (the web build's index plus the export's fields). */
struct FSlsWorldInfo
{
	int32 Zone = 32;
	double OriginE = 0, OriginN = 0;
	double TileSize = 256;
	TArray<FIntPoint> Tiles;
	/** Spawn in three local metres (x east, y up, z south) and heading (radians, as the web game uses it). */
	FVector SpawnLocal = FVector::ZeroVector;
	double SpawnHeading = 0;
	FString RoadProfile;
};

/**
 * Streams the exported tiles around the player like the web streamer (src/world/streamer.ts): files are read
 * and unpacked on worker threads, meshes and colliders built on the game thread within stream.budget ms a frame,
 * colliders only within stream.physradius. Coordinates: Unreal X = local x (east), Y = local z (south), Z = up,
 * centimetres; helpers convert from the web game's local metres and UTM.
 */
UCLASS()
class SLSRACING_API USlsWorldSubsystem : public UTickableWorldSubsystem
{
	GENERATED_BODY()

public:
	virtual bool ShouldCreateSubsystem(UObject* Outer) const override;
	virtual void Initialize(FSubsystemCollectionBase& Collection) override;
	virtual void Deinitialize() override;
	virtual void Tick(float DeltaTime) override;
	virtual TStatId GetStatId() const override;
	virtual bool IsTickableInEditor() const override { return false; }

	static USlsWorldSubsystem* Get(const UObject* WorldContext);

	bool IsReady() const { return bReady; }
	const FSlsWorldInfo& Info() const { return World; }
	FString DataDir() const;

	/** Web local metres (x east, y up, z south) ↔ Unreal centimetres. */
	static FVector LocalToUE(const FVector& L) { return FVector(L.X * 100.0, L.Z * 100.0, L.Y * 100.0); }
	static FVector UEToLocal(const FVector& U) { return FVector(U.X / 100.0, U.Z / 100.0, U.Y / 100.0); }
	FVector2D UtmToLocal(double E, double N) const { return FVector2D(E - World.OriginE, -(N - World.OriginN)); }
	FVector2D LocalToUtm(double X, double Z) const { return FVector2D(X + World.OriginE, World.OriginN - Z); }
	FIntPoint TileOfLocal(double X, double Z) const;
	FVector2D TileOriginLocal(FIntPoint T) const;
	FVector SpawnUE() const { return LocalToUE(World.SpawnLocal); }

	/** Loads a tile right now on the game thread (tests); bCollision with synchronous cooking. */
	ASlsTileActor* LoadTileSync(FIntPoint T, bool bCollision);
	void UnloadTile(FIntPoint T);
	void UnloadAll();
	ASlsTileActor* FindTile(FIntPoint T) const;
	bool HasTileData(FIntPoint T) const { return TileSet.Contains(T); }
	const TMap<FIntPoint, TObjectPtr<ASlsTileActor>>& Loaded() const { return Tiles; }

	/** Ground height (Unreal Z) under a point by a wheel ray, or Fallback. */
	double GroundZ(double X, double Y, double Fallback) const;

	/** Streaming around the player stops (tests that load tiles themselves). */
	bool bPaused = false;
	/** Last focus point (Unreal cm). */
	FVector Focus = FVector::ZeroVector;
	int32 InFlight() const { return Pending.Num(); }

	UMaterialInterface* MaterialFor(const FString& Layer, bool bVertexColor);

	/** Road network (graph.json). */
	const FSlsRoadGraph& Roads() const { return Graph; }

private:
	bool LoadIndex(FString& Err);
	void StartLoad(FIntPoint T);
	ASlsTileActor* Spawn(const FSlsTileFile& File, bool bCollision, bool bAsyncCooking);

	bool bReady = false;
	FSlsWorldInfo World;
	FSlsRoadGraph Graph;
	TSet<FIntPoint> TileSet;

	UPROPERTY()
	TMap<FIntPoint, TObjectPtr<ASlsTileActor>> Tiles;

	/** Tiles being read on worker threads, and read ones waiting for the game thread. */
	TSet<FIntPoint> Pending;
	TQueue<TSharedPtr<FSlsTileFile>, EQueueMode::Mpsc> Done;
	/** Files kept for tiles inside the view radius whose colliders may still be needed. */
	TMap<FIntPoint, TSharedPtr<FSlsTileFile>> Files;

	UPROPERTY()
	TMap<FString, TObjectPtr<UMaterialInterface>> Materials;
};
