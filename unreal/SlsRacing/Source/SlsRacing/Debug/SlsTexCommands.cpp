// Console commands of the surface materials (phase 2): the web game's tex.*, ground.* and feldweg.* looks, sent to
// the Material Parameter Collection MPC_Sls that every material built by sls_setup.py reads (Shaders/SlsPbr.ush).

#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"
#include "Kismet/KismetMaterialLibrary.h"
#include "Materials/MaterialParameterCollection.h"

extern int32 GPbrMaterials;

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 8.f, Color, Text);
	}

	/** Defaults as pbrTextures.ts / groundCommands.ts. Order = Pbr0..Pbr3 in SlsPbr.ush. */
	struct FTexParams
	{
		float On = 1, Normal = 1, Tiling = 1, Macro = 1;
		float GroundTint = 0.85f, Wear = 1, Debug = 0, RoadForce = -1;
		float FieldRuts = 1, FieldGrass = 1, GroundAerial = 1, GroundRows = 1;
		float GroundView = 0;
	} GTex;

	void Push(UWorld* W)
	{
		if (!W) return;
		UMaterialParameterCollection* C = LoadObject<UMaterialParameterCollection>(nullptr, TEXT("/Game/Materials/MPC_Sls.MPC_Sls"), nullptr, LOAD_NoWarn | LOAD_Quiet);
		if (!C) { Say(TEXT("MPC_Sls fehlt: erst ./unreal/sls.sh setup ausführen"), FColor::Yellow); return; }
		const FTexParams& P = GTex;
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Pbr0"), FLinearColor(P.On, P.Normal, P.Tiling, P.Macro));
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Pbr1"), FLinearColor(P.GroundTint, P.Wear, P.Debug, P.RoadForce));
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Pbr2"), FLinearColor(P.FieldRuts, P.FieldGrass, P.GroundAerial, P.GroundRows));
		UKismetMaterialLibrary::SetVectorParameterValue(W, C, TEXT("Pbr3"), FLinearColor(P.GroundView, 0, 0, 0));
	}

	bool ParseBool(const FString& S, bool Current)
	{
		if (S == TEXT("on") || S == TEXT("1") || S == TEXT("an")) return true;
		if (S == TEXT("off") || S == TEXT("0") || S == TEXT("aus")) return false;
		return !Current;
	}

	struct FValue { const TCHAR* Name; float FTexParams::*Field; float Min, Max; const TCHAR* Help; };
	const FValue GValues[] = {
		{TEXT("tex.macro"), &FTexParams::Macro, 0, 2, TEXT("Großflächige Variation (Helligkeit, Abnutzung, Flicken) 0..2")},
		{TEXT("tex.groundtint"), &FTexParams::GroundTint, 0, 1, TEXT("Gelände: 0 = Scanfarben, 1 = Scan-Details in der Kartenfarbe")},
		{TEXT("tex.wear"), &FTexParams::Wear, 0, 2, TEXT("Straßenabnutzung: 0 = alles neu, 1 = wie gebaut, 2 = alles verschlissen")},
		{TEXT("feldweg.ruts"), &FTexParams::FieldRuts, 0, 2, TEXT("Feldweg: Tiefe der Reifenspuren in der Schattierung 0..2")},
		{TEXT("feldweg.grass"), &FTexParams::FieldGrass, 0, 2, TEXT("Feldweg: Gras auf Mittelstreifen und Rand 0..2")},
		{TEXT("ground.aerial"), &FTexParams::GroundAerial, 0, 2, TEXT("Bodenfarbe aus dem Luftbild: 0 = Klassenfarben, 1 = echte Tönung, bis 2 übertrieben")},
		{TEXT("ground.rows"), &FTexParams::GroundRows, 0, 1, TEXT("Ackerreihen und Fahrgassen 0..1")},
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
					if (A.Num()) { GTex.*Val.Field = FMath::Clamp(FCString::Atof(*A[0]), Val.Min, Val.Max); Push(W); }
					Say(FString::Printf(TEXT("%s = %.2f"), Val.Name, GTex.*Val.Field));
				});
			}
			for (const TCHAR* Name : {TEXT("tex.enabled"), TEXT("tex.on")})
				Add(Name, TEXT("Foto-Texturen an/aus (aus = flache Mittelwertfarben zum Vergleich)"), [](const TArray<FString>& A, UWorld* W) {
					GTex.On = ParseBool(A.Num() ? A[0] : FString(), GTex.On > 0.5f) ? 1.f : 0.f;
					Push(W);
					Say(FString::Printf(TEXT("tex.enabled = %s"), GTex.On > 0.5f ? TEXT("an") : TEXT("aus")));
				});
			Add(TEXT("tex.tiling"), TEXT("Anti-Kachelung an/aus"), [](const TArray<FString>& A, UWorld* W) {
				GTex.Tiling = ParseBool(A.Num() ? A[0] : FString(), GTex.Tiling > 0.5f) ? 1.f : 0.f;
				Push(W);
				Say(FString::Printf(TEXT("tex.tiling = %s"), GTex.Tiling > 0.5f ? TEXT("an") : TEXT("aus")));
			});
			Add(TEXT("tex.normal"), TEXT("Normal Maps: on/off oder Stärke 0..3"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) GTex.Normal = A[0] == TEXT("on") ? 1.f : A[0] == TEXT("off") ? 0.f : FMath::Clamp(FCString::Atof(*A[0]), 0.f, 3.f);
				Push(W);
				Say(FString::Printf(TEXT("tex.normal = %.2f"), GTex.Normal));
			});
			Add(TEXT("tex.debug"), TEXT("Textur-Ansicht: off, albedo, normal, rough, height, cells, uv"), [](const TArray<FString>& A, UWorld* W) {
				static const TCHAR* Views[] = {TEXT("off"), TEXT("albedo"), TEXT("normal"), TEXT("rough"), TEXT("height"), TEXT("cells"), TEXT("uv")};
				if (A.Num())
					for (int32 I = 0; I < UE_ARRAY_COUNT(Views); I++)
						if (A[0] == Views[I]) GTex.Debug = float(I);
				Push(W);
				Say(FString::Printf(TEXT("tex.debug = %s"), Views[FMath::Clamp(int32(GTex.Debug), 0, 6)]));
			});
			Add(TEXT("tex.road"), TEXT("Alle Straßen mit einem Belag: auto | asphalt | asphalt_worn | asphalt_cracked | sett | field | gravel | plaza"), [](const TArray<FString>& A, UWorld* W) {
				// roadCode.ts SURFACE: field = 4 (Feldweg), 5 is the pavement cell (unused on roads).
				static const TMap<FString, float> Kinds = {{TEXT("auto"), -1.f}, {TEXT("asphalt"), 0.f}, {TEXT("asphalt_worn"), 1.f}, {TEXT("asphalt_cracked"), 2.f},
					{TEXT("sett"), 3.f}, {TEXT("field"), 4.f}, {TEXT("feldweg"), 4.f}, {TEXT("gravel"), 6.f}, {TEXT("plaza"), 7.f}};
				if (A.Num()) { if (const float* K = Kinds.Find(A[0])) GTex.RoadForce = *K; }
				Push(W);
				Say(FString::Printf(TEXT("tex.road = %.0f (-1 = aus der Karte)"), GTex.RoadForce));
			});
			Add(TEXT("ground.view"), TEXT("Boden-Ansicht: normal | cover (Texturkanäle farbig) | aerial (rohe Luftbildfarbe)"), [](const TArray<FString>& A, UWorld* W) {
				if (A.Num()) GTex.GroundView = A[0] == TEXT("cover") ? 1.f : A[0] == TEXT("aerial") ? 2.f : 0.f;
				Push(W);
				Say(FString::Printf(TEXT("ground.view = %s"), GTex.GroundView > 1.5f ? TEXT("aerial") : GTex.GroundView > 0.5f ? TEXT("cover") : TEXT("normal")));
			});
			Add(TEXT("tex.materials"), TEXT("PBR-Materialien aus dem Setup (1) oder Platzhalterfarben (0)"), [](const TArray<FString>& A, UWorld* W) {
				GPbrMaterials = ParseBool(A.Num() ? A[0] : FString(), GPbrMaterials != 0) ? 1 : 0;
				if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W)) S->RefreshMaterials();
				Say(FString::Printf(TEXT("tex.materials = %d"), GPbrMaterials));
			});
			Add(TEXT("tex.info"), TEXT("Welche Materialien geladen sind und die aktuellen Werte"), [](const TArray<FString>&, UWorld* W) {
				FString Line = TEXT("Materialien:");
				for (const TCHAR* M : {TEXT("M_SlsGround"), TEXT("M_SlsRoad"), TEXT("M_SlsMarking"), TEXT("M_SlsSidewalk"), TEXT("M_SlsWater"), TEXT("M_SlsDetail"), TEXT("M_SlsVertexColor"), TEXT("M_SlsLight")})
				{
					const bool bOk = LoadObject<UObject>(nullptr, *FString::Printf(TEXT("/Game/Materials/%s.%s"), M, M), nullptr, LOAD_NoWarn | LOAD_Quiet) != nullptr;
					Line += FString::Printf(TEXT(" %s %s"), M, bOk ? TEXT("ok") : TEXT("FEHLT"));
				}
				Say(Line);
				const FTexParams& P = GTex;
				Say(FString::Printf(TEXT("on %.0f normal %.2f tiling %.0f macro %.2f groundtint %.2f wear %.2f debug %.0f road %.0f ruts %.2f grass %.2f aerial %.2f rows %.2f view %.0f"),
					P.On, P.Normal, P.Tiling, P.Macro, P.GroundTint, P.Wear, P.Debug, P.RoadForce, P.FieldRuts, P.FieldGrass, P.GroundAerial, P.GroundRows, P.GroundView));
			});
		}
	};
	FCommands GCommands;
}
