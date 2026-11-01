#include "SlsHUD.h"
#include "Vehicle/SlsCarPawn.h"
#include "Vehicle/SlsCarTuning.h"
#include "World/SlsWorldSubsystem.h"
#include "Engine/Canvas.h"
#include "Engine/Engine.h"
#include "Engine/Font.h"
#include "HAL/IConsoleManager.h"

static int32 GHudOn = 1;
static FAutoConsoleVariableRef CVarHud(TEXT("hud"), GHudOn, TEXT("HUD an (1) / aus (0)"));
static int32 GHudDebug = 0;
static FAutoConsoleVariableRef CVarHudDebug(TEXT("hud.debug"), GHudDebug, TEXT("Positionszeile wie im Debug-Overlay des Web-Spiels (0/1)"));

void ASlsHUD::DrawHUD()
{
	Super::DrawHUD();
	if (!GHudOn || !Canvas) return;
	const APawn* P = GetOwningPawn();
	const float S = Canvas->ClipY / 1080.f; // layout in 1080p units
	UFont* Big = GEngine->GetLargeFont();
	UFont* Small = GEngine->GetSmallFont();

	if (GHudDebug && P)
	{
		const FVector L = USlsWorldSubsystem::UEToLocal(P->GetActorLocation());
		DrawText(FString::Printf(TEXT("x %.1f  z %.1f  h %.1f"), L.X, L.Z, L.Y), FLinearColor::White, 20 * S, 20 * S, Small, 1.4f * S);
	}

	const ASlsCarPawn* Car = Cast<ASlsCarPawn>(P);
	if (!Car) return;
	const float X0 = Canvas->ClipX - 380 * S, Y0 = Canvas->ClipY - 230 * S;
	const double Kmh = FMath::Abs(Car->SpeedMs()) * 3.6;
	DrawText(FString::Printf(TEXT("%3.0f"), Kmh), FLinearColor::White, X0, Y0, Big, 4.f * S);
	DrawText(TEXT("km/h"), FLinearColor(0.8f, 0.8f, 0.8f), X0 + 200 * S, Y0 + 60 * S, Small, 1.6f * S);
	const int32 G = Car->Gear();
	DrawText(G < 0 ? TEXT("R") : G == 0 ? TEXT("N") : FString::FromInt(G), FLinearColor(1.f, 0.8f, 0.2f), X0 + 290 * S, Y0, Big, 3.f * S);

	// Rev bar (red above 90 % of the limiter), nitro tank (blue, white while boosting).
	const float BarW = 340 * S, BarH = 12 * S;
	const float Rev = FMath::Clamp(float(Car->Rpm() / SlsCar::MaxRpm), 0.f, 1.f);
	DrawRect(FLinearColor(0, 0, 0, 0.5f), X0, Y0 + 110 * S, BarW, BarH);
	DrawRect(Rev > 0.9f ? FLinearColor(1, 0.15f, 0.1f) : FLinearColor(1, 1, 1, 0.9f), X0, Y0 + 110 * S, BarW * Rev, BarH);
	DrawRect(FLinearColor(0, 0, 0, 0.5f), X0, Y0 + 132 * S, BarW, BarH);
	DrawRect(Car->bBoosting ? FLinearColor::White : FLinearColor(0.2f, 0.6f, 1.f), X0, Y0 + 132 * S, BarW * Car->Nitro, BarH);
	DrawText(TEXT("NITRO"), FLinearColor(0.6f, 0.8f, 1.f), X0, Y0 + 150 * S, Small, 1.2f * S);

	FString Tags = Car->IsFunFeel() ? TEXT("FUN") : TEXT("REAL");
	if (Car->DriftDir) Tags += TEXT("  DRIFT");
	if (Car->bAirborne) Tags += TEXT("  AIR");
	if (Car->bInfiniteNitro) Tags += TEXT("  NITRO ∞");
	if (Car->IsBenching()) Tags += TEXT("  BENCH");
	DrawText(Tags, FLinearColor(0.8f, 0.8f, 0.8f), X0 + 120 * S, Y0 + 150 * S, Small, 1.2f * S);
}
