// Console commands of the road look (road.look.*): the Unreal-side improvements of the road, marking and pavement
// shading on top of the web game's road shader (Shaders/SlsPbr.ush SlsLook). They go to the Material Parameter
// Collection MPC_Sls as Look0 = (on, asphalt albedo, kind weight, detail), Look1 = (pavement brightness, marking
// paint, lane wear, asphalt normal) and Look2 = (marking min width px, ground smooth splat, paved ground albedo);
// the defaults here must match parameter_collection() in sls_setup.py. ground.look.* lives here too (same MPC slots).

#include "SlsRacing.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "Kismet/KismetMaterialLibrary.h"
#include "Materials/MaterialParameterCollection.h"

// own namespace: the other command files have the same helper names (Say, GCommands) and unity builds merge them
namespace SlsRoadLook
{
namespace
{
	void Say(const FString& Text, FColor Color = FColor::White)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 8.f, Color, Text);
	}

	struct FLookParams
	{
		float On = 1, Tone = 0.08f, Kind = 0.15f, Detail = 1;
		float Pavement = 0.7f, Marking = 1, Lanes = 0.4f, Normal = 1.4f;
		float MarkWidth = 1.5f, GroundSmooth = 1, GroundPaved = 1.25f;
	} GLook;

	void Push(UWorld* W)
	{
		if (!W) return;
		UMaterialParameterCollection* C = LoadObject<UMaterialParameterCollection>(nullptr, TEXT("/Game/Materials/MPC_Sls.MPC_Sls"), nullptr, LOAD_NoWarn | LOAD_Quiet);
		if (!C) { Say(TEXT("MPC_Sls fehlt: erst ./unreal/sls.sh setup ausführen"), FColor::Yellow); return; }
		const FLookParams& P = GLook;
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Look0"), FLinearColor(P.On, P.Tone, P.Kind, P.Detail));
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Look1"), FLinearColor(P.Pavement, P.Marking, P.Lanes, P.Normal));
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Look2"), FLinearColor(P.MarkWidth, P.GroundSmooth, P.GroundPaved, 0));
	}

	struct FValue { const TCHAR* Name; float FLookParams::*Field; float Min, Max; const TCHAR* Help; };
	const FValue GValues[] = {
		{TEXT("road.look.tone"), &FLookParams::Tone, 0.02f, 0.3f, TEXT("Straßenlook: gemeinsame Albedo aller Asphaltsorten (neu/abgenutzt/rissig) 0.02..0.3, Standard 0.08")},
		{TEXT("road.look.kind"), &FLookParams::Kind, 0, 1, TEXT("Straßenlook: wie stark die Abnutzungsklasse der Karte den Asphalt bestimmt, 0 = nur Weltmuster, 1 = wie im Web, Standard 0.15")},
		{TEXT("road.look.detail"), &FLookParams::Detail, 0, 2, TEXT("Straßenlook: feine Asphaltkörnung aus der Nähe (Helligkeit + Normal) 0..2, Standard 1")},
		{TEXT("road.look.pavement"), &FLookParams::Pavement, 0.3f, 1.5f, TEXT("Straßenlook: Helligkeit von Gehwegen, Bordsteinen und Plätzen 0.3..1.5, Standard 0.7")},
		{TEXT("road.look.marking"), &FLookParams::Marking, 0.5f, 1.3f, TEXT("Straßenlook: Helligkeit der Fahrbahnmarkierung 0.5..1.3, Standard 1")},
		{TEXT("road.look.lanes"), &FLookParams::Lanes, 0, 1, TEXT("Straßenlook: Fahrspuren, Ölflecken und Randschmutz 0..1 (1 = wie im Web), Standard 0.4")},
		{TEXT("road.look.normal"), &FLookParams::Normal, 0, 3, TEXT("Straßenlook: Stärke der Asphalt-Normal-Map 0..3, Standard 1.4")},
		{TEXT("road.look.markwidth"), &FLookParams::MarkWidth, 0, 4, TEXT("Straßenlook: Mindestbreite der Markierungsflächen in Pixeln (fern dünner gerastert statt zerbrochen), 0 = aus, Standard 1.5")},
		{TEXT("ground.look.paved"), &FLookParams::GroundPaved, 0.5f, 4, TEXT("Bodenlook: Helligkeit von gepflastertem Gelände relativ zum Asphalt (road.look.tone), Standard 1.25")},
	};

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
			for (const FValue& V : GValues)
			{
				const FValue Val = V;
				Add(V.Name, V.Help, [Val](const TArray<FString>& A, UWorld* W) {
					if (A.Num()) { GLook.*Val.Field = FMath::Clamp(FCString::Atof(*A[0]), Val.Min, Val.Max); Push(W); }
					Say(FString::Printf(TEXT("%s = %.2f"), Val.Name, GLook.*Val.Field));
				});
			}
			Add(TEXT("road.look.on"), TEXT("Straßenlook an/aus (aus = Straßenshader 1:1 wie im Web, zum Vergleich): 1/0, on/off, an/aus, ohne Argument umschalten"),
				[](const TArray<FString>& A, UWorld* W) {
					const FString S = A.Num() ? A[0] : FString();
					const bool bOn = S == TEXT("1") || S == TEXT("on") || S == TEXT("an") ? true : S == TEXT("0") || S == TEXT("off") || S == TEXT("aus") ? false : GLook.On < 0.5f;
					GLook.On = bOn ? 1.f : 0.f;
					Push(W);
					Say(FString::Printf(TEXT("road.look.on = %s"), bOn ? TEXT("an") : TEXT("aus")));
				});
			Add(TEXT("ground.look.smooth"), TEXT("Bodenlook: Splat-Gewichte pro Vertex entpacken (1, keine welligen Stufen) oder gepackt interpoliert wie bisher (0); ohne Argument umschalten"),
				[](const TArray<FString>& A, UWorld* W) {
					const FString S = A.Num() ? A[0] : FString();
					const bool bOn = S == TEXT("1") || S == TEXT("on") || S == TEXT("an") ? true : S == TEXT("0") || S == TEXT("off") || S == TEXT("aus") ? false : GLook.GroundSmooth < 0.5f;
					GLook.GroundSmooth = bOn ? 1.f : 0.f;
					Push(W);
					Say(FString::Printf(TEXT("ground.look.smooth = %s"), bOn ? TEXT("an") : TEXT("aus")));
				});
			Add(TEXT("road.look.reset"), TEXT("Straßenlook: alle Werte auf Standard"), [](const TArray<FString>&, UWorld* W) {
				GLook = FLookParams();
				Push(W);
				Say(TEXT("road.look: Standardwerte"));
			});
			Add(TEXT("road.look.info"), TEXT("Straßenlook: aktuelle Werte"), [](const TArray<FString>&, UWorld*) {
				const FLookParams& P = GLook;
				Say(FString::Printf(TEXT("road.look on %.0f tone %.3f kind %.2f detail %.2f pavement %.2f marking %.2f lanes %.2f normal %.2f markwidth %.2f; ground.look smooth %.0f paved %.2f"),
					P.On, P.Tone, P.Kind, P.Detail, P.Pavement, P.Marking, P.Lanes, P.Normal, P.MarkWidth, P.GroundSmooth, P.GroundPaved));
			});
		}
	};
	FCommands GCommands;
}
}
