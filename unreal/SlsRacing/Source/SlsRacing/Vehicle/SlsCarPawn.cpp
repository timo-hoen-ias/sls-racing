#include "SlsCarPawn.h"
#include "SlsCarTuning.h"
#include "SlsWheels.h"
#include "SlsRacing.h"
#include "World/SlsWorldSubsystem.h"
#include "Camera/CameraComponent.h"
#include "ChaosWheeledVehicleMovementComponent.h"
#include "Components/BoxComponent.h"
#include "Components/StaticMeshComponent.h"
#include "Engine/Engine.h"
#include "Engine/StaticMesh.h"
#include "Engine/StaticMeshActor.h"
#include "Engine/World.h"
#include "EnhancedInputComponent.h"
#include "EnhancedInputSubsystems.h"
#include "EnhancedPlayerInput.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/SpringArmComponent.h"
#include "InputAction.h"
#include "InputMappingContext.h"
#include "InputModifiers.h"
#include "Materials/MaterialInstanceDynamic.h"
#include "Misc/FileHelper.h"
#include "Misc/Paths.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"
#include "UObject/ConstructorHelpers.h"

namespace
{
	// Unreal: forward +X, right +Y, up +Z, centimetres. Web car body: +z forward, +x left, +y up, metres.
	FVector BodyToUE(double LeftM, double UpM, double FwdM) { return FVector(FwdM * 100.0, -LeftM * 100.0, UpM * 100.0); }
	const double Gravity = 9.81;
	double YawInertia() { using namespace SlsCar; return Mass * (FMath::Square(2 * HalfWidth) + FMath::Square(2 * HalfLength)) / 12; }
	double RollInertia() { using namespace SlsCar; return Mass * (FMath::Square(2 * HalfWidth) + FMath::Square(2 * HalfHeight)) / 12; }
	/** N·s → Unreal impulse (kg·cm/s); N·m·s → angular impulse (kg·cm²/s). */
	FVector Imp(const FVector& Ns) { return Ns * 100.0; }
	FVector AngImp(const FVector& Nms) { return Nms * 10000.0; }
}

FSlsFeel FSlsFeel::Real()
{
	FSlsFeel F;
	F.Torque = 1; F.Downforce = 1; F.Drag = 1; F.AirLevel = 0; F.Landing = 0; F.Brake = 0; F.Stick = 0; F.Straight = 0; F.Coast = 0;
	F.bBurst = false; F.bDrift = false; F.NitroRefill = 0.05f;
	F.CamLag = 0; F.CamSwing = 0; F.CamHeight = 2.1f; F.CamDist = 6.f; F.CamSpeedFov = 9.f; F.CamBoostFov = 6.f; F.CamMaxKmh = 220.f;
	return F;
}

ASlsCarPawn::ASlsCarPawn()
{
	using namespace SlsCar;
	PrimaryActorTick.bCanEverTick = true;

	// Chassis box exactly like the web collider: the physics body Chaos drives. Wheels ride on SlsRoad, the body does not.
	Box = CreateDefaultSubobject<UBoxComponent>(TEXT("Chassis"));
	Box->SetBoxExtent(FVector(HalfLength, HalfWidth, HalfHeight) * 100.0);
	Box->SetCollisionProfileName(TEXT("Vehicle"));
	Box->SetCollisionObjectType(ECC_Vehicle);
	Box->SetCollisionResponseToAllChannels(ECR_Block);
	Box->SetCollisionResponseToChannel(ECC_SlsRoad, ECR_Ignore);
	Box->SetSimulatePhysics(true);
	Box->SetMassOverrideInKg(NAME_None, Mass, true);
	Box->SetLinearDamping(0.005f);
	Box->SetAngularDamping(0.4f);
	Box->BodyInstance.bUseCCD = true;
	// Centre of mass relative to the box centre (the box sits ColliderY above the web body origin).
	Box->BodyInstance.COMNudge = BodyToUE(0, ComY - ColliderY, ComZ);
	SetRootComponent(Box);

	// Placeholder body and wheels from the engine's basic shapes until the car GLBs are imported (PLAN.md, phase 2).
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cube(TEXT("/Engine/BasicShapes/Cube.Cube"));
	static ConstructorHelpers::FObjectFinder<UStaticMesh> Cylinder(TEXT("/Engine/BasicShapes/Cylinder.Cylinder"));
	BodyMesh = CreateDefaultSubobject<UStaticMeshComponent>(TEXT("Body"));
	BodyMesh->SetupAttachment(Box);
	BodyMesh->SetCollisionEnabled(ECollisionEnabled::NoCollision);
	if (Cube.Succeeded()) BodyMesh->SetStaticMesh(Cube.Object);
	BodyMesh->SetRelativeScale3D(FVector(HalfLength * 2, HalfWidth * 2, HalfHeight * 2)); // the cube is 1 m
	const double Ys[4] = {WheelX, -WheelX, WheelX, -WheelX}, Zs[4] = {WheelFront, WheelFront, WheelRear, WheelRear};
	for (int32 I = 0; I < 4; I++)
	{
		UStaticMeshComponent* W = CreateDefaultSubobject<UStaticMeshComponent>(*FString::Printf(TEXT("Wheel%d"), I));
		W->SetupAttachment(Box);
		W->SetCollisionEnabled(ECollisionEnabled::NoCollision);
		if (Cylinder.Succeeded()) W->SetStaticMesh(Cylinder.Object);
		WheelMeshes.Add(W);
	}

	Vehicle = CreateDefaultSubobject<UChaosWheeledVehicleMovementComponent>(TEXT("Vehicle"));
	Vehicle->Mass = Mass;
	Vehicle->bEnableCenterOfMassOverride = false; // COMNudge on the body above
	Vehicle->ChassisWidth = HalfWidth * 200.0;
	Vehicle->ChassisHeight = HalfHeight * 200.0;
	Vehicle->bReverseAsBrake = true;
	Vehicle->WheelSetups.SetNum(4);
	for (int32 I = 0; I < 4; I++)
	{
		FChaosWheelSetup& S = Vehicle->WheelSetups[I];
		S.WheelClass = I < 2 ? USlsWheelFront::StaticClass() : USlsWheelRear::StaticClass();
		S.BoneName = NAME_None;
		// Wheel centre at rest: mount point WheelY above the body origin, rest length below it (box-centre relative).
		S.AdditionalOffset = BodyToUE(Ys[I], WheelY - WheelRest - ColliderY, Zs[I]);
	}
	// Wheel rays hit road surfaces (SlsRoad), which the car body ignores.
	Vehicle->WheelTraceCollisionResponses.SetResponse(ECC_SlsRoad, ECR_Block);

	Arm = CreateDefaultSubobject<USpringArmComponent>(TEXT("Arm"));
	Arm->SetupAttachment(Box);
	Arm->bInheritPitch = false;
	Arm->bInheritRoll = false;
	Arm->bDoCollisionTest = true;
	Arm->ProbeChannel = ECC_Camera;
	Camera = CreateDefaultSubobject<UCameraComponent>(TEXT("Camera"));
	Camera->SetupAttachment(Arm, USpringArmComponent::SocketName);
	Camera->SetFieldOfView(82.f); // the web game's 52° vertical on 16:9

	ApplyTuning();
}

void ASlsCarPawn::ApplyTuning()
{
	using namespace SlsCar;
	UChaosWheeledVehicleMovementComponent* V = Vehicle;
	// Aero like the web car: drag and downforce in N per (m/s)², as Chaos's ½·ρ·C·A with the chassis cross-section.
	const double Area = (HalfWidth * 2) * (HalfHeight * 2);
	V->DragCoefficient = Drag * Feel.Drag / (0.5 * 1.225 * Area);
	V->DownforceCoefficient = Downforce * Feel.Downforce / (0.5 * 1.225 * Area);

	FVehicleEngineConfig& E = V->EngineSetup;
	double Peak = 0;
	for (const auto& [R, T] : Torque()) Peak = FMath::Max(Peak, T);
	E.MaxTorque = Peak * Feel.Torque;
	E.MaxRPM = MaxRpm;
	E.EngineIdleRPM = IdleRpm;
	E.EngineBrakeEffect = 0.2f; // ~100 Nm at mid revs, like engineBrake in tuning.ts
	E.EngineRevUpMOI = 5.f;
	E.EngineRevDownRate = 600.f;
	FRichCurve* TC = E.TorqueCurve.GetRichCurve();
	TC->Reset();
	for (const auto& [R, T] : Torque()) TC->AddKey(R, T / Peak);

	FVehicleDifferentialConfig& D = V->DifferentialSetup;
	D.DifferentialType = EVehicleDifferential::AllWheelDrive;
	D.FrontRearSplit = 1.0 - FrontDrive; // Chaos: share to the rear

	FVehicleTransmissionConfig& Tr = V->TransmissionSetup;
	Tr.bUseAutomaticGears = true;
	Tr.bUseAutoReverse = true;
	Tr.FinalRatio = Final;
	Tr.ForwardGearRatios = Gears();
	Tr.ReverseGearRatios = {float(Reverse)};
	Tr.ChangeUpRPM = ShiftRpm;
	Tr.ChangeDownRPM = 3000;
	Tr.GearChangeTime = ShiftTime;
	Tr.TransmissionEfficiency = Efficiency;

	// Speed-sensitive lock (maxSteerAngle): Chaos scales the wheel's MaxSteerAngle by this curve over mph.
	FVehicleSteeringConfig& St = V->SteeringSetup;
	St.SteeringType = ESteeringType::AngleRatio;
	FRichCurve* SC = St.SteeringCurve.GetRichCurve();
	SC->Reset();
	for (double Mph = 0; Mph <= 220; Mph += 10) SC->AddKey(Mph, MaxSteer(Mph * 0.44704) / SteerLow);
}

void ASlsCarPawn::SetFeel(bool bInFun)
{
	bFun = bInFun;
	Feel = bFun ? FSlsFeel::Fun() : FSlsFeel::Real();
	ApplyTuning();
	Vehicle->SetMaxEngineTorque(Vehicle->EngineSetup.MaxTorque);
}

void ASlsCarPawn::BeginPlay()
{
	Super::BeginPlay();
	SetupInput();
	for (int32 I = 0; I < 4; I++)
	{
		const double D = SlsCar::WheelRadius * 2, W = SlsCar::WheelWidth;
		WheelMeshes[I]->SetRelativeScale3D(FVector(D, D, W)); // cylinder is 1 m, axis Z; turned onto Y below
	}
	// Hold the car until the ground under the spawn has its colliders.
	Box->SetSimulatePhysics(false);
}

double ASlsCarPawn::SpeedMs() const { return Vehicle->GetForwardSpeed() / 100.0; }
double ASlsCarPawn::Rpm() const { return Vehicle->GetEngineRotationSpeed(); }
int32 ASlsCarPawn::Gear() const { return Vehicle->GetCurrentGear(); }

// --- input --------------------------------------------------------------------------------------------------

void ASlsCarPawn::SetupInput()
{
	if (Mapping) return;
	auto Make = [this](const TCHAR* Name, EInputActionValueType Type) {
		UInputAction* A = NewObject<UInputAction>(this, Name);
		A->ValueType = Type;
		return A;
	};
	AThrottle = Make(TEXT("Throttle"), EInputActionValueType::Axis1D);
	ABrake = Make(TEXT("Brake"), EInputActionValueType::Axis1D);
	ASteer = Make(TEXT("Steer"), EInputActionValueType::Axis1D);
	AHandbrake = Make(TEXT("Handbrake"), EInputActionValueType::Boolean);
	ANitro = Make(TEXT("Nitro"), EInputActionValueType::Boolean);
	AReset = Make(TEXT("Reset"), EInputActionValueType::Boolean);
	ACamera = Make(TEXT("Camera"), EInputActionValueType::Boolean);
	ALookBack = Make(TEXT("LookBack"), EInputActionValueType::Boolean);
	AShiftUp = Make(TEXT("ShiftUp"), EInputActionValueType::Boolean);
	AShiftDown = Make(TEXT("ShiftDown"), EInputActionValueType::Boolean);
	// Same defaults as the web game (src/input/bindings.ts DEFAULT_BINDINGS), standard gamepad layout.
	Mapping = NewObject<UInputMappingContext>(this, TEXT("Driving"));
	auto Map = [this](UInputAction* A, const FKey& K, bool bNegate = false) {
		FEnhancedActionKeyMapping& M = Mapping->MapKey(A, K);
		if (bNegate) M.Modifiers.Add(NewObject<UInputModifierNegate>(this));
	};
	Map(AThrottle, EKeys::W); Map(AThrottle, EKeys::Up); Map(AThrottle, EKeys::Gamepad_RightTriggerAxis);
	Map(ABrake, EKeys::S); Map(ABrake, EKeys::Down); Map(ABrake, EKeys::Gamepad_LeftTriggerAxis);
	Map(ASteer, EKeys::D); Map(ASteer, EKeys::Right); Map(ASteer, EKeys::A, true); Map(ASteer, EKeys::Left, true); Map(ASteer, EKeys::Gamepad_LeftX);
	Map(ANitro, EKeys::LeftShift); Map(ANitro, EKeys::RightShift); Map(ANitro, EKeys::Gamepad_FaceButton_Bottom); Map(ANitro, EKeys::Gamepad_RightShoulder);
	Map(AHandbrake, EKeys::SpaceBar); Map(AHandbrake, EKeys::Gamepad_FaceButton_Right); Map(AHandbrake, EKeys::Gamepad_FaceButton_Left);
	Map(ALookBack, EKeys::B); Map(ALookBack, EKeys::Gamepad_LeftShoulder);
	Map(AShiftUp, EKeys::E); Map(AShiftDown, EKeys::Q);
	Map(AReset, EKeys::R); Map(AReset, EKeys::Gamepad_FaceButton_Top);
	Map(ACamera, EKeys::C); Map(ACamera, EKeys::Gamepad_Special_Left);
}

void ASlsCarPawn::PawnClientRestart()
{
	Super::PawnClientRestart();
	SetupInput();
	if (const APlayerController* PC = Cast<APlayerController>(GetController()))
		if (UEnhancedInputLocalPlayerSubsystem* S = ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()))
		{
			S->ClearAllMappings();
			S->AddMappingContext(Mapping, 0);
		}
}

void ASlsCarPawn::SetupPlayerInputComponent(UInputComponent* PlayerInputComponent)
{
	Super::SetupPlayerInputComponent(PlayerInputComponent);
	// Values are read every frame from the player input (ReadInput); nothing to bind.
}

float ASlsCarPawn::ActionValue(const UInputAction* A) const
{
	const APlayerController* PC = Cast<APlayerController>(GetController());
	const UEnhancedInputLocalPlayerSubsystem* S = PC ? ULocalPlayer::GetSubsystem<UEnhancedInputLocalPlayerSubsystem>(PC->GetLocalPlayer()) : nullptr;
	const UEnhancedPlayerInput* PI = S ? S->GetPlayerInput() : nullptr;
	return PI && A ? PI->GetActionValue(A).Get<float>() : 0.f;
}

FSlsDriveInput ASlsCarPawn::ReadInput()
{
	FSlsDriveInput In;
	// Parked while nobody drives it (fly camera): hold it on the handbrake.
	if (!GetController()) { In.bHandbrake = true; return In; }
	In.Throttle = FMath::Clamp(ActionValue(AThrottle), 0.f, 1.f);
	In.Brake = FMath::Clamp(ActionValue(ABrake), 0.f, 1.f);
	In.Steer = FMath::Clamp(ActionValue(ASteer), -1.f, 1.f);
	In.bNitro = ActionValue(ANitro) > 0.5f;
	In.bHandbrake = ActionValue(AHandbrake) > 0.5f;
	In.bLookBack = ActionValue(ALookBack) > 0.5f;
	const bool bReset = ActionValue(AReset) > 0.5f, bCam = ActionValue(ACamera) > 0.5f;
	const bool bUp = ActionValue(AShiftUp) > 0.5f, bDown = ActionValue(AShiftDown) > 0.5f;
	if (bReset && !bResetHeld) ResetToRoad();
	if (bCam && !bCamHeld) CamMode = (CamMode + 1) % 4;
	Vehicle->SetChangeUpInput(bUp && !bShiftUpHeld);
	Vehicle->SetChangeDownInput(bDown && !bShiftDownHeld);
	bResetHeld = bReset; bCamHeld = bCam; bShiftUpHeld = bUp; bShiftDownHeld = bDown;
	return In;
}

// --- placing ------------------------------------------------------------------------------------------------

void ASlsCarPawn::PlaceAt(const FVector& Local, double Heading)
{
	USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this);
	FVector P = USlsWorldSubsystem::LocalToUE(Local);
	if (S)
	{
		const FIntPoint T = S->TileOfLocal(Local.X, Local.Z);
		for (int32 DX = -1; DX <= 1; DX++)
			for (int32 DY = -1; DY <= 1; DY++) S->LoadTileSync(T + FIntPoint(DX, DY), true);
		P.Z = S->GroundZ(P.X, P.Y, P.Z);
	}
	// Body origin a little above the road: wheels hang at full droop and settle.
	P.Z += (SlsCar::WheelRadius + SlsCar::WheelRest - SlsCar::WheelY + SlsCar::ColliderY + 0.25) * 100.0;
	const FRotator R(0, FMath::RadiansToDegrees(Heading) - 90.0, 0);
	Box->SetSimulatePhysics(true);
	Box->SetWorldLocationAndRotation(P, R, false, nullptr, ETeleportType::ResetPhysics);
	Box->SetPhysicsLinearVelocity(FVector::ZeroVector);
	Box->SetPhysicsAngularVelocityInRadians(FVector::ZeroVector);
	DriftDir = 0;
	RearSide = 1;
	bPlaced = true;
}

void ASlsCarPawn::ResetToRoad()
{
	USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this);
	if (!S) return;
	const FVector L = USlsWorldSubsystem::UEToLocal(GetActorLocation());
	FSlsRoadGraph::FSpot Spot;
	if (S->Roads().Nearest(L.X, L.Z, 2, Spot)) PlaceAt(Spot.Pos, Spot.Heading);
	else PlaceAt(L, 0);
}

// --- every frame ----------------------------------------------------------------------------------------------

void ASlsCarPawn::Tick(float Dt)
{
	Super::Tick(Dt);
	USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this);
	if (!bPlaced)
	{
		if (S && S->IsReady())
		{
			const FSlsWorldInfo& I = S->Info();
			PlaceAt(I.SpawnLocal, I.SpawnHeading);
		}
		return;
	}
	FSlsDriveInput In = Bench.Phase ? FSlsDriveInput() : ReadInput();
	if (Bench.Phase) TickBench(Dt, In);
	Vehicle->SetThrottleInput(In.Throttle);
	// Wet or snowy roads: weaker brakes and vaguer steering (weather.ts surface()); friction is set in ArcadeLayer.
	Vehicle->SetBrakeInput(In.Brake * WeatherGrip.Brake);
	Vehicle->SetSteeringInput(In.Steer * WeatherGrip.Steer);
	Vehicle->SetHandbrakeInput(In.bHandbrake);
	ArcadeLayer(In, Dt);
	UpdateWheels();
	UpdateCamera(In, Dt);
}

void ASlsCarPawn::ArcadeLayer(const FSlsDriveInput& In, float Dt)
{
	using namespace SlsCar;
	if (Dt <= 0 || !Box->IsSimulatingPhysics()) return;
	const FVector Up = Box->GetUpVector(), Fwd = Box->GetForwardVector(), Right = Box->GetRightVector();
	const FVector V = Box->GetPhysicsLinearVelocity() / 100.0; // m/s
	const FVector W = Box->GetPhysicsAngularVelocityInRadians();
	const double Fv = FVector::DotProduct(V, Fwd), Sv = FVector::DotProduct(V, Right), AbsV = FMath::Abs(Fv);
	int32 Contacts = 0;
	for (int32 I = 0; I < 4; I++) Contacts += Vehicle->GetWheelState(I).bInContact ? 1 : 0;
	const bool bWasAir = bAirborne;
	bAirborne = Contacts == 0;
	AirTime = bAirborne ? AirTime + Dt : 0;
	if (!bAirborne) Climb = V.Z > 0.5 ? Climb + V.Z * Dt : V.Z < 0.2 ? 0 : Climb;
	if (bAirborne && !bWasAir) bLaunched = V.Z > 2.5 && Climb > 0.6;
	auto Add = [this](const FVector& Ns) { Box->AddImpulse(Imp(Ns)); };
	auto AddAng = [this](const FVector& Nms) { Box->AddAngularImpulseInRadians(AngImp(Nms)); };
	// Yaw rate about up, + = turning right (Unreal is left-handed).
	const double YawRate = FVector::DotProduct(W, Up);

	// Soft landing (feel.landing): most of the bounce and the roll/pitch tumble go.
	if (bWasAir && !bAirborne && Feel.Landing > 0)
	{
		FVector NV = V;
		if (NV.Z < 0) NV.Z *= 1 - 0.7 * Feel.Landing;
		Box->SetPhysicsLinearVelocity(NV * 100.0);
		const FVector Yaw = Up * YawRate;
		Box->SetPhysicsAngularVelocityInRadians(Yaw + (W - Yaw) * (1 - 0.8 * Feel.Landing));
	}

	// Nitro: holding boosts (more torque, a push), a short tap fires a burst.
	if (In.bNitro) NitroHeld += Dt;
	else
	{
		if (Feel.bBurst && NitroHeld > 0 && NitroHeld < 0.22f && Nitro > 0.07f && !bAirborne)
		{
			Nitro = FMath::Max(0.f, Nitro - 0.14f);
			Bursting = 0.35f;
			Box->AddImpulse(Fwd * 5.0 * 100.0, NAME_None, true); // +5 m/s
		}
		NitroHeld = 0;
	}
	Bursting = FMath::Max(0.f, Bursting - Dt);
	const bool bHeld = !Feel.bBurst || NitroHeld >= 0.22f;
	bBoosting = (In.bNitro && bHeld && Nitro > 0.02f && In.Throttle > 0.1f) || Bursting > 0;
	if (bBoosting && Bursting <= 0 && !bInfiniteNitro) Nitro = FMath::Max(0.f, Nitro - float(NitroDrain) * Dt);
	else if (!bBoosting) Nitro = FMath::Min(1.f, Nitro + (DriftDir ? float(NitroDriftRefill) : Feel.NitroRefill) * Dt);
	Vehicle->SetMaxEngineTorque(Vehicle->EngineSetup.MaxTorque * (bBoosting ? NitroTorque : 1.0));
	if (bBoosting && !bAirborne) Add(Fwd * NitroPush * Dt);

	// Tyre friction with the weather's grip; the rear also carries the drift release (RearSide).
	{
		const float Gk = WeatherGrip.Grip;
		Vehicle->SetWheelFrictionMultiplier(0, float(Mu * Gk));
		Vehicle->SetWheelFrictionMultiplier(1, float(Mu * Gk));
		Vehicle->SetWheelFrictionMultiplier(2, float(Mu * RearMu * RearSide * Gk));
		Vehicle->SetWheelFrictionMultiplier(3, float(Mu * RearMu * RearSide * Gk));
	}
	if (!bAirborne)
	{
		// Road hold (feel.stick): speed away from the road is taken out; with a wheel in the air the car is pressed down.
		if (Feel.Stick > 0)
		{
			const double Vn = FVector::DotProduct(V, Up);
			if (Vn > 0.25) Add(-Up * (Vn - 0.25) * (1 - FMath::Exp(-18.0 * Feel.Stick * Dt)) * Mass);
			if (Contacts < 4 && AbsV > 5 && V.Z < 2.5) Add(-Up * 0.6 * Gravity * Feel.Stick * Mass * FMath::Clamp((AbsV - 5) / 10, 0.0, 1.0) * Dt);
		}
		// Drift assist: a little extra yaw while steering, more with the handbrake.
		if (AbsV > 3 && Assists.Drift > 0)
		{
			const double Fade = In.bHandbrake ? 1 : FMath::Clamp(1.5 - AbsV / 40, 0.35, 1.0);
			const double Steer = In.Steer * MaxSteer(AbsV);
			AddAng(Up * Steer * FMath::Clamp(AbsV / 20, 0.0, 1.0) * Fade * (In.bHandbrake ? 1.1 : 0.45) * Assists.Drift * FMath::Sign(Fv) * Mass * 0.9 * Dt);
		}
		// Button drift (drift): a short handbrake pull at speed starts a drift that throttle and steering hold.
		if (Feel.bDrift)
		{
			if (In.bHandbrake && AbsV > 12 && FMath::Abs(In.Steer) > 0.2f && Fv > 0)
			{
				if (!DriftDir) { DriftTime = 0; DriftLow = 0; }
				DriftDir = FMath::Sign(In.Steer);
			}
			if (DriftDir)
			{
				DriftTime += Dt;
				DriftLow = FMath::Abs(LastSlip) < 0.1f ? DriftLow + Dt : 0;
				const bool bOff = !In.bHandbrake && (In.Throttle < 0.1f || In.Brake > 0.3f);
				if (bOff || AbsV < 7.2 || (DriftTime > 0.6f && DriftLow > 0.4f)) DriftDir = 0;
			}
		}
		else DriftDir = 0;
		const float RearTarget = DriftDir && !In.bHandbrake ? 0.6f : 1.f;
		RearSide += (RearTarget - RearSide) * FMath::Min(1.f, Dt * 6);
		Vehicle->SetWheelFrictionMultiplier(2, float(Mu * RearMu * RearSide * WeatherGrip.Grip));
		Vehicle->SetWheelFrictionMultiplier(3, float(Mu * RearMu * RearSide * WeatherGrip.Grip));
		if (Fv > 5)
		{
			// Slip angle, + = sliding to the right.
			const double Slip = FMath::Atan2(Sv, Fv);
			// Stability control: past ~40° the car is pulled back towards its direction of travel.
			const double Cap = 0.7 + (1 - Assists.Esp) * 1.2;
			if (Assists.Esp > 0 && FMath::Abs(Slip) > Cap) AddAng(Up * (Slip - FMath::Sign(Slip) * Cap) * YawInertia() * 4 * Assists.Esp * Dt);
			if (DriftDir && !In.bHandbrake)
			{
				const double Open = FMath::Clamp(0.4 + 0.4 * In.Throttle + 0.35 * In.Steer * DriftDir, 0.12, 1.0);
				const double Target = -DriftDir * 0.65 * Open; // drifting right: the tail slides left, slip < 0
				const double Rate = (Slip - LastSlip) / Dt;
				AddAng(Up * ((Target - Slip) * 3 - Rate * 0.35) * -YawInertia() * Dt);
			}
			LastSlip = Slip;
			// Drift assist: bleed some sideways speed into forward speed while drifting.
			if ((In.bHandbrake && AbsV > 8 || DriftDir) && Assists.Drift > 0)
			{
				const double Bleed = Sv * 0.9 * Assists.Drift * Dt;
				Add((-Right * Bleed + Fwd * FMath::Abs(Bleed) * 0.6) * Mass);
			}
		}
		// Stability control: no more yaw rate than the tyres can hold (a bit over), damped away fast.
		if (Assists.Esp > 0)
		{
			const double MaxYaw = In.bHandbrake || DriftDir ? 2.4 : FMath::Min(1.9, 1.3 * Mu * Gravity / FMath::Max(AbsV, 1.0));
			if (FMath::Abs(YawRate) > MaxYaw)
				AddAng(-Up * (YawRate - FMath::Sign(YawRate) * MaxYaw) * YawInertia() * (1 - FMath::Exp(-83.0 * Assists.Esp * Dt)));
			const double RollRate = FVector::DotProduct(W, Fwd);
			AddAng(-Fwd * RollRate * RollInertia() * (1 - FMath::Exp(-8.0 * Assists.Esp * Dt)));
		}
	}
	else
	{
		// Road hold in the air: just after a hop with the road close below, extra gravity (not after a ramp).
		if (Feel.Stick > 0 && AirTime <= 0.4f && !bLaunched)
		{
			FHitResult H;
			FCollisionQueryParams Q(SCENE_QUERY_STAT(SlsStick), false, this);
			const FVector C = Box->GetCenterOfMass();
			if (GetWorld()->LineTraceSingleByChannel(H, C, C - FVector(0, 0, 160), ECC_SlsWheel, Q)) Add(FVector(0, 0, -1.5 * Gravity * Feel.Stick * Mass * Dt));
		}
		// Air control: pitch with throttle and brake, yaw with steering.
		AddAng((Right * (In.Brake - In.Throttle) + Up * In.Steer) * AirControl * Dt);
		// Self-levelling (feel.airlevel): a damped spring turns the car's up axis back to the sky.
		if (Feel.AirLevel > 0)
		{
			const FVector Axis = FVector::CrossProduct(Up, FVector::UpVector);
			const double Free = 1 - 0.6 * FMath::Min(1.0, double(FMath::Abs(In.Brake - In.Throttle)));
			const FVector WPerp = W - Up * YawRate;
			AddAng((Axis * 14.0 - WPerp * 3.0) * RollInertia() * Feel.AirLevel * Free * Dt);
		}
	}

	// Arcade brakes (feel.brake) and the coasting brake (feel.coast): extra deceleration along the road.
	const float Pedal = In.Brake > 0 && Fv > 1 ? In.Brake : In.Throttle > 0 && Fv < -1 ? In.Throttle : 0.f;
	if (Pedal > 0.05f && Feel.Straight > 0 && Contacts >= 2 && FMath::Abs(In.Steer) < 0.1f && !In.bHandbrake && !DriftDir)
		AddAng(-Up * YawRate * YawInertia() * (1 - FMath::Exp(-10.0 * Feel.Straight * Pedal * Dt)));
	double DecelG = Pedal > 0 ? Feel.Brake * Pedal : 0;
	if (Feel.Coast > 0 && In.Throttle < 0.05f && In.Brake < 0.05f && !In.bHandbrake && !DriftDir)
	{
		const bool bAgainst = (Gear() > 0 && Fv < -1) || (Gear() < 0 && Fv > 1);
		DecelG = FMath::Max(DecelG, double(Feel.Coast) * (bAgainst ? 3 : 1));
	}
	if (DecelG > 0 && Contacts > 0)
	{
		const FVector P = V - Up * FVector::DotProduct(V, Up);
		const double Sp = P.Size();
		if (Sp > 0.5)
		{
			const double Decel = DecelG * Gravity * (Contacts / 4.0) * FMath::Clamp((Sp - 0.5) / 2.5, 0.0, 1.0);
			Add(-P / Sp * FMath::Min(Decel * Dt, Sp - 0.5) * Mass);
		}
	}
}

void ASlsCarPawn::UpdateWheels()
{
	for (int32 I = 0; I < 4 && I < Vehicle->Wheels.Num(); I++)
	{
		const UChaosVehicleWheel* W = Vehicle->Wheels[I];
		if (!W) continue;
		const FVector Rest = Vehicle->WheelSetups[I].AdditionalOffset;
		WheelMeshes[I]->SetRelativeLocation(Rest + FVector(0, 0, W->GetSuspensionOffset()));
		// Cylinder axis (Z) onto the axle (Y), steered, spinning.
		WheelMeshes[I]->SetRelativeRotation(FRotator(W->GetRotationAngle(), W->GetSteerAngle(), 90.f));
	}
}

void ASlsCarPawn::UpdateCamera(const FSlsDriveInput& In, float Dt)
{
	const double Kmh = FMath::Abs(SpeedMs()) * 3.6;
	// chase, far, hood, cockpit (web chaseCamera.ts modes).
	static const float Dist[4] = {1.f, 1.6f, 0.f, 0.f};
	const float D = Feel.CamDist * Dist[CamMode] * 100.f;
	Arm->TargetArmLength = D;
	Arm->SocketOffset = CamMode < 2 ? FVector(0, 0, Feel.CamHeight * 100.f * (CamMode == 1 ? 1.4f : 1.f)) : FVector::ZeroVector;
	Arm->SetRelativeLocation(CamMode == 2 ? FVector(40, 0, 55) : CamMode == 3 ? FVector(-30, -30, 45) : FVector::ZeroVector);
	Arm->bEnableCameraLag = CamMode < 2 && Feel.CamLag > 0;
	Arm->CameraLagSpeed = 12.f / FMath::Max(0.2f, Feel.CamLag);
	Arm->bEnableCameraRotationLag = CamMode < 2;
	Arm->CameraRotationLagSpeed = Feel.CamSwing > 0 ? 8.f / Feel.CamSwing : 20.f;
	Arm->bDoCollisionTest = CamMode < 2;
	Arm->SetRelativeRotation(FRotator(CamMode < 2 ? -8.f : 0.f, In.bLookBack ? 180.f : 0.f, 0));
	const float Fov = 82.f + Feel.CamSpeedFov * FMath::Clamp(float(Kmh) / Feel.CamMaxKmh, 0.f, 1.f) + (bBoosting ? Feel.CamBoostFov : 0.f);
	Camera->SetFieldOfView(FMath::FInterpTo(Camera->FieldOfView, CamMode == 3 ? 88.f : Fov, Dt, 4.f));
}

// --- car.bench ----------------------------------------------------------------------------------------------

void ASlsCarPawn::StartBench(bool bExitWhenDone)
{
	// A flat 6 km plane far below the world: the same ground as unreal/tools/car-reference.ts.
	if (!BenchPlane)
	{
		FActorSpawnParameters P;
		P.SpawnCollisionHandlingOverride = ESpawnActorCollisionHandlingMethod::AlwaysSpawn;
		AStaticMeshActor* A = GetWorld()->SpawnActor<AStaticMeshActor>(FVector(0, 0, -1000000.0), FRotator::ZeroRotator, P);
		A->SetMobility(EComponentMobility::Movable);
		A->GetStaticMeshComponent()->SetStaticMesh(LoadObject<UStaticMesh>(nullptr, TEXT("/Engine/BasicShapes/Cube.Cube")));
		A->SetActorScale3D(FVector(6000, 6000, 1)); // top face at -1000000 + 50 cm
		A->SetMobility(EComponentMobility::Static);
		BenchPlane = A;
	}
	if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this)) S->bPaused = true;
	Bench = FBenchState();
	Bench.Phase = 1;
	Bench.bExit = bExitWhenDone;
	BenchReset();
}

void ASlsCarPawn::BenchReset()
{
	const FVector P(-280000.0, 0, -1000000.0 + 50.0 + (SlsCar::WheelRadius + SlsCar::WheelRest - SlsCar::WheelY + SlsCar::ColliderY + 0.05) * 100.0);
	Box->SetSimulatePhysics(true);
	Box->SetWorldLocationAndRotation(P, FRotator::ZeroRotator, false, nullptr, ETeleportType::ResetPhysics);
	Box->SetPhysicsLinearVelocity(FVector::ZeroVector);
	Box->SetPhysicsAngularVelocityInRadians(FVector::ZeroVector);
	Nitro = 1;
	Bench.T = 0;
}

void ASlsCarPawn::TickBench(float Dt, FSlsDriveInput& In)
{
	FBenchState& B = Bench;
	B.T += Dt;
	const double V = SpeedMs();
	switch (B.Phase)
	{
	case 1: // settle, then full throttle for 60 s
		if (B.T > 1) { B.Phase = 2; B.T = 0; }
		break;
	case 2:
		In.Throttle = 1;
		if (!B.T100 && V >= 100 / 3.6) B.T100 = B.T;
		if (!B.T200 && V >= 200 / 3.6) B.T200 = B.T;
		if (B.T >= 60) { B.TopKmh = V * 3.6; B.Phase = 3; BenchReset(); }
		break;
	case 3: // settle, accelerate to 100, brake to a stop
		if (B.T < 1) break;
		In.Throttle = 1;
		if (V >= 100 / 3.6) { B.Start = GetActorLocation(); B.Phase = 4; B.T = 0; }
		break;
	case 4:
		In.Brake = 1;
		if (V <= 0.5 || B.T > 10) { B.BrakeM = FVector::Dist2D(GetActorLocation(), B.Start) / 100.0; B.BrakeS = B.T; B.Phase = 5; BenchReset(); }
		break;
	case 5: // settle, 80 km/h, then full lock at 80 km/h for 6 s, mean lateral acceleration over the last 4
		if (B.T < 1) break;
		In.Throttle = 1;
		if (V >= 80 / 3.6) { B.Phase = 6; B.T = 0; }
		break;
	case 6:
	{
		const double Err = 80 / 3.6 - V;
		In.Throttle = FMath::Clamp(Err * 0.5, 0.0, 1.0);
		In.Brake = FMath::Clamp(-Err * 0.5, 0.0, 1.0);
		In.Steer = 1;
		if (B.T > 2)
		{
			const FVector Vel = Box->GetPhysicsLinearVelocity() / 100.0;
			const double W = FVector::DotProduct(Box->GetPhysicsAngularVelocityInRadians(), Box->GetUpVector());
			B.Lat += FMath::Abs(W * Vel.Size2D()); // centripetal acceleration on a steady circle
			B.LatN++;
		}
		if (B.T >= 6) { B.Phase = 0; BenchReport(); }
		break;
	}
	default: break;
	}
}

void ASlsCarPawn::BenchReport()
{
	const double Lat = Bench.LatN ? Bench.Lat / Bench.LatN / 9.81 : 0;
	struct FRow { const TCHAR* Name; double Got; const TCHAR* Key; bool bLowerBetter; };
	const FRow Rows[] = {
		{TEXT("0–100 km/h (s)"), Bench.T100, TEXT("t0_100"), true}, {TEXT("0–200 km/h (s)"), Bench.T200, TEXT("t0_200"), true},
		{TEXT("Spitze (km/h)"), Bench.TopKmh, TEXT("topKmh"), false}, {TEXT("100–0 km/h (m)"), Bench.BrakeM, TEXT("brake100m"), true},
		{TEXT("100–0 km/h (s)"), Bench.BrakeS, TEXT("brake100s"), true}, {TEXT("Querbeschleunigung 80 km/h (g)"), Lat, TEXT("latG80"), false},
	};
	// Reference of the web car (unreal/tools/car-reference.ts → unreal/reference/car.json).
	TSharedPtr<FJsonObject> Ref;
	FString Text;
	if (FFileHelper::LoadFileToString(Text, *FPaths::Combine(FPaths::ProjectDir(), TEXT("../reference/car.json"))))
	{
		TSharedPtr<FJsonObject> J;
		if (FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) && J.IsValid()) Ref = J->GetObjectField(bFun ? TEXT("fun") : TEXT("real"));
	}
	int32 Off = 0;
	FString Json = TEXT("{");
	UE_LOG(LogSls, Display, TEXT("car.bench (%s):"), bFun ? TEXT("fun") : TEXT("real"));
	for (const FRow& R : Rows)
	{
		const double Want = Ref ? Ref->GetNumberField(R.Key) : 0;
		const double Dev = Want > 0 ? (R.Got - Want) / Want : 0;
		const bool bBad = Want > 0 && FMath::Abs(Dev) > 0.1;
		Off += bBad;
		const FString Line = FString::Printf(TEXT("  %-32s Unreal %7.2f   Web %7.2f   %+5.0f %%%s"), R.Name, R.Got, Want, Dev * 100, bBad ? TEXT("  ← über 10 %") : TEXT(""));
		UE_LOG(LogSls, Display, TEXT("%s"), *Line);
		if (GEngine) GEngine->AddOnScreenDebugMessage(-1, 30.f, bBad ? FColor::Orange : FColor::Green, Line);
		Json += FString::Printf(TEXT("%s\"%s\":%.3f"), Json.Len() > 1 ? TEXT(",") : TEXT(""), R.Key, R.Got);
	}
	Json += FString::Printf(TEXT(",\"feel\":\"%s\",\"off\":%d}"), bFun ? TEXT("fun") : TEXT("real"), Off);
	FFileHelper::SaveStringToFile(Json, *FPaths::Combine(FPaths::ProjectSavedDir(), TEXT("car-bench.json")));
	if (USlsWorldSubsystem* S = USlsWorldSubsystem::Get(this)) S->bPaused = false;
	if (Bench.bExit) FPlatformMisc::RequestExitWithStatus(false, Off ? 1 : 0);
	else ResetToRoad();
}
