#pragma once

#include "CoreMinimal.h"

/**
 * The drivable road network (WorldData/graph.json, the web build's graph): used to put the car back on the nearest
 * street (reset, like the web game's rescue: rank ≥ 2, right lane) and later for navigation and traffic.
 * Coordinates in the web game's local metres (x east, y up, z south).
 */
class FSlsRoadGraph
{
public:
	struct FEdge
	{
		int32 Name = -1;
		/** Road class rank, 0 = track … 9 = motorway. */
		int32 Rank = 0;
		bool bOneWay = false, bClosed = false;
		/** Centre of the rightmost lane, metres right of the centreline (a → b). */
		float RightLane = 0;
		TArray<FVector> Points;
	};

	bool Load(const FString& Path, FString& OutError);
	bool IsLoaded() const { return Edges.Num() > 0; }

	struct FSpot { FVector Pos = FVector::ZeroVector; double Heading = 0; int32 Edge = -1; };
	/** Nearest point on a drivable street of at least MinRank, in its right lane, heading along it (0 = north, clockwise). */
	bool Nearest(double X, double Z, int32 MinRank, FSpot& Out) const;
	FString NameOf(int32 Edge) const { return Edges.IsValidIndex(Edge) && Names.IsValidIndex(Edges[Edge].Name) ? Names[Edges[Edge].Name] : FString(); }

	TArray<FString> Names;
	TArray<FEdge> Edges;

private:
	/** Edge segments per 64 m cell. */
	TMap<FIntPoint, TArray<TPair<int32, int32>>> Cells;
};
