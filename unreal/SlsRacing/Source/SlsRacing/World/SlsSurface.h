#pragma once

#include "CoreMinimal.h"
#include "Misc/Optional.h"

class UWorld;
class ASlsTileActor;
class USlsWorldSubsystem;

/**
 * Port of the web game's drivability scan (src/world/surfaceScan.ts, pipeline/surfacecheck.ts): every cell of the
 * drawn carriageways is probed with a wheel ray (hits everything) and a chassis ray (road surfaces excluded).
 * All distances in metres in the web game's local frame (x east, y up, z south); rays go through Unreal physics.
 */
namespace SlsSurface
{
	/** SURFACE_LIMITS, same values. */
	namespace Limits
	{
		constexpr double Hole = 2, Bump = 0.12, Dip = 0.25, Step = 0.12, Snag = 0.12, Gap = 0.25, Above = 0.6, Below = 2, Level = 1.5;
		constexpr int32 Slot = 3, EdgeOut = 2;
		constexpr double Edge = 0.12, EdgeWall = 1.5;
	}

	struct FCell
	{
		double Yd = 0;
		TOptional<double> Yw, Yc;
		FName Wheel, Chassis;
	};

	/** Wheel and chassis ray of one drawn level, exactly like probeCells (offset point, centre fallback). */
	FCell Probe(const UWorld* World, double CX, double CZ, double Yd, const TArray<const AActor*>& Ignore);

	enum class EKind : uint8 { Hole, Bump, Dip, Step, Snag, Seam, Gap, Edge };
	const TCHAR* KindName(EKind K);
	bool IsCritical(EKind K, double Size);

	struct FIssue { double X = 0, Y = 0, Z = 0; EKind Kind = EKind::Hole; double Size = 0; FName What; };

	/** Issues within Radius m of (X, Z): road.scan. Uses the drawn roads and colliders of the loaded tiles. */
	TArray<FIssue> Scan(const UWorld* World, const USlsWorldSubsystem* Sub, double X, double Z, double Radius, int32& OutCells);

	/** Worst issue per place (clusterIssues). */
	TArray<FIssue> Cluster(TArray<FIssue> Issues, double Radius = 6);

	struct FParity
	{
		int32 Tiles = 0, Cells = 0, Bad = 0, Missing = 0;
		double Worst = 0;
		TArray<FString> Examples;
		/** Local x, y, z of the mismatching cells (for drawing). */
		TArray<FVector> Points;
	};

	/**
	 * Compares one tile's reference cells (web game wheel and chassis heights from the export) with Unreal's rays.
	 * The tile and its eight neighbours must have their colliders.
	 */
	void Parity(const UWorld* World, const ASlsTileActor* Tile, double Tol, const TArray<const AActor*>& Ignore, FParity& Out);
}
