// Console commands of the street furniture and parked cars (phase 3), named like the web game's props.* commands
// (src/world/props.ts). Instances come from the tiles (p.part / p.inst), meshes from WorldData/models.slsu.

#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "World/SlsTileActor.h"
#include "Components/HierarchicalInstancedStaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "GameFramework/PlayerController.h"
#include "Camera/PlayerCameraManager.h"

extern int32 GPropsOn;
extern float GPropsCull;

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 8.f, Color, Text);
	}

	template <typename F>
	void ForEachHism(UWorld* W, F&& Fn)
	{
		if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W))
			for (const auto& [T, A] : S->Loaded())
				if (A) for (UHierarchicalInstancedStaticMeshComponent* H : A->PropComponents) if (H) Fn(H);
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
			Add(TEXT("props.on"), TEXT("Straßenmöbel und geparkte Autos an/aus (1/0)"), [](const TArray<FString>& A, UWorld* W) {
				GPropsOn = A.Num() ? FCString::Atoi(*A[0]) != 0 : !GPropsOn;
				if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W)) S->RefreshProps();
				Say(FString::Printf(TEXT("props.on = %d"), GPropsOn));
			});
			Add(TEXT("props.radius"), TEXT("Sichtweite der Props in m (wie props.radius im Web, Ausblenden ab 80 %)"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) GPropsCull = FMath::Clamp(FCString::Atof(*A[0]), 30.f, 3000.f);
				const int32 Cm = int32(GPropsCull * 100.f);
				ForEachHism(W, [Cm](UHierarchicalInstancedStaticMeshComponent* H) { H->SetCullDistances(int32(Cm * 0.8f), Cm); });
				Say(FString::Printf(TEXT("props.radius = %.0f m"), GPropsCull));
			});
			Add(TEXT("props.reload"), TEXT("Props aller geladenen Kacheln neu aufbauen"), [](const TArray<FString>&, UWorld* W) {
				if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W)) S->RefreshProps();
				Say(TEXT("Props neu aufgebaut"));
			});
			Add(TEXT("props.info"), TEXT("Instanzen pro Modellteil in den geladenen Kacheln [filter]"), [](const TArray<FString>& A, UWorld* W) {
				USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
				if (!S) return;
				TArrayView<UStaticMesh* const> M = S->PropMeshes();
				TMap<int32, int32> Count;
				int32 Total = 0, Comps = 0;
				ForEachHism(W, [&](UHierarchicalInstancedStaticMeshComponent* H) {
					Comps++;
					Total += H->GetInstanceCount();
					Count.FindOrAdd(M.Find(H->GetStaticMesh())) += H->GetInstanceCount();
				});
				int32 Missing = 0;
				for (UStaticMesh* X : M) Missing += X == nullptr;
				for (const auto& [K, N] : Count)
				{
					const FString Name = S->PropNames().IsValidIndex(K) ? S->PropNames()[K] : TEXT("?");
					if (A.Num() && !Name.Contains(A[0])) continue;
					Say(FString::Printf(TEXT("  %-34s %6d"), *Name, N));
				}
				Say(FString::Printf(TEXT("Props: %d Instanzen in %d HISM, %d Modellteile (%d ohne Mesh), Sichtweite %.0f m"), Total, Comps, M.Num(), Missing, GPropsCull));
			});
			Add(TEXT("props.near"), TEXT("Props im Umkreis der Kamera in m (Standard 30), optional nur Teile mit <filter>: Teil, Abstand, Gier, Ort (für tp)"), [](const TArray<FString>& A, UWorld* W) {
				USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
				APlayerController* PC = W ? W->GetFirstPlayerController() : nullptr;
				if (!S || !PC || !PC->PlayerCameraManager) return;
				const FVector Cam = PC->PlayerCameraManager->GetCameraLocation();
				const double R = (A.Num() ? FCString::Atof(*A[0]) : 30.0) * 100.0;
				TArrayView<UStaticMesh* const> M = S->PropMeshes();
				int32 N = 0;
				ForEachHism(W, [&](UHierarchicalInstancedStaticMeshComponent* H) {
					const int32 K = M.Find(H->GetStaticMesh());
					if (A.Num() > 1 && !(S->PropNames().IsValidIndex(K) && S->PropNames()[K].Contains(A[1]))) return;
					for (int32 I = 0; I < H->GetInstanceCount() && N < 40; I++)
					{
						FTransform X;
						H->GetInstanceTransform(I, X, true);
						const double D = FVector::Dist(X.GetLocation(), Cam);
						if (D > R) continue;
						N++;
						const FVector L = USlsWorldSubsystem::UEToLocal(X.GetLocation());
						Say(FString::Printf(TEXT("  %-34s %5.1f m  Gier %.0f°  bei x %.1f z %.1f"), S->PropNames().IsValidIndex(K) ? *S->PropNames()[K] : TEXT("?"), D / 100.0, X.Rotator().Yaw, L.X, L.Z));
					}
				});
				if (!N) Say(TEXT("keine Props in der Nähe"));
			});
		}
	};
	FCommands GCommands;
}
