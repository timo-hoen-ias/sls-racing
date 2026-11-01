#include "SlsTileFile.h"
#include "Misc/FileHelper.h"
#include "Misc/Compression.h"
#include "Serialization/JsonReader.h"
#include "Serialization/JsonSerializer.h"

bool FSlsTileFile::Load(const FString& Path, FString& OutError)
{
	TArray<uint8> Raw;
	if (!FFileHelper::LoadFileToArray(Raw, *Path, FILEREAD_Silent))
	{
		OutError = FString::Printf(TEXT("Datei fehlt: %s"), *Path);
		return false;
	}
	// Gzip (magic 1f 8b): the uncompressed size is the last four bytes (ISIZE).
	if (Raw.Num() > 18 && Raw[0] == 0x1f && Raw[1] == 0x8b)
	{
		const uint32 Size = uint32(Raw[Raw.Num() - 4]) | uint32(Raw[Raw.Num() - 3]) << 8 | uint32(Raw[Raw.Num() - 2]) << 16 | uint32(Raw[Raw.Num() - 1]) << 24;
		Data.SetNumUninitialized(Size);
		if (!FCompression::UncompressMemory(NAME_Gzip, Data.GetData(), Size, Raw.GetData(), Raw.Num()))
		{
			OutError = FString::Printf(TEXT("Gzip kaputt: %s"), *Path);
			return false;
		}
	}
	else
	{
		Data = MoveTemp(Raw);
	}
	if (Data.Num() < 12 || FMemory::Memcmp(Data.GetData(), "SLSU", 4) != 0)
	{
		OutError = FString::Printf(TEXT("keine SLSU-Kachel: %s"), *Path);
		return false;
	}
	const uint32 FileVersion = *reinterpret_cast<const uint32*>(Data.GetData() + 4);
	const uint32 HeaderLen = *reinterpret_cast<const uint32*>(Data.GetData() + 8);
	if (FileVersion != Version || 12 + int64(HeaderLen) > Data.Num())
	{
		OutError = FString::Printf(TEXT("SLSU-Version %u (erwartet %d): %s"), FileVersion, Version, *Path);
		return false;
	}
	const FUTF8ToTCHAR Conv(reinterpret_cast<const ANSICHAR*>(Data.GetData() + 12), HeaderLen);
	const FString HeaderText(Conv.Length(), Conv.Get());
	TSharedPtr<FJsonObject> H;
	if (!FJsonSerializer::Deserialize(TJsonReaderFactory<>::Create(HeaderText), H) || !H.IsValid())
	{
		OutError = FString::Printf(TEXT("Kopf nicht lesbar: %s"), *Path);
		return false;
	}
	Header = H;
	IX = int32(H->GetNumberField(TEXT("ix")));
	IY = int32(H->GetNumberField(TEXT("iy")));
	auto Vec2 = [&H](const TCHAR* Field) {
		const TArray<TSharedPtr<FJsonValue>>& A = H->GetArrayField(Field);
		return FVector2D(A[0]->AsNumber(), A[1]->AsNumber());
	};
	OriginLocal = Vec2(TEXT("originLocal"));
	OriginUE = Vec2(TEXT("originUE"));
	for (const TSharedPtr<FJsonValue>& V : H->GetArrayField(TEXT("layers")))
	{
		const TSharedPtr<FJsonObject>& O = V->AsObject();
		FSlsLayerInfo& L = Layers.AddDefaulted_GetRef();
		L.Name = O->GetStringField(TEXT("name"));
		L.Verts = int32(O->GetNumberField(TEXT("verts")));
		L.Tris = int32(O->GetNumberField(TEXT("tris")));
		L.bUV = O->GetBoolField(TEXT("uv"));
		L.bColor = O->GetBoolField(TEXT("col"));
		L.bSplat = O->GetBoolField(TEXT("splat"));
	}
	for (const TSharedPtr<FJsonValue>& V : H->GetArrayField(TEXT("colliders")))
	{
		const TSharedPtr<FJsonObject>& O = V->AsObject();
		FSlsColliderGroup& G = Colliders.AddDefaulted_GetRef();
		G.Kind = FName(*O->GetStringField(TEXT("kind")));
		G.bWheelsOnly = O->GetBoolField(TEXT("wheelsOnly"));
		G.Friction = float(O->GetNumberField(TEXT("friction")));
		G.bTri = O->GetStringField(TEXT("shape")) == TEXT("tri");
	}
	const TSharedPtr<FJsonObject>* Ref;
	if (H->TryGetObjectField(TEXT("ref"), Ref))
	{
		RefCell = float((*Ref)->GetNumberField(TEXT("cell")));
		RefN = int32((*Ref)->GetNumberField(TEXT("n")));
	}
	const int64 DataStart = (12 + int64(HeaderLen) + 3) & ~int64(3);
	for (const TSharedPtr<FJsonValue>& V : H->GetArrayField(TEXT("s")))
	{
		const TArray<TSharedPtr<FJsonValue>>& S = V->AsArray();
		FSection Sec{DataStart + int64(S[2]->AsNumber()), int64(S[3]->AsNumber())};
		if (Sec.Offset + Sec.Length > Data.Num())
		{
			OutError = FString::Printf(TEXT("Sektion %s ausserhalb der Datei: %s"), *S[0]->AsString(), *Path);
			return false;
		}
		Sections.Add(S[0]->AsString(), Sec);
	}
	return true;
}
