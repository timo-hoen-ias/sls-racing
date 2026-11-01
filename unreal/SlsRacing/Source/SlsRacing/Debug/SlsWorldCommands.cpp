// Debug console commands of the world port. Names and meanings follow the web game's commands where one exists
// (road.scan, world.surface, stream.*, cam.top), plus road.parity, the Unreal-vs-web drivability comparison.
// Open the console with ^ (or F1 / ~).
#include "SlsRacing.h"
#include "World/SlsSurface.h"
#include "World/SlsTileActor.h"
#include "World/SlsWorldSubsystem.h"
#include "Vehicle/SlsCarPawn.h"
#include "Containers/Ticker.h"
#include "DrawDebugHelpers.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/Pawn.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "ProceduralMeshComponent.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White, float Seconds = 8.f)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, Seconds, Color, Text);
	}

	APawn* PlayerPawn(UWorld* W)
	{
		const APlayerController* PC = W ? W->GetFirstPlayerController() : nullptr;
		return PC ? PC->GetPawn() : nullptr;
	}

	/** Player position in the web game's local metres. */
	FVector PlayerLocal(UWorld* W)
	{
		const APawn* P = PlayerPawn(W);
		return USlsWorldSubsystem::UEToLocal(P ? P->GetActorLocation() : FVector::ZeroVector);
	}

	FColor KindColor(SlsSurface::EKind K)
	{
		using SlsSurface::EKind;
		switch (K)
		{
		case EKind::Hole: case EKind::Gap: return FColor::Red;
		case EKind::Snag: return FColor::Magenta;
		case EKind::Step: return FColor::Orange;
		case EKind::Bump: case EKind::Dip: return FColor::Yellow;
		case EKind::Edge: return FColor::Cyan;
		default: return FColor::White;
		}
	}

	void Teleport(UWorld* W, double X, double Z, double Above = 3.0)
	{
		APawn* P = PlayerPawn(W);
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!P || !S) return;
		if (ASlsCarPawn* Car = Cast<ASlsCarPawn>(P))
		{
			// The car keeps its heading and lands on the road surface (PlaceAt loads the 3 × 3 tiles).
			const double Heading = FMath::DegreesToRadians(Car->GetActorRotation().Yaw + 90.0);
			Car->PlaceAt(FVector(X, P->GetActorLocation().Z / 100.0, Z), Heading);
			return;
		}
		const FIntPoint T = S->TileOfLocal(X, Z);
		S->LoadTileSync(T, true);
		const double Ground = S->GroundZ(X * 100.0, Z * 100.0, P->GetActorLocation().Z);
		P->SetActorLocation(FVector(X * 100.0, Z * 100.0, Ground + Above * 100.0), false, nullptr, ETeleportType::TeleportPhysics);
	}
}

// --- road.parity --------------------------------------------------------------------------------------------

/** Walks tiles one by one (3 × 3 colliders each), compares every reference cell with the web game's heights. */
class FSlsParityJob
{
public:
	TWeakObjectPtr<UWorld> World;
	TArray<FIntPoint> Queue;
	int32 Next = 0, Wait = 0;
	double Tol = 0.005;
	int32 Max = 0;
	bool bExit = false, bDraw = true;
	double Started = 0;
	SlsSurface::FParity Result;
	FTSTicker::FDelegateHandle Handle;
	static TUniquePtr<FSlsParityJob> Active;

	void Start()
	{
		Started = FPlatformTime::Seconds();
		if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(World.Get())) { S->bPaused = true; S->UnloadAll(); }
		Handle = FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateRaw(this, &FSlsParityJob::Step));
		Say(FString::Printf(TEXT("road.parity: %d Kacheln …"), Queue.Num()), FColor::Cyan);
	}

	bool Step(float)
	{
		UWorld* W = World.Get();
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!W || !S) { Finish(); return false; }
		if (Next >= Queue.Num()) { Finish(); return false; }
		const FIntPoint T = Queue[Next];
		if (Wait == 0)
		{
			// Colliders of the 3 × 3 neighbourhood, as the game has them around the car; drop the rest.
			TArray<FIntPoint> Drop;
			for (const auto& [K, A] : S->Loaded()) if (FMath::Abs(K.X - T.X) > 1 || FMath::Abs(K.Y - T.Y) > 1) Drop.Add(K);
			for (const FIntPoint& K : Drop) S->UnloadTile(K);
			for (int32 DX = -1; DX <= 1; DX++)
				for (int32 DY = -1; DY <= 1; DY++) S->LoadTileSync(T + FIntPoint(DX, DY), true);
			Wait = 1;
			return true;
		}
		// Two frames for the physics scene to take the new bodies into its query structure.
		if (Wait++ < 3) return true;
		Wait = 0;
		if (const ASlsTileActor* A = S->FindTile(T))
		{
			const int32 Before = Result.Points.Num();
			TArray<const AActor*> Ignore;
			if (APawn* P = PlayerPawn(W)) Ignore.Add(P);
			SlsSurface::Parity(W, A, Tol, Ignore, Result);
			if (bDraw)
				for (int32 I = Before; I < Result.Points.Num(); I++)
					DrawDebugSphere(W, USlsWorldSubsystem::LocalToUE(Result.Points[I]), 40.f, 6, FColor::Red, false, 120.f);
		}
		Next++;
		if (Next % 50 == 0) Say(FString::Printf(TEXT("road.parity: %d/%d Kacheln, %d Zellen, %d Abweichungen"), Next, Queue.Num(), Result.Cells, Result.Bad), FColor::Cyan, 3.f);
		return true;
	}

	void Finish()
	{
		const bool bFail = Result.Bad > Max;
		const FString Line = FString::Printf(TEXT("road.parity: %d Kacheln, %d Straßenzellen, %d Abweichungen über %.0f mm (%d nur auf einer Seite getroffen, größte %.1f mm) in %.0f s → %s"),
			Result.Tiles, Result.Cells, Result.Bad, Tol * 1000.0, Result.Missing, Result.Worst * 1000.0, FPlatformTime::Seconds() - Started, bFail ? TEXT("FAIL") : TEXT("OK"));
		Say(Line, bFail ? FColor::Red : FColor::Green, 30.f);
		for (const FString& E : Result.Examples) Say(TEXT("  ") + E, FColor::Orange, 30.f);
		// Report for CI and for comparing runs.
		FString Json = FString::Printf(TEXT("{\"tiles\":%d,\"cells\":%d,\"bad\":%d,\"missing\":%d,\"worstMm\":%.1f,\"tolMm\":%.1f,\"examples\":["), Result.Tiles, Result.Cells, Result.Bad, Result.Missing, Result.Worst * 1000.0, Tol * 1000.0);
		for (int32 I = 0; I < Result.Examples.Num(); I++) Json += (I ? TEXT(",\"") : TEXT("\"")) + Result.Examples[I].ReplaceCharWithEscapedChar() + TEXT("\"");
		Json += TEXT("]}");
		FFileHelper::SaveStringToFile(Json, *FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("road-parity.json")));
		if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(World.Get())) S->bPaused = false;
		if (bExit) FPlatformMisc::RequestExitWithStatus(false, bFail ? 1 : 0);
		FTSTicker::GetCoreTicker().RemoveTicker(Handle);
		Active.Reset();
	}
};
TUniquePtr<FSlsParityJob> FSlsParityJob::Active;

static FAutoConsoleCommandWithWorldAndArgs CmdRoadParity(
	TEXT("road.parity"),
	TEXT("Vergleicht die Befahrbarkeit in Unreal mit dem Web-Spiel, Zelle für Zelle (Rad- und Chassis-Strahl). road.parity [radius m | all | tiles=<n>] [tol=<mm>] [max=<erlaubte Abweichungen>] [exit] [nodraw]"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S || !S->IsReady()) { Say(TEXT("road.parity: keine Welt geladen"), FColor::Red); return; }
		if (FSlsParityJob::Active) { Say(TEXT("road.parity läuft schon"), FColor::Orange); return; }
		TUniquePtr<FSlsParityJob> J = MakeUnique<FSlsParityJob>();
		J->World = W;
		double Radius = 300;
		bool bAll = false;
		int32 Limit = MAX_int32;
		for (const FString& A : Args)
		{
			if (A == TEXT("all")) bAll = true;
			else if (A == TEXT("exit")) J->bExit = true;
			else if (A == TEXT("nodraw")) J->bDraw = false;
			else if (A.StartsWith(TEXT("tol="))) J->Tol = FCString::Atod(*A.Mid(4)) / 1000.0;
			else if (A.StartsWith(TEXT("max="))) J->Max = FCString::Atoi(*A.Mid(4));
			else if (A.StartsWith(TEXT("tiles="))) { bAll = true; Limit = FCString::Atoi(*A.Mid(6)); }
			else if (A.IsNumeric()) Radius = FCString::Atod(*A);
		}
		// Same order as the exporter (north to south, west to east).
		TArray<FIntPoint> Tiles = S->Info().Tiles;
		Tiles.Sort([](const FIntPoint& A, const FIntPoint& B) { return A.Y != B.Y ? A.Y > B.Y : A.X < B.X; });
		const FVector L = PlayerLocal(W);
		for (const FIntPoint& T : Tiles)
		{
			if (J->Queue.Num() >= Limit) break;
			const FVector2D C = S->TileOriginLocal(T) + FVector2D(S->Info().TileSize / 2);
			if (bAll || FVector2D::Distance(C, FVector2D(L.X, L.Z)) < Radius) J->Queue.Add(T);
		}
		if (J->bExit) J->bDraw = false;
		FSlsParityJob::Active = MoveTemp(J);
		FSlsParityJob::Active->Start();
	}));

// --- road.scan ----------------------------------------------------------------------------------------------

static FAutoConsoleCommandWithWorldAndArgs CmdRoadScan(
	TEXT("road.scan"),
	TEXT("Prüft jede 0,5-m-Zelle der Fahrbahnen um die Kamera auf Löcher, Stufen, Kanten und Hänger (wie im Web-Spiel). road.scan [radius m, Standard 40]"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S) return;
		const double Radius = Args.Num() ? FCString::Atod(*Args[0]) : 40.0;
		const FVector L = PlayerLocal(W);
		int32 Cells = 0;
		const double T0 = FPlatformTime::Seconds();
		const TArray<SlsSurface::FIssue> Issues = SlsSurface::Scan(W, S, L.X, L.Z, Radius, Cells);
		int32 Critical = 0;
		for (const SlsSurface::FIssue& I : Issues)
		{
			const bool bC = SlsSurface::IsCritical(I.Kind, I.Size);
			Critical += bC;
			const FVector P = USlsWorldSubsystem::LocalToUE(FVector(I.X, I.Y, I.Z));
			DrawDebugSphere(W, P, bC ? 45.f : 25.f, 8, KindColor(I.Kind), false, 30.f);
			DrawDebugString(W, P + FVector(0, 0, 60), FString::Printf(TEXT("%s %.2f m (%s)"), SlsSurface::KindName(I.Kind), I.Size, *I.What.ToString()), nullptr, KindColor(I.Kind), 30.f);
		}
		Say(FString::Printf(TEXT("road.scan %.0f m: %d Zellen, %d Stellen, davon %d kritisch (%.0f ms)"), Radius, Cells, Issues.Num(), Critical, (FPlatformTime::Seconds() - T0) * 1000.0),
			Critical ? FColor::Red : Issues.Num() ? FColor::Yellow : FColor::Green);
	}));

// --- world.surface ------------------------------------------------------------------------------------------

namespace
{
	struct FSurfaceList { TArray<TArray<double>> Issues; TArray<FString> Kinds; int32 Cursor = 0; bool bLoaded = false; };
	FSurfaceList GSurface;

	bool LoadSurface(USlsWorldSubsystem* S)
	{
		if (GSurface.bLoaded) return true;
		FString Text;
		if (!FFileHelper::LoadFileToString(Text, *FPaths::Combine(S->DataDir(), TEXT("surface.json")))) return false;
		TSharedPtr<FJsonObject> J;
		if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J.IsValid()) return false;
		for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("kinds"))) GSurface.Kinds.Add(V->AsString());
		for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("issues")))
		{
			TArray<double>& Row = GSurface.Issues.AddDefaulted_GetRef();
			for (const TSharedPtr<FJsonValue>& X : V->AsArray()) Row.Add(X->AsNumber());
		}
		GSurface.bLoaded = true;
		return true;
	}
}

static FAutoConsoleCommandWithWorldAndArgs CmdWorldSurface(
	TEXT("world.surface"),
	TEXT("Stellen aus der Flächenprüfung der Pipeline (surface.json): world.surface [list | next | show | <art: hole, step, snag, edge …>]"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S || !LoadSurface(S)) { Say(TEXT("world.surface: surface.json fehlt im Export"), FColor::Red); return; }
		const FString Mode = Args.Num() ? Args[0] : TEXT("list");
		const int32 KindFilter = GSurface.Kinds.IndexOfByKey(Mode);
		TArray<int32> Sel;
		for (int32 I = 0; I < GSurface.Issues.Num(); I++) if (KindFilter < 0 || int32(GSurface.Issues[I][3]) == KindFilter) Sel.Add(I);
		auto Describe = [](const TArray<double>& R) {
			return FString::Printf(TEXT("%s %.2f m bei x %.1f z %.1f (Höhe %.2f, OSM-Weg %lld)"), *GSurface.Kinds[int32(R[3])], R[4], R[0], R[2], R[1], int64(R[5]));
		};
		if (Mode == TEXT("next") || KindFilter >= 0)
		{
			if (!Sel.Num()) { Say(TEXT("world.surface: keine Stellen")); return; }
			const TArray<double>& R = GSurface.Issues[Sel[GSurface.Cursor++ % Sel.Num()]];
			Teleport(W, R[0], R[2], 6.0);
			DrawDebugSphere(W, USlsWorldSubsystem::LocalToUE(FVector(R[0], R[1], R[2])), 60.f, 10, FColor::Red, false, 30.f);
			Say(TEXT("world.surface: ") + Describe(R), FColor::Orange);
			return;
		}
		if (Mode == TEXT("show"))
		{
			int32 N = 0;
			const FVector L = PlayerLocal(W);
			for (const TArray<double>& R : GSurface.Issues)
				if (FVector2D::Distance(FVector2D(R[0], R[2]), FVector2D(L.X, L.Z)) < 800.0)
				{
					DrawDebugSphere(W, USlsWorldSubsystem::LocalToUE(FVector(R[0], R[1], R[2])), 50.f, 8, FColor::Red, false, 60.f);
					N++;
				}
			Say(FString::Printf(TEXT("world.surface: %d Stellen im Umkreis von 800 m markiert"), N));
			return;
		}
		Say(FString::Printf(TEXT("world.surface: %d Stellen"), GSurface.Issues.Num()));
		for (int32 I = 0; I < FMath::Min(15, GSurface.Issues.Num()); I++) Say(TEXT("  ") + Describe(GSurface.Issues[I]), FColor::Silver);
	}));

// --- teleport, camera, streaming, layers --------------------------------------------------------------------

static FAutoConsoleCommandWithWorldAndArgs CmdTp(
	TEXT("tp"),
	TEXT("Springt an eine Stelle: tp <x> <z> (lokale Meter wie im Web-Spiel, x Ost, z Süd) | tp utm <E> <N> | tp spawn"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S || !S->IsReady()) return;
		if (Args.Num() >= 1 && Args[0] == TEXT("spawn")) { Teleport(W, S->Info().SpawnLocal.X, S->Info().SpawnLocal.Z); return; }
		if (Args.Num() >= 3 && Args[0] == TEXT("utm"))
		{
			const FVector2D L = S->UtmToLocal(FCString::Atod(*Args[1]), FCString::Atod(*Args[2]));
			Teleport(W, L.X, L.Y);
			return;
		}
		if (Args.Num() >= 2) { Teleport(W, FCString::Atod(*Args[0]), FCString::Atod(*Args[1])); return; }
		const FVector L = PlayerLocal(W);
		const FVector2D U = S->LocalToUtm(L.X, L.Z);
		Say(FString::Printf(TEXT("Position: x %.1f z %.1f, Höhe %.1f (UTM %.1f %.1f, Kachel %d_%d)"), L.X, L.Z, L.Y, U.X, U.Y, S->TileOfLocal(L.X, L.Z).X, S->TileOfLocal(L.X, L.Z).Y));
	}));

static FAutoConsoleCommandWithWorldAndArgs CmdCamTop(
	TEXT("cam.top"),
	TEXT("Vogelperspektive: cam.top <Höhe m über Grund, Standard 120>"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		APawn* P = PlayerPawn(W);
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!P || !S) return;
		if (P->IsA<ASlsCarPawn>()) { Say(TEXT("cam.top braucht die freie Kamera: erst 'fly' eingeben"), FColor::Yellow); return; }
		const double H = Args.Num() ? FCString::Atod(*Args[0]) : 120.0;
		const FVector Loc = P->GetActorLocation();
		const double Ground = S->GroundZ(Loc.X, Loc.Y, Loc.Z - H * 100.0);
		P->SetActorLocation(FVector(Loc.X, Loc.Y, Ground + H * 100.0));
		if (AController* C = P->GetController()) C->SetControlRotation(FRotator(-89.9, -90.0, 0.0));
	}));

static FAutoConsoleCommandWithWorldAndArgs CmdStreamInfo(
	TEXT("stream.info"),
	TEXT("Geladene Kacheln, davon mit Kollidern, laufende Lesevorgänge"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>&, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S) return;
		int32 Phys = 0;
		for (const auto& [T, A] : S->Loaded()) Phys += A && A->HasCollision();
		Say(FString::Printf(TEXT("stream: %d Kacheln geladen, %d mit Kollidern, %d in Arbeit, Welt %d Kacheln, Daten %s"), S->Loaded().Num(), Phys, S->InFlight(), S->Info().Tiles.Num(), *S->DataDir()));
	}));

static FAutoConsoleCommandWithWorldAndArgs CmdPhysColliders(
	TEXT("phys.colliders"),
	TEXT("Kollisionsdreiecke zeigen: phys.colliders show | hide (Fahrbahnen nur für Räder: gelb getönt über show road)"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S) return;
		const bool bShow = !Args.Num() || Args[0] == TEXT("show");
		const FName Only = Args.Num() > 1 ? FName(*Args[1]) : NAME_None;
		int32 N = 0;
		for (const auto& [T, A] : S->Loaded())
			for (UProceduralMeshComponent* C : A->CollisionComponents)
				if (C && (Only.IsNone() || C->ComponentHasTag(Only)))
				{
					C->SetVisibility(bShow);
					if (C->GetNumSections()) C->SetMeshSectionVisible(0, bShow);
					N++;
				}
		Say(FString::Printf(TEXT("phys.colliders: %d Kollider-Gruppen %s"), N, bShow ? TEXT("sichtbar") : TEXT("versteckt")));
	}));

static FAutoConsoleCommandWithWorldAndArgs CmdLayer(
	TEXT("world.layer"),
	TEXT("Eine Kachelebene ein-/ausblenden: world.layer <terrain|roads|markings|sidewalks|paths|buildings|details|water|…> [on|off]"),
	FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& Args, UWorld* W) {
		USlsWorldSubsystem* S = USlsWorldSubsystem::Get(W);
		if (!S || !Args.Num()) return;
		const bool bOn = Args.Num() < 2 || Args[1] != TEXT("off");
		for (const auto& [T, A] : S->Loaded())
			if (const int32* Sec = A->LayerSections.Find(Args[0])) A->Render->SetMeshSectionVisible(*Sec, bOn);
		Say(FString::Printf(TEXT("world.layer %s %s"), *Args[0], bOn ? TEXT("an") : TEXT("aus")));
	}));
