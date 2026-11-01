#include "SlsRoadGraph.h"
#include "Misc/FileHelper.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

static constexpr double GraphCell = 64.0;

bool FSlsRoadGraph::Load(const FString& Path, FString& OutError)
{
	FString Text;
	if (!FFileHelper::LoadFileToString(Text, *Path)) { OutError = Path + TEXT(" fehlt"); return false; }
	TSharedPtr<FJsonObject> J;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(Text), J) || !J.IsValid()) { OutError = Path + TEXT(" nicht lesbar"); return false; }
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("names"))) Names.Add(V->AsString());
	for (const TSharedPtr<FJsonValue>& V : J->GetArrayField(TEXT("edges")))
	{
		const TSharedPtr<FJsonObject>& O = V->AsObject();
		FEdge& E = Edges.AddDefaulted_GetRef();
		E.Name = int32(O->GetNumberField(TEXT("n")));
		E.Rank = int32(O->GetNumberField(TEXT("c")));
		double D = 0;
		E.bOneWay = O->TryGetNumberField(TEXT("o"), D) && D > 0;
		E.bClosed = O->TryGetNumberField(TEXT("x"), D) && D > 0;
		if (O->TryGetNumberField(TEXT("r"), D)) E.RightLane = float(D);
		const TArray<TSharedPtr<FJsonValue>>& P = O->GetArrayField(TEXT("p"));
		for (int32 I = 0; I + 2 < P.Num(); I += 3) E.Points.Add(FVector(P[I]->AsNumber(), P[I + 1]->AsNumber(), P[I + 2]->AsNumber()));
		const int32 Id = Edges.Num() - 1;
		for (int32 S = 0; S + 1 < E.Points.Num(); S++)
		{
			const FVector& A = E.Points[S];
			const FVector& B = E.Points[S + 1];
			const int32 X0 = FMath::FloorToInt(FMath::Min(A.X, B.X) / GraphCell), X1 = FMath::FloorToInt(FMath::Max(A.X, B.X) / GraphCell);
			const int32 Z0 = FMath::FloorToInt(FMath::Min(A.Z, B.Z) / GraphCell), Z1 = FMath::FloorToInt(FMath::Max(A.Z, B.Z) / GraphCell);
			for (int32 X = X0; X <= X1; X++)
				for (int32 Z = Z0; Z <= Z1; Z++) Cells.FindOrAdd(FIntPoint(X, Z)).Add({Id, S});
		}
	}
	return true;
}

bool FSlsRoadGraph::Nearest(double X, double Z, int32 MinRank, FSpot& Out) const
{
	double Best = TNumericLimits<double>::Max();
	const FIntPoint C(FMath::FloorToInt(X / GraphCell), FMath::FloorToInt(Z / GraphCell));
	for (int32 Ring = 0; Ring <= 8 && Best == TNumericLimits<double>::Max(); Ring++)
		for (int32 DX = -Ring; DX <= Ring; DX++)
			for (int32 DZ = -Ring; DZ <= Ring; DZ++)
			{
				if (FMath::Max(FMath::Abs(DX), FMath::Abs(DZ)) != Ring) continue;
				const TArray<TPair<int32, int32>>* L = Cells.Find(C + FIntPoint(DX, DZ));
				if (!L) continue;
				for (const auto& [Id, S] : *L)
				{
					const FEdge& E = Edges[Id];
					if (E.Rank < MinRank || E.bClosed) continue;
					const FVector& A = E.Points[S];
					const FVector& B = E.Points[S + 1];
					const FVector2D A2(A.X, A.Z), B2(B.X, B.Z), P(X, Z);
					const FVector2D AB = B2 - A2;
					const double Len2 = AB.SizeSquared();
					const double T = Len2 > 1e-9 ? FMath::Clamp(FVector2D::DotProduct(P - A2, AB) / Len2, 0.0, 1.0) : 0.0;
					const FVector2D Q = A2 + AB * T;
					const double D = FVector2D::DistSquared(Q, P);
					if (D >= Best) continue;
					Best = D;
					const FVector2D Dir = Len2 > 1e-9 ? AB / FMath::Sqrt(Len2) : FVector2D(0, -1);
					// Right of the a → b direction in x east / z south (north (0, -1) → east (1, 0)).
					const FVector2D Right(-Dir.Y, Dir.X);
					const double Lane = E.RightLane != 0 ? E.RightLane : 1.75;
					const FVector2D Spot = Q + Right * Lane;
					Out.Pos = FVector(Spot.X, FMath::Lerp(A.Y, B.Y, T), Spot.Y);
					// Heading 0 = north (-z), clockwise: atan2(dx, -dz).
					Out.Heading = FMath::Atan2(Dir.X, -Dir.Y);
					Out.Edge = Id;
				}
			}
	return Best < TNumericLimits<double>::Max();
}
