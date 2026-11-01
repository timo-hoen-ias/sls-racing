#pragma once

#include "CoreMinimal.h"
#include "GameFramework/Pawn.h"
#include "World/SlsWeather.h"
#include "SlsCarPawn.generated.h"

class UBoxComponent;
class UStaticMeshComponent;
class USpringArmComponent;
class UCameraComponent;
class UChaosWheeledVehicleMovementComponent;
class UInputAction;
class UInputMappingContext;

/** Driving input of one frame (same fields as the web game's DriveInput). */
struct FSlsDriveInput
{
	float Throttle = 0, Brake = 0, Steer = 0;
	bool bNitro = false, bHandbrake = false, bLookBack = false;
};

/**
 * Game feel on top of the Chaos vehicle (src/game/feel.ts FEEL.fun / FEEL.real, same names as the feel.* commands).
 */
struct FSlsFeel
{
	float Torque = 1.2f, Downforce = 1.7f, Drag = 0.85f, AirLevel = 0.7f, Landing = 0.8f, Brake = 1.1f, Stick = 1.f, Straight = 1.f, Coast = 0.22f;
	bool bBurst = true, bDrift = true;
	float NitroRefill = 0.03f;
	// Camera (cam.*): lag, swing into corners, height and distance behind the car (m), FOV widening.
	float CamLag = 1.f, CamSwing = 1.f, CamHeight = 1.8f, CamDist = 5.8f, CamSpeedFov = 12.f, CamBoostFov = 9.f, CamMaxKmh = 280.f;
	static FSlsFeel Fun() { return FSlsFeel(); }
	static FSlsFeel Real();
};

/** Driving aids, 0 (off) .. 1 (full) like the web game's assists (assist.*). */
struct FSlsAssists { float Esp = 1.f, Drift = 1.f, Tcs = 1.f; bool bAbs = true; };

/**
 * The player car. Chaos Vehicles does suspension, tyres, engine, automatic gearbox and differential (tuned to the web
 * car in SlsCarTuning.h); this pawn adds the web game's arcade layer (nitro and burst, arcade and coasting brakes,
 * road hold, stability and drift help, air control and self-levelling), the chase camera on a spring arm, Enhanced
 * Input (keyboard and gamepad like src/input/bindings.ts), reset onto the nearest street and the car.bench parity run.
 */
UCLASS()
class SLSRACING_API ASlsCarPawn : public APawn
{
	GENERATED_BODY()

public:
	ASlsCarPawn();

	virtual void BeginPlay() override;
	virtual void Tick(float DeltaSeconds) override;
	virtual void SetupPlayerInputComponent(UInputComponent* PlayerInputComponent) override;
	virtual void PawnClientRestart() override;

	/** Puts the car upright on the nearest street (rank ≥ 2), right lane, heading along it. */
	void ResetToRoad();
	/** Puts the car at a spot (web local metres) facing Heading (0 = north, clockwise). */
	void PlaceAt(const FVector& Local, double Heading);
	/** Applies the tuning (after a change from the console). */
	void ApplyTuning();
	void SetFeel(bool bFun);
	bool IsFunFeel() const { return bFun; }

	/** Speed along the car (m/s), engine rpm, gear (-1 reverse), nitro tank 0..1. */
	double SpeedMs() const;
	double Rpm() const;
	int32 Gear() const;
	float Nitro = 1.f;
	bool bBoosting = false;
	int32 DriftDir = 0;
	bool bAirborne = false;

	FSlsFeel Feel;
	FSlsAssists Assists;
	bool bInfiniteNitro = false;
	/** Road grip from the weather (USlsEnvironment, weather.ts surface()): friction, brakes, steering. */
	FSlsSurfaceGrip WeatherGrip;
	/** Camera mode: 0 chase, 1 far, 2 hood, 3 cockpit (cam.mode, C). */
	int32 CamMode = 0;

	/** car.bench: drives the reference runs of unreal/tools/car-reference.ts on a flat plane and compares. */
	void StartBench(bool bExitWhenDone);
	bool IsBenching() const { return Bench.Phase != 0; }

	UPROPERTY(VisibleAnywhere) TObjectPtr<UBoxComponent> Box;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UStaticMeshComponent> BodyMesh;
	UPROPERTY(VisibleAnywhere) TArray<TObjectPtr<UStaticMeshComponent>> WheelMeshes;
	UPROPERTY(VisibleAnywhere) TObjectPtr<USpringArmComponent> Arm;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UCameraComponent> Camera;
	UPROPERTY(VisibleAnywhere) TObjectPtr<UChaosWheeledVehicleMovementComponent> Vehicle;

private:
	void SetupInput();
	FSlsDriveInput ReadInput();
	float ActionValue(const UInputAction* A) const;
	void ArcadeLayer(const FSlsDriveInput& In, float Dt);
	void UpdateCamera(const FSlsDriveInput& In, float Dt);
	void UpdateWheels();
	void TickBench(float Dt, FSlsDriveInput& In);

	bool bFun = true;
	bool bPlaced = false;
	float NitroHeld = 0, Bursting = 0, AirTime = 0, Climb = 0;
	bool bLaunched = false;
	float DriftTime = 0, DriftLow = 0, RearSide = 1, LastSlip = 0;
	bool bResetHeld = false, bCamHeld = false, bShiftUpHeld = false, bShiftDownHeld = false;

	UPROPERTY() TObjectPtr<UInputMappingContext> Mapping;
	UPROPERTY() TObjectPtr<UInputAction> AThrottle;
	UPROPERTY() TObjectPtr<UInputAction> ABrake;
	UPROPERTY() TObjectPtr<UInputAction> ASteer;
	UPROPERTY() TObjectPtr<UInputAction> AHandbrake;
	UPROPERTY() TObjectPtr<UInputAction> ANitro;
	UPROPERTY() TObjectPtr<UInputAction> AReset;
	UPROPERTY() TObjectPtr<UInputAction> ACamera;
	UPROPERTY() TObjectPtr<UInputAction> ALookBack;
	UPROPERTY() TObjectPtr<UInputAction> AShiftUp;
	UPROPERTY() TObjectPtr<UInputAction> AShiftDown;

	struct FBenchState
	{
		int32 Phase = 0;
		bool bExit = false;
		double T = 0, T100 = 0, T200 = 0, TopKmh = 0, BrakeM = 0, BrakeS = 0, Lat = 0;
		int32 LatN = 0;
		FVector Start = FVector::ZeroVector;
	} Bench;
	UPROPERTY() TObjectPtr<AActor> BenchPlane;
	void BenchReset();
	void BenchReport();
};
