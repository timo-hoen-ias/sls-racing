// Console commands of the car (phase 1): car.*, feel.*, nitro.*, assist.*, cam.*, fly. Names follow the web game's
// debug console where it has the same command, so notes and logs carry over.

#include "SlsRacing.h"
#include "Game/SlsGameMode.h"
#include "Vehicle/SlsCarPawn.h"
#include "World/SlsWorldSubsystem.h"
#include "ChaosWheeledVehicleMovementComponent.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "EngineUtils.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White, float Seconds = 8.f)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, Seconds, Color, Text);
	}

	APlayerController* PlayerController(UWorld* W) { return W ? W->GetFirstPlayerController() : nullptr; }

	/** The player's car, also while the free camera flies around. */
	ASlsCarPawn* Car(UWorld* W)
	{
		if (const APlayerController* PC = PlayerController(W))
			if (ASlsCarPawn* C = Cast<ASlsCarPawn>(PC->GetPawn())) return C;
		if (W) if (TActorIterator<ASlsCarPawn> It(W); It) return *It;
		return nullptr;
	}

	ASlsCarPawn* NeedCar(UWorld* W)
	{
		ASlsCarPawn* C = Car(W);
		if (!C) Say(TEXT("Kein Auto in der Welt"), FColor::Yellow);
		return C;
	}

	/** Shared shape: "<cmd>" prints, "<cmd> <value>" sets. */
	void FloatSetting(const TCHAR* Name, float& Value, const TArray<FString>& Args, ASlsCarPawn* C, bool bRetune)
	{
		if (Args.Num()) { Value = FCString::Atof(*Args[0]); if (bRetune) C->ApplyTuning(); }
		Say(FString::Printf(TEXT("%s = %.3f"), Name, Value));
	}

	struct FFeelField { const TCHAR* Name; float FSlsFeel::*Field; bool bRetune; const TCHAR* Help; };
	const FFeelField GFeelFields[] = {
		{TEXT("torque"), &FSlsFeel::Torque, true, TEXT("Motormoment-Faktor")},
		{TEXT("downforce"), &FSlsFeel::Downforce, true, TEXT("Abtrieb-Faktor")},
		{TEXT("drag"), &FSlsFeel::Drag, true, TEXT("Luftwiderstand-Faktor")},
		{TEXT("airlevel"), &FSlsFeel::AirLevel, false, TEXT("Selbstaufrichten in der Luft")},
		{TEXT("landing"), &FSlsFeel::Landing, false, TEXT("Landungsdämpfung")},
		{TEXT("brake"), &FSlsFeel::Brake, false, TEXT("Arcade-Bremse")},
		{TEXT("stick"), &FSlsFeel::Stick, false, TEXT("Straßenhaftung (Andrücken)")},
		{TEXT("straight"), &FSlsFeel::Straight, false, TEXT("Geradeaus beim Bremsen")},
		{TEXT("coast"), &FSlsFeel::Coast, false, TEXT("Ausrollbremse")},
		{TEXT("refill"), &FSlsFeel::NitroRefill, false, TEXT("Nitro-Nachfüllen je Sekunde")},
	};

	struct FCamField { const TCHAR* Name; float FSlsFeel::*Field; };
	const FCamField GCamFields[] = {
		{TEXT("cam.dist"), &FSlsFeel::CamDist}, {TEXT("cam.height"), &FSlsFeel::CamHeight}, {TEXT("cam.lag"), &FSlsFeel::CamLag},
		{TEXT("cam.swing"), &FSlsFeel::CamSwing}, {TEXT("cam.fov"), &FSlsFeel::CamSpeedFov}, {TEXT("cam.boostfov"), &FSlsFeel::CamBoostFov},
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
			Add(TEXT("car.bench"), TEXT("Referenzfahrten auf ebener Fläche gegen das Web-Auto (unreal/reference/car.json): car.bench [fun|real] [exit]"),
				[](const TArray<FString>& A, UWorld* W) {
					ASlsCarPawn* C = NeedCar(W);
					if (!C) return;
					C->SetFeel(!A.Contains(TEXT("real")));
					C->StartBench(A.Contains(TEXT("exit")));
					Say(FString::Printf(TEXT("car.bench läuft (%s): 0–100–200, Höchstgeschwindigkeit, Bremsweg aus 100, Kreisfahrt 80 km/h"), C->IsFunFeel() ? TEXT("fun") : TEXT("real")));
				});
			Add(TEXT("car.reset"), TEXT("Auto auf die nächste Straße setzen (wie R / Y)"), [](const TArray<FString>&, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) C->ResetToRoad();
			});
			Add(TEXT("car.info"), TEXT("Tempo, Drehzahl, Gang, Nitro, Radkontakt, Gefühl"), [](const TArray<FString>&, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (!C) return;
				int32 Contact = 0;
				for (int32 I = 0; I < C->Vehicle->GetNumWheels(); I++) Contact += C->Vehicle->GetWheelState(I).bInContact;
				const FVector L = USlsWorldSubsystem::UEToLocal(C->GetActorLocation());
				Say(FString::Printf(TEXT("car: %.1f km/h, %.0f U/min, Gang %d, Nitro %.0f %%, Räder am Boden %d/4, %s, Drift %d, x %.1f z %.1f h %.1f"),
					C->SpeedMs() * 3.6, C->Rpm(), C->Gear(), C->Nitro * 100, Contact, C->IsFunFeel() ? TEXT("fun") : TEXT("real"), C->DriftDir, L.X, L.Z, L.Y));
			});
			Add(TEXT("car.gear"), TEXT("Gang setzen (Automatik schaltet weiter): car.gear <n>"), [](const TArray<FString>& A, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (C && A.Num()) C->Vehicle->SetTargetGear(FCString::Atoi(*A[0]), true);
			});
			Add(TEXT("feel"), TEXT("Fahrgefühl: feel fun | real (ohne Argument: alle Werte)"), [](const TArray<FString>& A, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (!C) return;
				if (A.Num()) C->SetFeel(A[0] != TEXT("real"));
				FString Line = FString::Printf(TEXT("feel %s:"), C->IsFunFeel() ? TEXT("fun") : TEXT("real"));
				for (const FFeelField& F : GFeelFields) Line += FString::Printf(TEXT(" %s %.2f"), F.Name, C->Feel.*F.Field);
				Line += FString::Printf(TEXT(" burst %d drift %d"), C->Feel.bBurst, C->Feel.bDrift);
				Say(Line);
			});
			for (const FFeelField& F : GFeelFields)
			{
				const FFeelField Field = F;
				Add(*FString::Printf(TEXT("feel.%s"), F.Name), *FString::Printf(TEXT("%s: feel.%s [Wert]"), F.Help, F.Name), [Field](const TArray<FString>& A, UWorld* W) {
					if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(*FString::Printf(TEXT("feel.%s"), Field.Name), C->Feel.*Field.Field, A, C, Field.bRetune);
				});
			}
			Add(TEXT("feel.burst"), TEXT("Nitro-Stoß beim Antippen: feel.burst 0|1"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) { if (A.Num()) C->Feel.bBurst = FCString::Atoi(*A[0]) != 0; Say(FString::Printf(TEXT("feel.burst = %d"), C->Feel.bBurst)); }
			});
			Add(TEXT("drift"), TEXT("Drift-Hilfe per Handbremse: drift 0|1"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) { if (A.Num()) C->Feel.bDrift = FCString::Atoi(*A[0]) != 0; Say(FString::Printf(TEXT("drift = %d"), C->Feel.bDrift)); }
			});
			Add(TEXT("nitro"), TEXT("Nitro-Tank: nitro [0..1]"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(TEXT("nitro"), C->Nitro, A, C, false);
			});
			Add(TEXT("nitro.refill"), TEXT("Nitro-Tank füllen"), [](const TArray<FString>&, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) { C->Nitro = 1; Say(TEXT("Nitro voll")); }
			});
			Add(TEXT("nitro.infinite"), TEXT("Unendlich Nitro: nitro.infinite 0|1"), [](const TArray<FString>& A, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (!C) return;
				C->bInfiniteNitro = A.Num() ? FCString::Atoi(*A[0]) != 0 : !C->bInfiniteNitro;
				Say(FString::Printf(TEXT("nitro.infinite = %d"), C->bInfiniteNitro));
			});
			Add(TEXT("assist.esp"), TEXT("Stabilitätshilfe 0..1: assist.esp [Wert]"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(TEXT("assist.esp"), C->Assists.Esp, A, C, false);
			});
			Add(TEXT("assist.drift"), TEXT("Drift-Hilfe 0..1: assist.drift [Wert]"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(TEXT("assist.drift"), C->Assists.Drift, A, C, false);
			});
			Add(TEXT("assist.tcs"), TEXT("Traktionskontrolle 0..1: assist.tcs [Wert]"), [](const TArray<FString>& A, UWorld* W) {
				if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(TEXT("assist.tcs"), C->Assists.Tcs, A, C, true);
			});
			Add(TEXT("assist.abs"), TEXT("ABS: assist.abs 0|1"), [](const TArray<FString>& A, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (!C) return;
				if (A.Num()) { C->Assists.bAbs = FCString::Atoi(*A[0]) != 0; C->ApplyTuning(); }
				Say(FString::Printf(TEXT("assist.abs = %d"), C->Assists.bAbs));
			});
			Add(TEXT("cam.mode"), TEXT("Kamera: cam.mode 0 Verfolger | 1 weit | 2 Haube | 3 Cockpit (wie C)"), [](const TArray<FString>& A, UWorld* W) {
				ASlsCarPawn* C = NeedCar(W);
				if (!C) return;
				if (A.Num()) C->CamMode = FMath::Clamp(FCString::Atoi(*A[0]), 0, 3);
				Say(FString::Printf(TEXT("cam.mode = %d"), C->CamMode));
			});
			for (const FCamField& F : GCamFields)
			{
				const FCamField Field = F;
				Add(F.Name, *FString::Printf(TEXT("Verfolgerkamera: %s [Wert]"), F.Name), [Field](const TArray<FString>& A, UWorld* W) {
					if (ASlsCarPawn* C = NeedCar(W)) FloatSetting(Field.Name, C->Feel.*Field.Field, A, C, false);
				});
			}
			Add(TEXT("fly"), TEXT("Freie Kamera an/aus (das Auto bleibt mit Handbremse stehen; 'fly' zurück setzt dich wieder hinein)"),
				[](const TArray<FString>&, UWorld* W) {
					APlayerController* PC = PlayerController(W);
					if (!PC) return;
					APawn* Old = PC->GetPawn();
					if (ASlsFlyPawn* Fly = Cast<ASlsFlyPawn>(Old))
					{
						if (ASlsCarPawn* C = Car(W)) { PC->Possess(C); Fly->Destroy(); Say(TEXT("fly aus: zurück im Auto")); }
						return;
					}
					FVector Loc; FRotator Rot;
					PC->GetPlayerViewPoint(Loc, Rot);
					FActorSpawnParameters P;
					P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
					ASlsFlyPawn* Fly = W->SpawnActor<ASlsFlyPawn>(Loc, Rot, P);
					PC->Possess(Fly);
					PC->SetControlRotation(Rot);
					Say(TEXT("fly an: WASD + Maus, E/Q hoch/runter, fly.speed; 'fly' wieder ins Auto"));
				});
		}
	};
	FCommands GCommands;
}
