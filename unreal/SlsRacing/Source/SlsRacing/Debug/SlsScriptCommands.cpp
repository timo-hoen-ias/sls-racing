// Delayed console commands for scripted window runs (screenshots, checks): -ExecCmds only runs at start-up, so
// "after 12 HighResShot 1920x1080" waits until the world has streamed in.
//   after <seconds> <command …>

#include "SlsRacing.h"
#include "Containers/Ticker.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "HAL/IConsoleManager.h"

namespace
{
	FAutoConsoleCommandWithWorldAndArgs GAfter(TEXT("after"), TEXT("Befehl später ausführen: after <Sekunden> <Befehl …>"),
		FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([](const TArray<FString>& A, UWorld* W) {
			if (A.Num() < 2) { UE_LOG(LogSls, Warning, TEXT("after <Sekunden> <Befehl …>")); return; }
			const float Delay = FCString::Atof(*A[0]);
			const FString Cmd = FString::Join(TArrayView<const FString>(A).RightChop(1), TEXT(" "));
			TWeakObjectPtr<UWorld> Weak(W);
			FTSTicker::GetCoreTicker().AddTicker(FTickerDelegate::CreateLambda([Weak, Cmd](float) {
				UE_LOG(LogSls, Display, TEXT("after: %s"), *Cmd);
				// through the player controller, so viewport commands (HighResShot, Shot) reach the game viewport too
				UWorld* World = Weak.Get();
				if (APlayerController* PC = World ? World->GetFirstPlayerController() : nullptr) PC->ConsoleCommand(Cmd);
				else if (GEngine) GEngine->Exec(World, *Cmd);
				return false; // once
			}), Delay);
		}));
}
