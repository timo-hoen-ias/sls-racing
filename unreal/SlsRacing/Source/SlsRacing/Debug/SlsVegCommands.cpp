// Console commands of the trees and bushes (phase 3), named like the web game's veg.* commands
// (src/world/vegetation.ts). Instances come from the tiles (v.sp / v.inst), meshes and materials from sls_setup.py.

#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "World/SlsTileActor.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "Kismet/KismetMaterialLibrary.h"
#include "Materials/MaterialParameterCollection.h"

extern int32 GVegOn;
extern float GVegCull;

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 8.f, Color, Text);
	}

	/** MPC_Sls "Veg": x = wind strength (web veg.wind, default 1), y = translucency (veg.translucency), z = species
	 *  shown by veg.species (index + 1, 0 = all; for materials that want it, the HISMs are hidden directly). */
	FLinearColor GVeg(1.f, 1.f, 0.f, 0.f);
	int32 GVegShadows = 1;

	void Push(UWorld* W)
	{
		if (!W) return;
		UMaterialParameterCollection* C = LoadObject<UMaterialParameterCollection>(nullptr, TEXT("/Game/Materials/MPC_Sls.MPC_Sls"), nullptr, LOAD_NoWarn | LOAD_Quiet);
		if (!C) { Say(TEXT("MPC_Sls fehlt: erst ./unreal/sls.sh setup ausführen"), FColor::Yellow); return; }
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Veg"), GVeg);
	}

	template <typename F>
	void ForEachHism(UWorld* W, F&& Fn)
	{
		if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W))
			for (const auto& [T, A] : S->Loaded())
				if (A) for (UHierarchicalInstancedStaticMeshComponent* H : A->VegetationComponents) if (H) Fn(H);
	}

	struct FCommands
	{
		TArray<TUniquePtr<FAutoConsoleCommandWithWorldAndArgs>> All;
		void Add(const TCHAR* Name, const TCHAR* Help, TFunction<void(const TArray<FString>&, UWorld*)> F)
		{
			All.Add(MakeUnique<FAutoConsoleCommandWithWorldAndArgs>(Name, Help,
				FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([F](const TArray<FString>& A, UWorld* W) { F(A, W); })));
		}

		FCommands()
		{
			Add(TEXT("veg.on"), TEXT("Bäume und Büsche an/aus (1/0)"), [](const TArray<FString>& A, UWorld* W) {
				GVegOn = A.Num() ? FCString::Atoi(*A[0]) != 0 : !GVegOn;
				if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W)) S->RefreshVegetation();
				Say(FString::Printf(TEXT("veg.on = %d"), GVegOn));
			});
			Add(TEXT("veg.cull"), TEXT("Sichtweite der Bäume in m (Ausblenden ab 80 %)"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) GVegCull = FMath::Clamp(FCString::Atof(*A[0]), 50.f, 5000.f);
				const int32 Cm = int32(GVegCull * 100.f);
				ForEachHism(W, [Cm](UHierarchicalInstancedStaticMeshComponent* H) { H->SetCullDistances(int32(Cm * 0.8f), Cm); });
				Say(FString::Printf(TEXT("veg.cull = %.0f m"), GVegCull));
			});
			Add(TEXT("veg.reload"), TEXT("Artenmeshes neu laden und Bäume aller geladenen Kacheln neu aufbauen"), [](const TArray<FString>&, UWorld* W) {
				if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W)) S->RefreshVegetation();
				Say(TEXT("Vegetation neu aufgebaut"));
			});
			Add(TEXT("veg.info"), TEXT("Arten, Instanzen pro Art und fehlende Meshes"), [](const TArray<FString>&, UWorld* W) {
				USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
				if (!S) return;
				const TArray<FString>& Ids = S->Info().Species;
				TArrayView<UStaticMesh* const> M = S->VegetationMeshes();
				TArray<int32> Count;
				Count.SetNumZeroed(Ids.Num());
				int32 Total = 0, Comps = 0;
				ForEachHism(W, [&](UHierarchicalInstancedStaticMeshComponent* H) {
					Comps++;
					Total += H->GetInstanceCount();
					const int32 K = M.Find(H->GetStaticMesh());
					if (Count.IsValidIndex(K)) Count[K] += H->GetInstanceCount();
				});
				for (int32 K = 0; K < Ids.Num(); K++)
					Say(FString::Printf(TEXT("  %-12s %6d%s"), *Ids[K], Count[K], M.IsValidIndex(K) && M[K] ? TEXT("") : TEXT("  (Mesh fehlt)")),
						M.IsValidIndex(K) && M[K] ? FColor::White : FColor::Yellow);
				Say(FString::Printf(TEXT("Vegetation: %d Instanzen in %d HISM, %d Arten, Sichtweite %.0f m"), Total, Comps, Ids.Num(), GVegCull));
			});
			Add(TEXT("veg.species"), TEXT("Nur eine Art zeigen (Name oder Index), ohne Argument alle"), [](const TArray<FString>& A, UWorld* W) {
				USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
				if (!S) return;
				int32 K = -1;
				if (A.Num()) { K = S->Info().Species.IndexOfByKey(A[0]); if (K < 0 && A[0].IsNumeric()) K = FCString::Atoi(*A[0]); }
				GVeg.B = float(K + 1);
				Push(W);
				TArrayView<UStaticMesh* const> M = S->VegetationMeshes();
				UStaticMesh* Only = M.IsValidIndex(K) ? M[K] : nullptr;
				ForEachHism(W, [&](UHierarchicalInstancedStaticMeshComponent* H) { H->SetVisibility(K < 0 || H->GetStaticMesh() == Only); });
				Say(K < 0 ? FString(TEXT("veg.species: alle")) : FString::Printf(TEXT("veg.species: %s"), S->Info().Species.IsValidIndex(K) ? *S->Info().Species[K] : TEXT("?")));
			});
			Add(TEXT("veg.wind"), TEXT("Windstärke der Bäume 0..3 (1 = wie im Web)"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) { GVeg.R = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 3.f); Push(W); }
				Say(FString::Printf(TEXT("veg.wind = %.2f"), GVeg.R));
			});
			Add(TEXT("veg.translucency"), TEXT("Durchscheinen der Blätter im Gegenlicht 0..2"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) { GVeg.G = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 2.f); Push(W); }
				Say(FString::Printf(TEXT("veg.translucency = %.2f"), GVeg.G));
			});
			Add(TEXT("veg.shadows"), TEXT("Baumschatten an/aus (1/0)"), [](const TArray<FString>& A, UWorld* W) {
				GVegShadows = A.Num() ? FCString::Atoi(*A[0]) != 0 : !GVegShadows;
				ForEachHism(W, [](UHierarchicalInstancedStaticMeshComponent* H) { H->SetCastShadow(GVegShadows != 0); });
				Say(FString::Printf(TEXT("veg.shadows = %d"), GVegShadows));
			});
		}
	};
	FCommands GCommands;
}
