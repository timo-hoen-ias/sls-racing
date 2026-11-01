#include "SlsSurface.h"
#include "SlsTileActor.h"
#include "SlsWorldSubsystem.h"
#include "SlsRacing.h"
#include "Components/PrimitiveComponent.h"
#include "Engine/World.h"
#include "GameFramework/PlayerController.h"
#include "GameFramework/Pawn.h"

namespace SlsSurface
{
	static constexpr int16 RefNone = -32768;

	static FName WhatOf(const FHitResult& H)
	{
		const UPrimitiveComponent* C = H.GetComponent();
		return C && C->ComponentTags.Num() ? C->ComponentTags[0] : FName(TEXT("?"));
	}

	/** All static and road colliders under the ray (object query, so nothing blocks), top down, for the parity report. */
	static FString AllHits(const UWorld* World, double X, double Z, double Top, const FCollisionQueryParams& Q)
	{
		TArray<FHitResult> Hits;
		const FVector A(X * 100.0, Z * 100.0, Top * 100.0);
		const FVector B = A - FVector(0, 0, (Limits::Above + Limits::Below) * 100.0);
		FCollisionObjectQueryParams O;
		O.AddObjectTypesToQuery(ECC_WorldStatic);
		O.AddObjectTypesToQuery(ECC_SlsRoad);
		World->LineTraceMultiByObjectType(Hits, A, B, O, Q);
		FString Out;
		for (const FHitResult& H : Hits)
		{
			const UPrimitiveComponent* C = H.GetComponent();
			Out += FString::Printf(TEXT("%s%s@%.3f %s/%s"), Out.IsEmpty() ? TEXT("") : TEXT("; "), *WhatOf(H).ToString(),
				H.bStartPenetrating ? Top : H.ImpactPoint.Z / 100.0, C && C->GetOwner() ? *C->GetOwner()->GetName() : TEXT("?"), C ? *C->GetName() : TEXT("?"));
		}
		return Out;
	}

	static bool Ray(const UWorld* World, double X, double Z, double Top, ECollisionChannel Channel, const FCollisionQueryParams& Q, double& OutY, FName& OutWhat)
	{
		FHitResult H;
		const FVector A(X * 100.0, Z * 100.0, Top * 100.0);
		const FVector B = A - FVector(0, 0, (Limits::Above + Limits::Below) * 100.0);
		if (!World->LineTraceSingleByChannel(H, A, B, Channel, Q)) return false;
		// Started inside a solid (a hull): Rapier's solid ray reports the origin.
		OutY = H.bStartPenetrating ? Top : H.ImpactPoint.Z / 100.0;
		OutWhat = WhatOf(H);
		return true;
	}

	FCell Probe(const UWorld* World, double CX, double CZ, double Yd, const TArray<const AActor*>& Ignore)
	{
		FCollisionQueryParams Q(SCENE_QUERY_STAT(SlsSurface), false);
		for (const AActor* A : Ignore) Q.AddIgnoredActor(A);
		FCell Out;
		Out.Yd = Yd;
		const double Top = Yd + Limits::Above;
		// Slightly off the cell centre: a ray exactly on a shared mesh edge can slip between two meshes.
		const double X = CX + 0.013, Z = CZ + 0.007;
		double Y; FName W;
		if (Ray(World, X, Z, Top, ECC_SlsWheel, Q, Y, W)) { Out.Yw = Y; Out.Wheel = W; }
		// The offset point can fall just outside a road whose edge crosses the cell near its centre.
		if (!Out.Yw.IsSet() || Out.Yw.GetValue() < Yd - Limits::Dip)
		{
			double Y2; FName W2;
			if (Ray(World, CX, CZ, Top, ECC_SlsWheel, Q, Y2, W2) && (!Out.Yw.IsSet() || Y2 > Out.Yw.GetValue())) { Out.Yw = Y2; Out.Wheel = W2; }
		}
		if (!Out.Yw.IsSet()) Out.Wheel = TEXT("nothing");
		if (Ray(World, X, Z, Top, ECC_SlsChassis, Q, Y, W)) { Out.Yc = Y; Out.Chassis = W; }
		else Out.Chassis = TEXT("nothing");
		return Out;
	}

	const TCHAR* KindName(EKind K)
	{
		static const TCHAR* Names[] = {TEXT("hole"), TEXT("bump"), TEXT("dip"), TEXT("step"), TEXT("snag"), TEXT("seam"), TEXT("gap"), TEXT("edge")};
		return Names[uint8(K)];
	}

	bool IsCritical(EKind K, double Size)
	{
		return K == EKind::Hole || K == EKind::Snag || K == EKind::Gap || Size >= (K == EKind::Seam ? 0.05 : K == EKind::Edge ? 0.3 : 0.25);
	}

	static double LimitOf(EKind K)
	{
		switch (K)
		{
		case EKind::Hole: return Limits::Hole; case EKind::Bump: return Limits::Bump; case EKind::Dip: return Limits::Dip;
		case EKind::Step: return Limits::Step; case EKind::Snag: return Limits::Snag; case EKind::Seam: return 0.02;
		case EKind::Gap: return Limits::Gap; default: return Limits::Edge;
		}
	}

	TArray<FIssue> Cluster(TArray<FIssue> Issues, double Radius)
	{
		auto Rank = [](const FIssue& S) { return (S.Kind == EKind::Hole || S.Kind == EKind::Gap ? 1e3 : 0) + S.Size / LimitOf(S.Kind); };
		Issues.Sort([&](const FIssue& A, const FIssue& B) { return Rank(A) > Rank(B); });
		TArray<FIssue> Kept;
		TMap<FIntPoint, TArray<int32>> Grid;
		for (const FIssue& S : Issues)
		{
			const FIntPoint C(FMath::FloorToInt(S.X / Radius), FMath::FloorToInt(S.Z / Radius));
			bool bDup = false;
			for (int32 DX = -1; DX <= 1 && !bDup; DX++)
				for (int32 DZ = -1; DZ <= 1 && !bDup; DZ++)
					if (const TArray<int32>* L = Grid.Find(C + FIntPoint(DX, DZ)))
						for (int32 I : *L)
							if (FMath::Sqrt(FMath::Square(Kept[I].X - S.X) + FMath::Square(Kept[I].Z - S.Z)) < Radius && FMath::Abs(Kept[I].Y - S.Y) < 3) { bDup = true; break; }
			if (bDup) continue;
			Grid.FindOrAdd(C).Add(Kept.Num());
			Kept.Add(S);
		}
		return Kept;
	}

	/** Cell grid over local x, z with centres at (i + 0.5) * Cell (like the web game's road.scan). */
	struct FGrid
	{
		double Cell = 0.5;
		int32 C0 = 0, C1 = 0, R0 = 0, R1 = 0;
		int32 Cols() const { return C1 - C0; }
		int32 Rows() const { return R1 - R0; }
		FVector2D Centre(int32 Key) const { const int32 C = Key % Cols(), R = Key / Cols(); return FVector2D((C0 + C + 0.5) * Cell, (R0 + R + 0.5) * Cell); }
	};

	/** rasterizeMesh: drawn height of every triangle at each cell centre it covers. Vertices Unreal cm relative to Origin (cm). */
	static void Rasterize(const TArray<FVector3f>& Pos, const TArray<uint32>& Idx, const FVector& Origin, const FGrid& G, TMap<int32, TArray<double>>& Out)
	{
		const double C = G.Cell;
		for (int32 K = 0; K + 2 < Idx.Num(); K += 3)
		{
			auto P = [&](uint32 I) { const FVector3f& V = Pos[I]; return FVector((V.X + Origin.X) / 100.0, V.Z / 100.0, (V.Y + Origin.Y) / 100.0); };
			const FVector A = P(Idx[K]), B = P(Idx[K + 1]), Cc = P(Idx[K + 2]);
			const double Det = (B.Z - Cc.Z) * (A.X - Cc.X) + (Cc.X - B.X) * (A.Z - Cc.Z);
			if (FMath::Abs(Det) < 1e-9) continue;
			const int32 I0 = FMath::Max(G.C0, FMath::FloorToInt(FMath::Min3(A.X, B.X, Cc.X) / C - 0.5)), I1 = FMath::Min(G.C1 - 1, FMath::CeilToInt(FMath::Max3(A.X, B.X, Cc.X) / C - 0.5));
			const int32 J0 = FMath::Max(G.R0, FMath::FloorToInt(FMath::Min3(A.Z, B.Z, Cc.Z) / C - 0.5)), J1 = FMath::Min(G.R1 - 1, FMath::CeilToInt(FMath::Max3(A.Z, B.Z, Cc.Z) / C - 0.5));
			for (int32 I = I0; I <= I1; I++)
				for (int32 J = J0; J <= J1; J++)
				{
					const double X = (I + 0.5) * C, Z = (J + 0.5) * C;
					const double L1 = ((B.Z - Cc.Z) * (X - Cc.X) + (Cc.X - B.X) * (Z - Cc.Z)) / Det;
					const double L2 = ((Cc.Z - A.Z) * (X - Cc.X) + (A.X - Cc.X) * (Z - Cc.Z)) / Det;
					const double L3 = 1 - L1 - L2;
					if (L1 < -1e-6 || L2 < -1e-6 || L3 < -1e-6) continue;
					Out.FindOrAdd((J - G.R0) * G.Cols() + (I - G.C0)).Add(L1 * A.Y + L2 * B.Y + L3 * Cc.Y);
				}
		}
	}

	static TArray<double> MergeLevels(TArray<double> Ys)
	{
		Ys.Sort([](double A, double B) { return A > B; });
		TArray<double> Out;
		for (double Y : Ys) if (!Out.Num() || Out.Last() - Y > Limits::Level) Out.Add(Y);
		return Out;
	}

	TArray<FIssue> ScanImpl(const UWorld* World, const USlsWorldSubsystem* Sub, const FBox2D& Bounds, TFunctionRef<bool(const FVector2D&)> InArea,
		const FThresholds& Th, bool bCluster, int32& OutCells);

	TArray<FIssue> Scan(const UWorld* World, const USlsWorldSubsystem* Sub, double X, double Z, double Radius, int32& OutCells)
	{
		const FVector2D Centre(X, Z);
		return ScanImpl(World, Sub, FBox2D(Centre - FVector2D(Radius), Centre + FVector2D(Radius)),
			[Centre, Radius](const FVector2D& P) { return FVector2D::Distance(P, Centre) <= Radius; }, FThresholds(), true, OutCells);
	}

	TArray<FIssue> ScanRect(const UWorld* World, const USlsWorldSubsystem* Sub, const FBox2D& Rect, const FThresholds& Th, bool bCluster, int32& OutCells)
	{
		// Half-open rectangle so neighbouring tiles never check a cell twice.
		return ScanImpl(World, Sub, Rect,
			[Rect](const FVector2D& P) { return P.X >= Rect.Min.X && P.X < Rect.Max.X && P.Y >= Rect.Min.Y && P.Y < Rect.Max.Y; }, Th, bCluster, OutCells);
	}

	TArray<FIssue> ScanImpl(const UWorld* World, const USlsWorldSubsystem* Sub, const FBox2D& Bounds, TFunctionRef<bool(const FVector2D&)> InArea,
		const FThresholds& Th, bool bCluster, int32& OutCells)
	{
		TArray<const AActor*> Ignore;
		if (const APlayerController* PC = World->GetFirstPlayerController()) if (PC->GetPawn()) Ignore.Add(PC->GetPawn());
		FGrid G;
		// One cell of margin around the area: steps and slots look at neighbours.
		G.C0 = FMath::FloorToInt(Bounds.Min.X / G.Cell) - 1; G.C1 = FMath::CeilToInt(Bounds.Max.X / G.Cell) + 1;
		G.R0 = FMath::FloorToInt(Bounds.Min.Y / G.Cell) - 1; G.R1 = FMath::CeilToInt(Bounds.Max.Y / G.Cell) + 1;
		const int32 Cols = G.Cols();
		TMap<int32, TArray<double>> Levels, Paved;
		for (const auto& [T, A] : Sub->Loaded())
		{
			if (!A || !A->HasCollision()) continue;
			const FVector O = A->GetActorLocation();
			Rasterize(A->RoadPos, A->RoadIdx, O, G, Levels);
			Rasterize(A->PavedPos, A->PavedIdx, O, G, Paved);
		}
		auto Inside = [&](int32 C, int32 R) { return InArea(FVector2D((G.C0 + C + 0.5) * G.Cell, (G.R0 + R + 0.5) * G.Cell)); };
		TMap<int32, TArray<FCell>> Cells;
		for (const auto& [Key, Ys] : Levels)
		{
			const FVector2D C = G.Centre(Key);
			TArray<FCell>& L = Cells.Add(Key);
			for (double Yd : MergeLevels(Ys)) L.Add(Probe(World, C.X, C.Y, Yd, Ignore));
		}
		TArray<FIssue> Out;
		OutCells = 0;
		auto Add = [&](int32 Key, double Yd, EKind K, double Size, FName What) { const FVector2D C = G.Centre(Key); Out.Add({C.X, Yd, C.Y, K, Size, What}); };
		// surfaceIssues
		for (const auto& [Key, L] : Cells)
		{
			const int32 C = Key % Cols, R = Key / Cols;
			if (!Inside(C, R)) continue;
			OutCells++;
			for (const FCell& S : L)
			{
				if (!S.Yw.IsSet() || S.Yw.GetValue() < S.Yd - Limits::Hole) { Add(Key, S.Yd, EKind::Hole, Limits::Hole, S.Wheel); continue; }
				const double Yw = S.Yw.GetValue();
				if (Yw > S.Yd + Th.Bump) Add(Key, S.Yd, EKind::Bump, Yw - S.Yd, S.Wheel);
				else if (Yw < S.Yd - Th.Dip) Add(Key, S.Yd, EKind::Dip, S.Yd - Yw, S.Wheel);
				if (S.Yc.IsSet() && S.Yc.GetValue() > Yw + Th.Snag) Add(Key, S.Yd, EKind::Snag, S.Yc.GetValue() - Yw, S.Chassis);
				for (const FIntPoint D : {FIntPoint(1, 0), FIntPoint(0, 1), FIntPoint(-1, 0), FIntPoint(0, -1)})
				{
					if ((D.X < 0 || D.Y < 0) && Inside(C + D.X, R + D.Y)) continue;
					if (C + D.X < 0 || C + D.X >= Cols) continue;
					const TArray<FCell>* N = Cells.Find(Key + D.Y * Cols + D.X);
					if (!N) continue;
					const FCell* O = N->FindByPredicate([&](const FCell& Q) { return FMath::Abs(Q.Yd - S.Yd) < Limits::Level; });
					if (!O || !O->Yw.IsSet() || O->Yw.GetValue() < O->Yd - Limits::Hole) continue;
					const double Dh = FMath::Abs(O->Yw.GetValue() - Yw);
					if (Dh > Th.Step) Add(Key, S.Yd, EKind::Step, Dh, O->Yw.GetValue() > Yw ? O->Wheel : S.Wheel);
				}
			}
		}
		// slotCells + gapIssues
		const int32 Rows = G.Rows();
		TMap<int32, double> Slots;
		for (const auto& [Key, Ys] : Levels)
		{
			const int32 C = Key % Cols, R = Key / Cols;
			for (const FIntPoint D : {FIntPoint(1, 0), FIntPoint(0, 1)})
			{
				int32 N = 1;
				auto At = [&](int32 I) { return (R + D.Y * I) * Cols + C + D.X * I; };
				auto Ok = [&](int32 I) { return C + D.X * I < Cols && R + D.Y * I < Rows; };
				while (N <= Limits::Slot && Ok(N) && !Levels.Contains(At(N))) N++;
				if (N == 1 || N > Limits::Slot || !Ok(N)) continue;
				const double Ya = FMath::Max(Ys), Yb = FMath::Max(Levels[At(N)]);
				if (FMath::Abs(Ya - Yb) > 0.5) continue;
				for (int32 I = 1; I < N; I++) if (!Slots.Contains(At(I))) Slots.Add(At(I), Ya + (Yb - Ya) * I / N);
			}
		}
		for (const auto& [Key, Yd] : Slots)
		{
			if (!Inside(Key % Cols, Key / Cols)) continue;
			const FVector2D C = G.Centre(Key);
			const FCell S = Probe(World, C.X, C.Y, Yd, Ignore);
			const double Drop = S.Yw.IsSet() ? S.Yd - S.Yw.GetValue() : Limits::Hole;
			if (Drop > Th.Gap) Add(Key, Yd, EKind::Gap, FMath::Min(Drop, Limits::Hole), S.Wheel);
		}
		// edgeCells + edgeIssues
		TMap<int32, double> Edges;
		for (const auto& [Key, Ys] : Paved)
		{
			const int32 C = Key % Cols, R = Key / Cols;
			const double Top = FMath::Max(Ys);
			for (const FIntPoint D : {FIntPoint(1, 0), FIntPoint(-1, 0), FIntPoint(0, 1), FIntPoint(0, -1)})
			{
				const int32 CC = C + D.X * Limits::EdgeOut, RR = R + D.Y * Limits::EdgeOut;
				if (CC < 0 || CC >= Cols || RR < 0 || RR >= Rows) continue;
				bool bOpen = true;
				for (int32 I = 1; I <= Limits::EdgeOut && bOpen; I++) bOpen = !Paved.Contains((R + D.Y * I) * Cols + C + D.X * I);
				if (!bOpen) continue;
				double& E = Edges.FindOrAdd(RR * Cols + CC, -1e9);
				E = FMath::Max(E, Top);
			}
		}
		for (const auto& [Key, Yd] : Edges)
		{
			if (!Inside(Key % Cols, Key / Cols)) continue;
			const FVector2D C = G.Centre(Key);
			const FCell S = Probe(World, C.X, C.Y, Yd, Ignore);
			if (!S.Yw.IsSet()) continue;
			const double Drop = S.Yd - S.Yw.GetValue();
			if (Drop > Th.Edge && Drop <= Limits::EdgeWall) Add(Key, Yd, EKind::Edge, Drop, S.Wheel);
		}
		if (!bCluster) return Out;
		TArray<FIssue> Road, Edge;
		for (const FIssue& I : Out) (I.Kind == EKind::Edge ? Edge : Road).Add(I);
		TArray<FIssue> Kept = Cluster(Road);
		Kept.Append(Cluster(Edge));
		return Kept;
	}

	void Parity(const UWorld* World, const ASlsTileActor* Tile, double Tol, const TArray<const AActor*>& Ignore, FParity& Out)
	{
		Out.Tiles++;
		const double C = Tile->RefCell;
		const int32 N = Tile->RefN;
		for (int32 I = 0; I < Tile->RefKey.Num(); I++)
		{
			const double CX = Tile->OriginLocal.X + (Tile->RefKey[I] % N + 0.5) * C;
			const double CZ = Tile->OriginLocal.Y + (Tile->RefKey[I] / N + 0.5) * C;
			const double Yd = Tile->RefYd[I];
			const FCell S = Probe(World, CX, CZ, Yd, Ignore);
			Out.Cells++;
			const TOptional<double> Want[2] = {
				Tile->RefYw[I] == RefNone ? TOptional<double>() : TOptional<double>(Yd + Tile->RefYw[I] / 1000.0),
				Tile->RefYc[I] == RefNone ? TOptional<double>() : TOptional<double>(Yd + Tile->RefYc[I] / 1000.0),
			};
			const TOptional<double> Got[2] = {S.Yw, S.Yc};
			for (int32 K = 0; K < 2; K++)
			{
				const bool bBothNone = !Got[K].IsSet() && !Want[K].IsSet();
				const bool bOneNone = Got[K].IsSet() != Want[K].IsSet();
				const double D = bBothNone ? 0 : bOneNone ? TNumericLimits<double>::Max() : FMath::Abs(Got[K].GetValue() - Want[K].GetValue());
				if (D <= Tol) continue;
				Out.Bad++;
				if (bOneNone) Out.Missing++;
				else Out.Worst = FMath::Max(Out.Worst, D);
				Out.Points.Add(FVector(CX, Yd, CZ));
				FParity::FCellReport& Rep = Out.Report.AddDefaulted_GetRef();
				Rep.bChassis = K == 1;
				Rep.Tile = FIntPoint(Tile->IX, Tile->IY);
				Rep.X = CX; Rep.Z = CZ; Rep.Yd = Yd;
				Rep.Unreal = Got[K]; Rep.Web = Want[K];
				Rep.Hit = K ? S.Chassis : S.Wheel;
				Rep.Dev = D;
				{
					FCollisionQueryParams Q(SCENE_QUERY_STAT(SlsSurface), false);
					for (const AActor* A : Ignore) Q.AddIgnoredActor(A);
					Rep.Hits = AllHits(World, CX + 0.013, CZ + 0.007, Yd + Limits::Above, Q);
				}
				if (Out.Examples.Num() < 20)
					Out.Examples.Add(FString::Printf(TEXT("%s bei x %.2f z %.2f (Kachel %d_%d): Unreal %s (%s), Web %s"), K ? TEXT("Chassis") : TEXT("Rad"), CX, CZ, Tile->IX, Tile->IY,
						Got[K].IsSet() ? *FString::Printf(TEXT("%.3f"), Got[K].GetValue()) : TEXT("nichts"), *(K ? S.Chassis : S.Wheel).ToString(),
						Want[K].IsSet() ? *FString::Printf(TEXT("%.3f"), Want[K].GetValue()) : TEXT("nichts")));
			}
		}
	}
}
