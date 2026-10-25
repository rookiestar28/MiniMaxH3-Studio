import type { ImageCrop } from "../host/imageCropGeometry";
import { NleIconButton, NleIconGroup } from "./nle/NleIconActions";

export type ImageCropRowActions = Readonly<{
  crops: Readonly<Record<string, ImageCrop>>;
  label: string;
  reason?: string;
  open(id: string): void;
}>;

export function ImageCropAction({
  id,
  actions,
}: {
  id: string;
  actions: ImageCropRowActions;
}) {
  const crop = actions.crops[id];
  return (
    <span className="h3-crop-row-action">
      {crop ? (
        <span className="h3-crop-chip">
          {crop.w} × {crop.h}
        </span>
      ) : null}
      <NleIconGroup label={actions.label}>
        <NleIconButton
          icon="crop"
          hue="edit"
          control={`image-crop-${id || "unchosen"}`}
          label={actions.label}
          description={actions.reason ?? actions.label}
          disabled={actions.reason !== undefined}
          focusableWhenDisabled
          onActivate={() => actions.open(id)}
        />
      </NleIconGroup>
    </span>
  );
}
