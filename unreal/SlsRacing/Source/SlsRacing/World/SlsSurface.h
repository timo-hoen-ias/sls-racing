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

	/** Thresholds of the scan (m), the web game's SURFACE_LIMITS by default; road.check can tighten them. */
	struct FThresholds { double Bump = Limits::Bump, Dip = Limits::Dip, Step = Limits::Step, Snag = Limits::Snag, Gap = Limits::Gap, Edge = Limits::Edge; };

	/** Issues within Radius m of (X, Z): road.scan. Uses the drawn roads and colliders of the loaded tiles. */
	TArray<FIssue> Scan(const UWorld* World, const USlsWorldSubsystem* Sub, double X, double Z, double Radius, int32& OutCells);
	/**
	 * Issues of the cells inside a rectangle (local metres, x0..x1 × z0..z1), unclustered when bCluster is false:
	 * road.check walks the world tile by tile with this, so every cell is checked exactly once.
	 */
	TArray<FIssue> ScanRect(const UWorld* World, const USlsWorldSubsystem* Sub, const FBox2D& Rect, const FThresholds& Th, bool bCluster, int32& OutCells);

	/** Worst issue per place (clusterIssues). */
	TArray<FIssue> Cluster(TArray<FIssue> Issues, double Radius = 6);

	struct FParity
	{
		int32 Tiles = 0, Cells = 0, Bad = 0, Missing = 0;
		/**
		 * Input: probe shift (m) for the tie test. A mismatching cell whose web value Unreal reproduces with the probe
		 * moved this far along x or z lies on a collider edge (the two engines break the tie differently): it counts
		 * in Ties, not in Bad. 0 = every mismatch is a deviation.
		 */
		double TieShift = 0.003;
		/** Mismatches that are edge ties (see TieShift); listed in the report, never counted against max=. */
		int32 Ties = 0;
		double Worst = 0;
		TArray<FString> Examples;
		/** Local x, y, z of the mismatching cells (for drawing). */
		TArray<FVector> Points;
		/** Every mismatching cell for the report (road-parity.json "cells"). */
		struct FCellReport
		{
			bool bChassis = false;
			FIntPoint Tile;
			double X = 0, Z = 0, Yd = 0;
			TOptional<double> Unreal, Web;
			FName Hit;
			/** Deviation in m, max when only one side hit something. */
			double Dev = 0;
			/** Every collider along the probe ray, top down ("kind@height owner/component"), to see which surface wins and why. */
			FString Hits;
			/** Edge tie: Unreal hits the web value with the probe shifted by TieShift. */
			bool bTie = false;
		};
		TArray<FCellReport> Report;
	};

	/**
	 * Compares one tile's reference cells (web game wheel and chassis heights from the export) with Unreal's rays.
	 * The tile and its eight neighbours must have their colliders.
	 */
	void Parity(const UWorld* World, const ASlsTileActor* Tile, double Tol, const TArray<const AActor*>& Ignore, FParity& Out);
}
