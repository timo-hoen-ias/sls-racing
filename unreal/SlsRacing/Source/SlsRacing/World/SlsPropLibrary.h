#pragma once

#include "CoreMinimal.h"

class UStaticMesh;
class UMaterialInterface;

/** One model part of WorldData/models.slsu (unreal/tools/tileProps.ts): name, material tag, built mesh. */
struct FSlsPropPart
{
	FString Name;
	/** vcol, paint, sign or light. */
	FName Material;
	UStaticMesh* Mesh = nullptr;
};

/**
 * Builds a UStaticMesh per part of the model library at runtime (BuildFromMeshDescriptions, LODs as exported),
 * so street furniture and parked cars need no asset import: the geometry is already in Unreal's frame.
 * MaterialFor maps a tag to the material of the single section. Game thread only.
 */
bool SlsBuildPropLibrary(UObject* Outer, const FString& Path, TFunctionRef<UMaterialInterface*(FName Tag)> MaterialFor,
	TArray<FSlsPropPart>& OutParts, FString& OutError);
