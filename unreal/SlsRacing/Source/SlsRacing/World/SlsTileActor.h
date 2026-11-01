#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Actor.h"
#include "SlsTileActor.generated.h"

class FSlsTileFile;
class UProceduralMeshComponent;
class UMaterialInterface;

/**
 * One 256 m world tile: the drawn layers (terrain, roads, markings, buildings …) in one render mesh, and the
 * collision exactly as the web game builds it, one component per collider group (kind, wheels-only, friction).
 * The actor sits at the tile's north-west corner; all vertices are relative to it.
 */
UCLASS(NotPlaceable, Transient)
class SLSRACING_API ASlsTileActor : public AActor
{
	GENERATED_BODY()

public:
	ASlsTileActor();

	/** Creates the render mesh from the file. */
	/** Assigns the materials again (tex.materials, after sls_setup.py). */
	void ApplyMaterials(TFunctionRef<UMaterialInterface*(const FString&, bool)> MaterialFor);
	void BuildVisual(const FSlsTileFile& File, TFunctionRef<UMaterialInterface*(const FString& Layer, bool bVertexColor)> MaterialFor);
	/** Creates the collision components. bAsync: cook on worker threads (streaming); off for tests that trace right away. */
	void BuildCollision(const FSlsTileFile& File, bool bAsync);
	void RemoveCollision();
	bool HasCollision() const { return CollisionComponents.Num() > 0; }

	int32 IX = 0, IY = 0;
	FVector2D OriginLocal = FVector2D::ZeroVector;

	/** Drawn carriageway triangles (Unreal cm, relative to the actor), kept for road.scan's rasterizer. */
	TArray<FVector3f> RoadPos;
	TArray<uint32> RoadIdx;
	/** Same for carriageways plus pavements (edge check). */
	TArray<FVector3f> PavedPos;
	TArray<uint32> PavedIdx;

	/** Reference cells of the road surface test, straight from the file (see export-tiles.ts). */
	TArray<uint32> RefKey;
	TArray<float> RefYd;
	TArray<int16> RefYw;
	TArray<int16> RefYc;
	float RefCell = 0.5f;
	int32 RefN = 512;

	/** Render mesh section per layer name, for layer toggles. */
	TMap<FString, int32> LayerSections;
	TMap<FString, bool> LayerColor;

	UPROPERTY(VisibleAnywhere)
	TObjectPtr<UProceduralMeshComponent> Render;

	UPROPERTY()
	TArray<TObjectPtr<UProceduralMeshComponent>> CollisionComponents;
};
