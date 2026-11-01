#pragma once

#include "CoreMinimal.h"

/**
 * The web car's tuning (src/vehicle/tuning.ts, VEHICLE.scale 0.8 applied like in the game) in the units the Chaos
 * vehicle wants. One place to compare both games; car.bench measures the result against unreal/reference/car.json.
 * Chaos does suspension, tyres, engine, gearbox and differential; the arcade layer on top (ASlsCarPawn) adds what
 * the web game's feel adds: nitro, arcade brakes, coasting brake, road hold, drift and stability help, air control.
 */
namespace SlsCar
{
	constexpr double Scale = 0.8;
	constexpr double Mass = 1430;                        // kg
	// Chassis box (half extents, m): x left/right, y up, z forward in the web frame.
	constexpr double HalfWidth = 0.94 * Scale, HalfHeight = 0.38 * Scale, HalfLength = 2.25 * Scale;
	constexpr double ColliderY = 0.28 * Scale;          // box centre above the body origin
	constexpr double RideHeight = 0.284;                // body origin above the model's ground at real size (carView.ts)
	constexpr double ComY = -0.25 * Scale, ComZ = 0.05 * Scale;
	// Wheels (m): half track, axle positions, mount height, radius, rest length, travel, width.
	constexpr double WheelX = 0.8 * Scale, WheelFront = 1.27 * Scale, WheelRear = -1.2 * Scale, WheelY = 0.3 * Scale;
	constexpr double WheelRadius = 0.35 * Scale, WheelRest = 0.28 * Scale, WheelTravel = 0.18 * Scale, WheelWidth = 0.3 * Scale;
	// Engine: torque curve (rpm, Nm), idle, limiter, gears. The web gearing uses the real 0.35 m wheel; the final
	// drive is scaled with the wheel so road speed per rpm and force at the road stay the same.
	constexpr double IdleRpm = 950, ShiftRpm = 8800, MaxRpm = 9000;
	inline const TArray<TPair<double, double>>& Torque()
	{
		static const TArray<TPair<double, double>> T = {{900, 290}, {2500, 380}, {4500, 430}, {6250, 470}, {7500, 460}, {8500, 420}, {9000, 390}};
		return T;
	}
	/** Engine torque (Nm) at an rpm, linear between the curve points like torqueAt() in drivetrain.ts. */
	inline double TorqueAt(double Rpm)
	{
		const auto& T = Torque();
		if (Rpm <= T[0].Key) return T[0].Value;
		for (int32 I = 1; I < T.Num(); I++)
			if (Rpm <= T[I].Key) return FMath::Lerp(T[I - 1].Value, T[I].Value, (Rpm - T[I - 1].Key) / (T[I].Key - T[I - 1].Key));
		return T.Last().Value;
	}
	// Launch: the web drivetrain lets the engine run up to the stall speed against a standing car (converter /
	// launch control, stallRpm); Chaos ties the engine to the wheels and only eases it towards that speed.
	constexpr double StallRpm = 3800;
	// Engine braking off throttle (web: base + perRpm × rpm at the crank, × gearing): ~70 Nm at 3 000/min.
	constexpr double EngineBrakeBase = 30, EngineBrakePerRpm = 0.0135;
	inline const TArray<float>& Gears() { static const TArray<float> G = {3.75f, 2.38f, 1.72f, 1.34f, 1.11f, 0.96f, 0.84f}; return G; }
	constexpr double Reverse = 3.4, Final = 3.6 * Scale, Efficiency = 0.9, ShiftTime = 0.07;
	constexpr double FrontDrive = 0.3;                  // share of drive to the front axle
	// Springs: 50 N/m per kg of car on every wheel (Rapier scales by the chassis mass), damping ratio between bump and rebound.
	constexpr double SpringPerKg = 50, DampingRatio = 0.55;
	constexpr double ArbFront = 30000, ArbRear = 17000; // N/m
	// Tyres.
	constexpr double Mu = 1.55, RearMu = 1.12, PeakSlip = 0.11;
	// Brakes: N at the contact patches, front share, handbrake on the rear axle.
	constexpr double BrakeForce = 17500, BrakeBias = 0.64, Handbrake = 9000;
	// Steering lock (rad) at standstill and at speed, fade speed (m/s): maxSteerAngle in carPhysics.ts.
	constexpr double SteerLow = 0.6, SteerHigh = 0.045 * Scale, SteerFade = 14;
	inline double MaxSteer(double Speed) { return SteerHigh + (SteerLow - SteerHigh) / (1 + FMath::Square(FMath::Abs(Speed) / SteerFade)); }
	// Aero: N per (m/s)² of drag and downforce.
	constexpr double Drag = 0.48, Downforce = 0.9, Rolling = 0.013;
	// Nitro.
	constexpr double NitroTorque = 1.4, NitroPush = 2200, NitroDrain = 0.28, NitroRefill = 0.05, NitroDriftRefill = 0.12;
	constexpr double AirControl = 2200;
}
