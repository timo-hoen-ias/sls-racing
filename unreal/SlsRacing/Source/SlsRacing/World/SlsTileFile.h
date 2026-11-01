#pragma once

#include "CoreMinimal.h"
#include "Dom/JsonObject.h"

/**
 * One exported world tile (WorldData/t/<ix>_<iy>.slsu, written by unreal/tools/export-tiles.ts).
 * Gzipped container: "SLSU" · u32 version · u32 header bytes · header JSON · 4-byte aligned sections. Everything is
 * already in Unreal's frame (X east, Y south, Z up, centimetres, relative to the tile's north-west corner).
 */
struct FSlsLayerInfo
{
	FString Name;
	int32 Verts = 0;
	int32 Tris = 0;
	bool bUV = false;
	bool bColor = false;
	bool bSplat = false;
};

struct FSlsColliderGroup
{
	/** terrain, building, bridge, road, tree, lamp, rail, tunnel (the web game's ColliderKind). */
	FName Kind;
	/** Wheels only (road surfaces): object type SlsRoad, ignored by the chassis. */
	bool bWheelsOnly = false;
	float Friction = 0.9f;
	bool bTri = true;
};

class FSlsTileFile
{
public:
	static constexpr int32 Version = 1;

	int32 IX = 0, IY = 0;
	/** North-west corner: three local metres (x east, z south) and Unreal centimetres (X, Y). */
	FVector2D OriginLocal = FVector2D::ZeroVector;
	FVector2D OriginUE = FVector2D::ZeroVector;
	TArray<FSlsLayerInfo> Layers;
	TArray<FSlsColliderGroup> Colliders;
	/** Reference grid of the road surface test (0.5 m, 512 per edge), 0 cells if exported without one. */
	float RefCell = 0.5f;
	int32 RefN = 512;

	/** The whole header (extra fields such as models.slsu's part list). */
	TSharedPtr<FJsonObject> Header;

	/** Reads and unpacks a file; false with a message on any problem. Safe on worker threads. */
	bool Load(const FString& Path, FString& OutError);

	bool Has(const FString& Name) const { return Sections.Contains(Name); }

	template <typename T>
	TArrayView<const T> View(const FString& Name) const
	{
		const FSection* S = Sections.Find(Name);
		if (!S) return TArrayView<const T>();
		return TArrayView<const T>(reinterpret_cast<const T*>(Data.GetData() + S->Offset), int32(S->Length / sizeof(T)));
	}

private:
	struct FSection { int64 Offset = 0; int64 Length = 0; };
	TArray<uint8> Data;
	TMap<FString, FSection> Sections;
};
