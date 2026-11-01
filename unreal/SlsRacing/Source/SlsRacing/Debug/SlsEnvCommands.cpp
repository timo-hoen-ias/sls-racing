// Console commands for time of day and weather, named like the web game's (src/render/debugCommands.ts,
// src/weather/commands.ts): time, time.set, day/night/dusk/dawn, time.cycle, sky.*, weather.*.

#include "SlsRacing.h"
#include "World/SlsEnvironment.h"
#include "Engine/Engine.h"
#include "Engine/World.h"
#include "HAL/IConsoleManager.h"

namespace
{
	void Say(const FString& Text, FColor Color = FColor::White)
	{
		UE_LOG(LogSls, Display, TEXT("%s"), *Text);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 8.f, Color, Text);
	}

	FString Clock(double H)
	{
		const int32 M = FMath::RoundToInt(FMath::Fmod(FMath::Fmod(H, 24.0) + 24.0, 24.0) * 60.0);
		return FString::Printf(TEXT("%02d:%02d"), (M / 60) % 24, M % 60);
	}

	/** "21", "21.5", "21,5" or "21:30" → hours, -1 if invalid. */
	double ParseTime(const FString& S)
	{
		FString A, B;
		double H;
		if (S.Split(TEXT(":"), &A, &B)) H = FCString::Atod(*A) + FCString::Atod(*B) / 60.0;
		else H = FCString::Atod(*S.Replace(TEXT(","), TEXT(".")));
		return H >= 0 && H <= 24 ? H : -1;
	}

	bool IsOn(const FString& S) { return S == TEXT("on") || S == TEXT("an") || S == TEXT("ein") || S == TEXT("1") || S == TEXT("true"); }
	bool IsOff(const FString& S) { return S == TEXT("off") || S == TEXT("aus") || S == TEXT("0") || S == TEXT("false"); }

	FString Status(const USlsEnvironment* E)
	{
		return FString::Printf(TEXT("Uhrzeit %s · Zyklus %s · Bewölkung %.2f · Wetter %s %.2f (Regen %.2f, Schnee %.2f, nass %.2f, Schneedecke %.2f, auto %s)"),
			*Clock(E->Hours), E->CycleSpeed > 0 ? *FString::Printf(TEXT("%.1f h/min"), E->CycleSpeed) : TEXT("aus"), E->CloudCover(),
			FSlsWeather::Name(E->Weather.Kind), E->Weather.Intensity, E->Weather.Rain, E->Weather.Snow, E->Weather.Wet, E->Weather.SnowCover,
			E->Weather.bAuto ? TEXT("an") : TEXT("aus"));
	}

	struct FCommands
	{
		TArray<TUniquePtr<FAutoConsoleCommandWithWorldAndArgs>> All;
		void Add(const TCHAR* Name, const TCHAR* Help, TFunction<void(const TArray<FString>&, USlsEnvironment*)> F)
		{
			All.Add(MakeUnique<FAutoConsoleCommandWithWorldAndArgs>(Name, Help,
				FConsoleCommandWithWorldAndArgsDelegate::CreateLambda([F](const TArray<FString>& A, UWorld* W) {
					if (USlsEnvironment* E = USlsEnvironment::Get(W)) F(A, E);
				})));
		}
		void Factor(const TCHAR* Name, const TCHAR* Help, float USlsEnvironment::*Field, float Min, float Max)
		{
			const FString N = Name;
			Add(Name, Help, [N, Field, Min, Max](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num()) E->*Field = FMath::Clamp(FCString::Atof(*A[0]), Min, Max);
				Say(FString::Printf(TEXT("%s = %.2f"), *N, E->*Field));
			});
		}
		void Preset(const TCHAR* Name, double H, const TCHAR* Help)
		{
			Add(Name, Help, [H](const TArray<FString>&, USlsEnvironment* E) { E->GoTo(H); Say(TEXT("Tageszeit → ") + Clock(H)); });
		}

		FCommands()
		{
			for (const TCHAR* N : {TEXT("time"), TEXT("zeit"), TEXT("uhrzeit")})
				Add(N, TEXT("Tageszeit anzeigen oder setzen, z. B. \"time 21:30\" (blendet weich über)"), [](const TArray<FString>& A, USlsEnvironment* E) {
					if (!A.Num()) { Say(Status(E)); return; }
					const double H = ParseTime(A[0]);
					if (H < 0) { Say(FString::Printf(TEXT("\"%s\" ist keine Uhrzeit (z. B. 21:30 oder 6.5)"), *A[0]), FColor::Yellow); return; }
					E->GoTo(H);
					Say(TEXT("Tageszeit → ") + Clock(H));
				});
			Add(TEXT("time.set"), TEXT("Tageszeit sofort setzen, ohne Überblenden"), [](const TArray<FString>& A, USlsEnvironment* E) {
				const double H = A.Num() ? ParseTime(A[0]) : -1;
				if (H < 0) { Say(TEXT("Uhrzeit fehlt"), FColor::Yellow); return; }
				E->Set(H);
				Say(Status(E));
			});
			Preset(TEXT("day"), 13, TEXT("Auf Tag umschalten (13:00)"));
			Preset(TEXT("tag"), 13, TEXT("Auf Tag umschalten (13:00)"));
			Preset(TEXT("night"), 23, TEXT("Auf Nacht umschalten (23:00)"));
			Preset(TEXT("nacht"), 23, TEXT("Auf Nacht umschalten (23:00)"));
			Preset(TEXT("dusk"), 19.4, TEXT("Abendrot (19:24)"));
			Preset(TEXT("abend"), 19.4, TEXT("Abendrot (19:24)"));
			Preset(TEXT("dawn"), 7.4, TEXT("Sonnenaufgang (07:24)"));
			Preset(TEXT("morgen"), 7.4, TEXT("Sonnenaufgang (07:24)"));
			Add(TEXT("time.cycle"), TEXT("Tag/Nacht-Zyklus an/aus oder Tempo (Spielstunden pro echter Minute)"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (!A.Num()) E->CycleSpeed = E->CycleSpeed > 0 ? 0 : 1;
				else if (IsOff(A[0])) E->CycleSpeed = 0;
				else if (IsOn(A[0])) E->CycleSpeed = 1;
				else E->CycleSpeed = FMath::Clamp(FCString::Atod(*A[0]), 0.0, 600.0);
				Say(Status(E));
			});
			Factor(TEXT("sky.overcast"), TEXT("Bewölkung: 0 klar … 1 komplett bedeckt"), &USlsEnvironment::Overcast, 0, 1);
			Factor(TEXT("sky.sun"), TEXT("Stärke des Sonnenlichts (Faktor, Standard 1)"), &USlsEnvironment::SunScale, 0, 5);
			Factor(TEXT("sky.ambient"), TEXT("Stärke des Himmelslichts (Faktor, Standard 1)"), &USlsEnvironment::AmbientScale, 0, 5);
			Factor(TEXT("sky.exposure"), TEXT("Belichtungskorrektur in Blendenstufen (Standard 0)"), &USlsEnvironment::ExposureBias, -5, 5);
			Factor(TEXT("sky.fog"), TEXT("Dunst/Nebel-Dichte (Faktor, Standard 1)"), &USlsEnvironment::FogScale, 0, 20);
			Add(TEXT("weather"), TEXT("Wetter: clear | rain | snow [stärke 0..1] [now]"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num())
				{
					const ESlsWeatherKind K = A[0] == TEXT("rain") || A[0] == TEXT("regen") ? ESlsWeatherKind::Rain
						: A[0] == TEXT("snow") || A[0] == TEXT("schnee") ? ESlsWeatherKind::Snow : ESlsWeatherKind::Clear;
					const float I = A.Num() > 1 && A[1] != TEXT("now") ? FCString::Atof(*A[1]) : E->Weather.Intensity;
					E->Weather.Set(K, I, A.Contains(TEXT("now")));
					E->Weather.bAuto = false;
				}
				Say(Status(E));
			});
			Add(TEXT("weather.now"), TEXT("Wetter sofort setzen (Straße gleich nass/verschneit): weather.now clear|rain|snow [stärke]"), [](const TArray<FString>& A, USlsEnvironment* E) {
				const ESlsWeatherKind K = !A.Num() ? E->Weather.Kind : A[0] == TEXT("rain") ? ESlsWeatherKind::Rain : A[0] == TEXT("snow") ? ESlsWeatherKind::Snow : ESlsWeatherKind::Clear;
				E->Weather.Set(K, A.Num() > 1 ? FCString::Atof(*A[1]) : E->Weather.Intensity, true);
				E->Weather.bAuto = false;
				Say(Status(E));
			});
			Add(TEXT("weather.intensity"), TEXT("Stärke von Regen/Schnee 0..1"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num()) E->Weather.Intensity = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 1.f);
				Say(FString::Printf(TEXT("weather.intensity = %.2f"), E->Weather.Intensity));
			});
			Add(TEXT("weather.wet"), TEXT("Nässe der Straße 0..1 setzen"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num()) E->Weather.Wet = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 1.f);
				Say(FString::Printf(TEXT("weather.wet = %.2f (Pfützen %.2f)"), E->Weather.Wet, E->Weather.Puddles()));
			});
			Add(TEXT("weather.snowcover"), TEXT("Schneedecke 0..1 setzen"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num()) E->Weather.SnowCover = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 1.f);
				Say(FString::Printf(TEXT("weather.snowcover = %.2f"), E->Weather.SnowCover));
			});
			Add(TEXT("weather.auto"), TEXT("Zufälliger Wetterwechsel an/aus"), [](const TArray<FString>& A, USlsEnvironment* E) {
				E->Weather.bAuto = A.Num() ? IsOn(A[0]) : !E->Weather.bAuto;
				Say(FString::Printf(TEXT("weather.auto = %s"), E->Weather.bAuto ? TEXT("an") : TEXT("aus")));
			});
			Add(TEXT("weather.timescale"), TEXT("Beschleunigt Nasswerden, Trocknen und Schneedecke (Faktor)"), [](const TArray<FString>& A, USlsEnvironment* E) {
				if (A.Num()) E->Weather.TimeScale = FMath::Clamp(FCString::Atof(*A[0]), 0.f, 100.f);
				Say(FString::Printf(TEXT("weather.timescale = %.1f"), E->Weather.TimeScale));
			});
			Add(TEXT("weather.grip"), TEXT("Haftung des Autos aus dem Wetter"), [](const TArray<FString>&, USlsEnvironment* E) {
				const FSlsSurfaceGrip G = E->Weather.Surface();
				Say(FString::Printf(TEXT("Haftung %.2f · Seite %.2f · Traktion %.2f · Bremse %.2f · Lenkung %.2f · Antrieb %.2f · Pfützen %.2f"), G.Grip, G.Side, G.Traction, G.Brake, G.Steer, G.Accel, E->Weather.Puddles()));
			});
		}
	};
	FCommands GCommands;
}
