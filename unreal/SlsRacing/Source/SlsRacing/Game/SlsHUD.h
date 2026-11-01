#pragma once

#include "CoreMinimal.h"
#include "GameFramework/HUD.h"
#include "SlsHUD.generated.h"

/**
 * Driving HUD drawn on the canvas: speed, gear, rev bar, nitro tank, feel and drift state, plus the position line
 * of the web game's debug overlay (hud.debug). Will move to UMG together with the menus in phase 5.
 */
UCLASS()
class SLSRACING_API ASlsHUD : public AHUD
{
	GENERATED_BODY()
public:
	virtual void DrawHUD() override;
};
