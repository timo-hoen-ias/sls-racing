#include "SlsPropLibrary.h"
#include "SlsTileFile.h"
#include "SlsRacing.h"
#include "Engine/StaticMesh.h"
#include "MeshDescription.h"
#include "StaticMeshAttributes.h"
#include "Materials/MaterialInterface.h"
#include "StaticMeshResources.h"

namespace
{
	/** One layer of the library file ("<part>.<lod>") as a mesh description with one polygon group. */
	bool Describe(const FSlsTileFile& F, const FString& Layer, FMeshDescription& MD)
	{
		const FString P = TEXT("m.") + Layer;
		const TArrayView<const FVector3f> Pos = F.View<FVector3f>(P + TEXT(".pos"));
		const TArrayView<const FVector3f> Nrm = F.View<FVector3f>(P + TEXT(".nrm"));
		const TArrayView<const FVector2f> UV = F.View<FVector2f>(P + TEXT(".uv"));
		const TArrayView<const uint8> Col = F.View<uint8>(P + TEXT(".col")); // r g b a bytes, sRGB (FColor is BGRA in memory)
		const TArrayView<const uint32> Idx = F.View<uint32>(P + TEXT(".idx"));
		if (Pos.Num() == 0 || Idx.Num() < 3) return false;
		FStaticMeshAttributes A(MD);
		A.Register();
		TVertexAttributesRef<FVector3f> VPos = A.GetVertexPositions();
		TVertexInstanceAttributesRef<FVector3f> VNrm = A.GetVertexInstanceNormals();
		TVertexInstanceAttributesRef<FVector4f> VCol = A.GetVertexInstanceColors();
		TVertexInstanceAttributesRef<FVector2f> VUV = A.GetVertexInstanceUVs();
		VUV.SetNumChannels(1);
		MD.ReserveNewVertices(Pos.Num());
		MD.ReserveNewVertexInstances(Pos.Num());
		MD.ReserveNewTriangles(Idx.Num() / 3);
		TArray<FVertexInstanceID> Inst;
		Inst.SetNumUninitialized(Pos.Num());
		for (int32 I = 0; I < Pos.Num(); I++)
		{
			const FVertexID V = MD.CreateVertex();
			VPos[V] = Pos[I];
			const FVertexInstanceID VI = MD.CreateVertexInstance(V);
			VNrm[VI] = Nrm.IsValidIndex(I) ? Nrm[I] : FVector3f::UpVector;
			// Bytes are sRGB like the tiles' vertex colours; mesh descriptions hold linear colour.
			const FLinearColor C = Col.Num() >= (I + 1) * 4 ? FLinearColor(FColor(Col[I * 4], Col[I * 4 + 1], Col[I * 4 + 2], Col[I * 4 + 3])) : FLinearColor::White;
			VCol[VI] = FVector4f(C.R, C.G, C.B, C.A);
			VUV.Set(VI, 0, UV.IsValidIndex(I) ? UV[I] : FVector2f::ZeroVector);
			Inst[I] = VI;
		}
		const FPolygonGroupID G = MD.CreatePolygonGroup();
		A.GetPolygonGroupMaterialSlotNames()[G] = FName(TEXT("Part"));
		for (int32 K = 0; K + 2 < Idx.Num(); K += 3)
		{
			if (Idx[K] >= uint32(Pos.Num()) || Idx[K + 1] >= uint32(Pos.Num()) || Idx[K + 2] >= uint32(Pos.Num())) continue;
			MD.CreateTriangle(G, { Inst[Idx[K]], Inst[Idx[K + 1]], Inst[Idx[K + 2]] });
		}
		return true;
	}
}

bool SlsBuildPropLibrary(UObject* Outer, const FString& Path, TFunctionRef<UMaterialInterface*(FName Tag)> MaterialFor,
	TArray<FSlsPropPart>& OutParts, FString& OutError)
{
	OutParts.Reset();
	FSlsTileFile F;
	if (!F.Load(Path, OutError)) return false;
	const TArray<TSharedPtr<FJsonValue>>* Parts;
	if (!F.Header.IsValid() || !F.Header->TryGetArrayField(TEXT("parts"), Parts))
	{
		OutError = Path + TEXT(": keine Teileliste");
		return false;
	}
	for (int32 K = 0; K < Parts->Num(); K++)
	{
		const TSharedPtr<FJsonObject>& O = (*Parts)[K]->AsObject();
		FSlsPropPart& Part = OutParts.AddDefaulted_GetRef();
		Part.Name = O->GetStringField(TEXT("name"));
		Part.Material = FName(*O->GetStringField(TEXT("mat")));
		const int32 Lods = int32(O->GetNumberField(TEXT("lods")));
		TArray<FMeshDescription> Descs;
		Descs.SetNum(Lods);
		TArray<const FMeshDescription*> Ptrs;
		for (int32 L = 0; L < Lods; L++)
			if (Describe(F, FString::Printf(TEXT("%d.%d"), K, L), Descs[L])) Ptrs.Add(&Descs[L]);
		if (Ptrs.Num() == 0) continue;
		UStaticMesh* SM = NewObject<UStaticMesh>(Outer, *FString::Printf(TEXT("SlsProp_%d"), K), RF_Transient);
		SM->GetStaticMaterials().Add(FStaticMaterial(MaterialFor(Part.Material), FName(TEXT("Part"))));
		UStaticMesh::FBuildMeshDescriptionsParams Params;
		Params.bBuildSimpleCollision = false;
		Params.bFastBuild = true;
		Params.bAllowCpuAccess = false;
		SM->BuildFromMeshDescriptions(Ptrs, Params);
		// The web game switches props and cars to lod1 at 60 m (PROP_LOD_DISTANCE, VEHICLE_LOD_DISTANCE): about
		// a third of the screen height for a 2 m object at the game's field of view.
		if (FStaticMeshRenderData* RD = SM->GetRenderData())
			if (Ptrs.Num() > 1) { RD->ScreenSize[0].Default = 1.f; RD->ScreenSize[1].Default = 0.03f; }
		Part.Mesh = SM;
	}
	UE_LOG(LogSls, Display, TEXT("Modellbibliothek: %d Teile aus %s"), OutParts.Num(), *Path);
	return true;
}
