#include "SlsWheels.h"
#include "SlsCarTuning.h"

namespace
{
	void Common(UChaosVehicleWheel* W)
	{
		using namespace SlsCar;
		W->WheelRadius = WheelRadius * 100.f;
		W->WheelWidth = WheelWidth * 100.f;
		W->SweepShape = ESweepShape::Raycast;
		W->bAffectedByEngine = true;
		W->bAffectedByBrake = true;
		// Suspension: rest length ± travel like the Rapier raycast vehicle; spring per wheel = 50 N/m per kg of car.
		W->SuspensionMaxRaise = WheelTravel * 100.f;
		W->SuspensionMaxDrop = WheelTravel * 100.f;
		// Force-based suspension (p.Vehicle.DisableConstraintSuspension=1, DefaultEngine.ini): Chaos builds its
		// suspension constraints only for skeletal meshes, so on our box nothing held the body up. The force path takes
		// MToCm(SpringRate) per cm of travel (SuspensionSystem.cpp), i.e. SpringRate is N/cm.
		W->SpringRate = SpringPerKg * Mass / 100.f;
		W->SpringPreload = 0.f;
		W->SuspensionDampingRatio = DampingRatio;
		W->WheelLoadRatio = 0.5f;
		W->SuspensionSmoothing = 0;
		W->SlipThreshold = 20.f;
		W->SkidThreshold = 20.f;
		W->CorneringStiffness = 1000.f;
		W->SideSlipModifier = 1.f;
		W->bABSEnabled = true;
		W->bTractionControlEnabled = true;
	}
}

USlsWheelFront::USlsWheelFront()
{
	using namespace SlsCar;
	Common(this);
	AxleType = EAxleType::Front;
	bAffectedBySteering = true;
	bAffectedByHandbrake = false;
	MaxSteerAngle = FMath::RadiansToDegrees(SteerLow);
	FrictionForceMultiplier = Mu;
	// Brake force at the patch → torque at the wheel, half the axle's share per wheel.
	MaxBrakeTorque = BrakeForce * BrakeBias / 2 * WheelRadius;
	MaxHandBrakeTorque = 0;
}

USlsWheelRear::USlsWheelRear()
{
	using namespace SlsCar;
	Common(this);
	AxleType = EAxleType::Rear;
	bAffectedBySteering = false;
	bAffectedByHandbrake = true;
	MaxSteerAngle = 0;
	FrictionForceMultiplier = Mu * RearMu;
	MaxBrakeTorque = BrakeForce * (1 - BrakeBias) / 2 * WheelRadius;
	MaxHandBrakeTorque = Handbrake / 2 * WheelRadius;
}
