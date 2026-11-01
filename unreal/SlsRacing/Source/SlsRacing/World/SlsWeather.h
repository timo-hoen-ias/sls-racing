#pragma once

#include "CoreMinimal.h"

/**
 * Weather state, a 1:1 port of src/weather/weather.ts (no engine types): rain and snow with an intensity, the road
 * wetness and snow cover that build up and dry or melt, cloud cover leading the precipitation, random changes, and
 * the grip that follows. The numbers are the web game's WEATHER table.
 */
struct FSlsSurfaceGrip
{
	float Grip = 1, Side = 1, Traction = 1, Brake = 1, Steer = 1, Accel = 1;
};

enum class ESlsWeatherKind : uint8 { Clear, Rain, Snow };

struct FSlsWeather
{
	ESlsWeatherKind Kind = ESlsWeatherKind::Clear;
	float Intensity = 0.8f;
	float Rain = 0, Snow = 0, Wet = 0, SnowCover = 0, Overcast = 0;
	bool bAuto = true;
	float NextChange = 0;
	float TimeScale = 1;

	explicit FSlsWeather(uint32 Seed = 0)
	{
		S = (Seed ? Seed : uint32(FPlatformTime::Cycles())) % 2147483647u;
		if (!S) S = 1;
		NextChange = RandomDelay();
	}

	static const TCHAR* Name(ESlsWeatherKind K) { return K == ESlsWeatherKind::Rain ? TEXT("rain") : K == ESlsWeatherKind::Snow ? TEXT("snow") : TEXT("clear"); }

	void Set(ESlsWeatherKind InKind, float InIntensity, bool bInstant)
	{
		Kind = InKind;
		Intensity = FMath::Clamp(InIntensity, 0.f, 1.f);
		if (!bInstant) return;
		const float A = Kind == ESlsWeatherKind::Clear ? 0 : Intensity;
		Rain = Kind == ESlsWeatherKind::Rain ? A : 0;
		Snow = Kind == ESlsWeatherKind::Snow ? A : 0;
		Wet = Kind == ESlsWeatherKind::Rain ? FMath::Max(0.35f, A) : Kind == ESlsWeatherKind::Snow ? 0.3f * A : 0;
		SnowCover = Kind == ESlsWeatherKind::Snow ? FMath::Max(0.35f, A) : 0;
		Overcast = Kind == ESlsWeatherKind::Clear ? 0 : FMath::Min(1.f, A * 1.4f);
	}

	void Update(float Dt)
	{
		Dt = FMath::Max(0.f, Dt);
		if (bAuto)
		{
			NextChange -= Dt;
			if (NextChange <= 0)
			{
				NextChange = RandomDelay();
				// Saarlouis: mostly dry, rain more often than snow.
				const float R = Rnd();
				const ESlsWeatherKind K = Kind != ESlsWeatherKind::Clear ? (R < 0.75f ? ESlsWeatherKind::Clear : R < 0.9f ? ESlsWeatherKind::Rain : ESlsWeatherKind::Snow)
					: (R < 0.65f ? ESlsWeatherKind::Rain : ESlsWeatherKind::Snow);
				Set(K, 0.35f + 0.65f * Rnd(), false);
			}
		}
		const float A = Kind == ESlsWeatherKind::Clear ? 0 : Intensity;
		Rain = Toward(Rain, Kind == ESlsWeatherKind::Rain ? A : 0, 1 / RampIn, 1 / RampOut, Dt);
		Snow = Toward(Snow, Kind == ESlsWeatherKind::Snow ? A : 0, 1 / RampIn, 1 / RampOut, Dt);
		Overcast += (FMath::Min(1.f, A * 1.4f) - Overcast) * (1 - FMath::Exp(-Dt / OvercastTau));
		const float Ts = Dt * TimeScale;
		const float Melt = SnowCover > 0 && Snow < 0.05f ? (Rain > 0.05f ? 1 / MeltRain : 1 / MeltDry) : 0;
		const float Melted = FMath::Min(SnowCover, Melt * Ts);
		SnowCover = FMath::Clamp(SnowCover - Melted + (Snow / SnowIn) * Ts, 0.f, 1.f);
		const float WetTarget = FMath::Max3(Rain, Snow * 0.3f, SnowCover > 0 && Melt > 0 ? 0.6f : 0.f);
		if (Wet < WetTarget) Wet = FMath::Min(WetTarget, Wet + (FMath::Max(Rain, 0.3f) / WetIn) * Ts + Melted * 2);
		else Wet = FMath::Max(WetTarget, Wet - Ts / DryOut);
	}

	FSlsSurfaceGrip Surface() const
	{
		auto L = [this](float RainV, float SnowV) { return FMath::Lerp(FMath::Lerp(1.f, RainV, Wet), SnowV, SnowCover); };
		FSlsSurfaceGrip G;
		G.Grip = L(0.7f, 0.4f); G.Side = L(0.82f, 0.58f); G.Traction = L(0.72f, 0.42f);
		G.Brake = L(0.66f, 0.42f); G.Steer = L(0.92f, 0.72f); G.Accel = L(0.97f, 0.85f);
		return G;
	}

	/** Puddles show (and act) from this wetness on, 0..1. */
	float Puddles() const { return SnowCover > 0.5f ? 0 : FMath::Clamp((Wet - PuddleDepth * 0.6f) / 0.4f, 0.f, 1.f); }

	static constexpr float RampIn = 8, RampOut = 10, WetIn = 25, DryOut = 120, SnowIn = 70, MeltDry = 400, MeltRain = 45;
	static constexpr float OvercastTau = 4, AutoMin = 120, AutoMax = 300, PuddleDepth = 0.55f;

private:
	uint32 S = 1;
	float Rnd() { S = uint32((uint64(S) * 16807u) % 2147483647u); return float(S) / 2147483647.f; }
	float RandomDelay() { return AutoMin + (AutoMax - AutoMin) * Rnd(); }
	static float Toward(float V, float Target, float Up, float Down, float Dt)
	{
		return V < Target ? FMath::Min(Target, V + Up * Dt) : FMath::Max(Target, V - Down * Dt);
	}
};
