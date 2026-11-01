#include "SlsTileActor.h"
#include "SlsTileFile.h"
#include "SlsRacing.h"
#include "ProceduralMeshComponent.h"
#include "PhysicalMaterials/PhysicalMaterial.h"
#include "PhysicsEngine/BodySetup.h"
#include "UObject/StrongObjectPtr.h"

namespace
{
	/** One shared physical material per friction value (Rapier and Chaos both average friction by default). */
	UPhysicalMaterial* FrictionMaterial(float Friction)
	{
		static TMap<int32, TStrongObjectPtr<UPhysicalMaterial>> Cache;
		const int32 Key = FMath::RoundToInt(Friction * 1000.f);
		if (TStrongObjectPtr<UPhysicalMaterial>* Found = Cache.Find(Key)) return Found->Get();
		UPhysicalMaterial* M = NewObject<UPhysicalMaterial>(GetTransientPackage(), *FString::Printf(TEXT("SlsFriction_%d"), Key));
		M->Friction = Friction;
		M->StaticFriction = Friction;
		M->FrictionCombineMode = EFrictionCombineMode::Average;
		M->Restitution = 0.f;
		Cache.Add(Key, TStrongObjectPtr<UPhysicalMaterial>(M));
		return M;
	}

	template <typename T>
	TArray<T> ToArray(TArrayView<const T> V) { return TArray<T>(V.GetData(), V.Num()); }
}

ASlsTileActor::ASlsTileActor()
{
	PrimaryActorTick.bCanEverTick = false;
	Render = CreateDefaultSubobject<UProceduralMeshComponent>(TEXT("Render"));
	Render->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	Render->SetCanEverAffectNavigation(false);
	Render->bUseAsyncCooking = true;
	SetRootComponent(Render);
}

void ASlsTileActor::ApplyMaterials(TFunctionRef<UMaterialInterface*(const FString&, bool)> MaterialFor)
{
	for (const auto& [Name, Section] : LayerSections) Render->SetMaterial(Section, MaterialFor(Name, LayerColor.FindRef(Name)));
}

void ASlsTileActor::BuildVisual(const FSlsTileFile& File, TFunctionRef<UMaterialInterface*(const FString&, bool)> MaterialFor)
{
	IX = File.IX;
	IY = File.IY;
	OriginLocal = File.OriginLocal;
	int32 Section = 0;
	for (const FSlsLayerInfo& L : File.Layers)
	{
		const FString P = TEXT("m.") + L.Name;
		TArrayView<const FVector3f> Pos = File.View<FVector3f>(P + TEXT(".pos"));
		TArrayView<const FVector3f> Nrm = File.View<FVector3f>(P + TEXT(".nrm"));
		TArrayView<const uint32> Idx = File.View<uint32>(P + TEXT(".idx"));
		if (Pos.Num() == 0 || Idx.Num() == 0) continue;

		TArray<FVector> V; V.Reserve(Pos.Num());
		for (const FVector3f& X : Pos) V.Add(FVector(X));
		TArray<FVector> N; N.Reserve(Nrm.Num());
		for (const FVector3f& X : Nrm) N.Add(FVector(X));
		TArray<int32> T; T.Reserve(Idx.Num());
		for (uint32 I : Idx) T.Add(int32(I));
		TArray<FColor> Col;
		if (L.bColor)
			for (const FColor& X : File.View<FColor>(P + TEXT(".col"))) Col.Add(FColor(X.B, X.G, X.R, X.A)); // file is RGBA, FColor is BGRA
		// Shader inputs, packed so every value survives half-float UVs (integers up to 2048 are exact):
		//  roads/paths: the 20-bit road code (roadCode.ts) split into UV0 = (lateral, surface + lines*8 + gutter*32),
		//               UV1 = (shoulder q + inner*16, width q)
		//  terrain:     8 splat weights as two 5-bit values per float (a*32 + b) in UV0/UV1, crop rows bytes in UV2
		// Read by Shaders/SlsPbr.ush (SlsRoad, SlsGround).
		TArray<FVector2D> UV0, UV1, UV2, UV3;
		TArrayView<const FVector2f> SrcUV = L.bUV ? File.View<FVector2f>(P + TEXT(".uv")) : TArrayView<const FVector2f>();
		const bool bRoadCode = SrcUV.Num() && (L.Name == TEXT("roads") || L.Name == TEXT("paths"));
		if (bRoadCode)
		{
			UV0.Reserve(SrcUV.Num());
			UV1.Reserve(SrcUV.Num());
			for (const FVector2f& X : SrcUV)
			{
				const uint32 Code = uint32(FMath::RoundToInt(X.Y));
				UV0.Add(FVector2D(X.X, double(Code & 63)));
				UV1.Add(FVector2D(double(((Code >> 6) & 15) + ((Code >> 18) & 3) * 16), double((Code >> 10) & 255)));
			}
		}
		else if (L.bSplat)
		{
			TArrayView<const uint8> A = File.View<uint8>(P + TEXT(".splatA")), B = File.View<uint8>(P + TEXT(".splatB")), R = File.View<uint8>(P + TEXT(".rows"));
			auto Q = [](uint8 V) { return FMath::RoundToInt(V * 31.0 / 255.0); };
			auto Pack = [&Q](uint8 X, uint8 Y) { return double(Q(X) * 32 + Q(Y)); };
			for (int32 I = 0; I < Pos.Num(); I++)
			{
				UV0.Add(FVector2D(Pack(A[I * 4], A[I * 4 + 1]), Pack(A[I * 4 + 2], A[I * 4 + 3])));
				UV1.Add(FVector2D(Pack(B[I * 4], B[I * 4 + 1]), Pack(B[I * 4 + 2], B[I * 4 + 3])));
				UV2.Add(FVector2D(R[I * 2], R[I * 2 + 1]));
			}
		}
		else
			for (const FVector2f& X : SrcUV) UV0.Add(FVector2D(X));
		TArray<FProcMeshTangent> Tangents;
		Render->CreateMeshSection(Section, V, T, N, UV0, UV1, UV2, UV3, Col, Tangents, false);
		Render->SetMaterial(Section, MaterialFor(L.Name, L.bColor));
		LayerSections.Add(L.Name, Section);
		LayerColor.Add(L.Name, L.bColor);
		Section++;

		if (L.Name == TEXT("roads"))
		{
			RoadPos = ToArray(Pos);
			RoadIdx = ToArray(Idx);
		}
		if (L.Name == TEXT("roads") || L.Name == TEXT("sidewalks"))
		{
			const uint32 Base = PavedPos.Num();
			PavedPos.Append(Pos.GetData(), Pos.Num());
			for (uint32 I : Idx) PavedIdx.Add(Base + I);
		}
	}
	RefCell = File.RefCell;
	RefN = File.RefN;
	RefKey = ToArray(File.View<uint32>(TEXT("r.key")));
	RefYd = ToArray(File.View<float>(TEXT("r.yd")));
	RefYw = ToArray(File.View<int16>(TEXT("r.yw")));
	RefYc = ToArray(File.View<int16>(TEXT("r.yc")));
}

void ASlsTileActor::BuildCollision(const FSlsTileFile& File, bool bAsync)
{
	RemoveCollision();
	TArray<TArray<TArray<FVector>>> Hulls;
	Hulls.SetNum(File.Colliders.Num());
	{
		TArrayView<const FVector3f> Pts = File.View<FVector3f>(TEXT("h.pos"));
		TArrayView<const uint32> Cnt = File.View<uint32>(TEXT("h.cnt"));
		TArrayView<const float> Meta = File.View<float>(TEXT("h.meta"));
		int32 O = 0;
		for (int32 H = 0; H < Cnt.Num(); H++)
		{
			TArray<FVector>& Hull = Hulls[int32(Meta[H])].AddDefaulted_GetRef();
			for (uint32 K = 0; K < Cnt[H]; K++) Hull.Add(FVector(Pts[O + K]));
			O += Cnt[H];
		}
	}
	for (int32 G = 0; G < File.Colliders.Num(); G++)
	{
		const FSlsColliderGroup& Group = File.Colliders[G];
		UProceduralMeshComponent* C = NewObject<UProceduralMeshComponent>(this, *FString::Printf(TEXT("Col_%d_%s"), G, *Group.Kind.ToString()));
		C->SetupAttachment(Render);
		C->SetVisibility(false);
		C->SetCanEverAffectNavigation(false);
		C->bUseAsyncCooking = bAsync;
		C->ComponentTags.Add(Group.Kind);
		if (Group.bWheelsOnly) C->ComponentTags.Add(TEXT("WheelsOnly"));
		C->SetCollisionEnabled(ECollisionEnabled::QueryAndPhysics);
		C->SetCollisionObjectType(Group.bWheelsOnly ? ECC_SlsRoad : ECC_WorldStatic);
		C->SetCollisionResponseToAllChannels(ECR_Block);
		if (Group.bWheelsOnly)
		{
			// Only the wheels ride on carriageways, pavements and paths, so kerbs never catch the chassis: chassis probes
			// ignore them here, the car body (object type Vehicle) ignores SlsRoad on its side, and the Chaos wheel traces hit them.
			C->SetCollisionResponseToChannel(ECC_SlsChassis, ECR_Ignore);
			C->SetCollisionResponseToChannel(ECC_Pawn, ECR_Ignore);
			C->SetCollisionResponseToChannel(ECC_PhysicsBody, ECR_Ignore);
		}
		C->BodyInstance.SetPhysMaterialOverride(FrictionMaterial(Group.Friction));
		if (Group.bTri)
		{
			// Trimesh: complex collision used as simple, so rigid bodies and simple traces see the exact triangles.
			TArrayView<const FVector3f> Pos = File.View<FVector3f>(FString::Printf(TEXT("c.%d.pos"), G));
			TArrayView<const uint32> Idx = File.View<uint32>(FString::Printf(TEXT("c.%d.idx"), G));
			TArray<FVector> V; V.Reserve(Pos.Num());
			for (const FVector3f& X : Pos) V.Add(FVector(X));
			TArray<int32> T; T.Reserve(Idx.Num());
			for (uint32 I : Idx) T.Add(int32(I));
			C->bUseComplexAsSimpleCollision = true;
			C->CreateMeshSection(0, V, T, TArray<FVector>(), TArray<FVector2D>(), TArray<FColor>(), TArray<FProcMeshTangent>(), true);
			C->SetMeshSectionVisible(0, false);
		}
		else
		{
			// Boxes, cylinders and tunnel blocks as convex hulls (simple collision).
			C->bUseComplexAsSimpleCollision = false;
			C->SetCollisionConvexMeshes(Hulls[G]);
		}
		C->RegisterComponent();
		CollisionComponents.Add(C);
	}
}

void ASlsTileActor::RemoveCollision()
{
	for (UProceduralMeshComponent* C : CollisionComponents)
		if (C) C->DestroyComponent();
	CollisionComponents.Reset();
}
