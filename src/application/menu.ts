import type { DeliveryPayload } from "../domain.js";

/** A text delivery with service-owned controls, not a pending SDK request. */
export type MenuPayload = Extract<DeliveryPayload, { kind: "text" }> &
  Pick<Extract<DeliveryPayload, { kind: "request" }>, "buttons">;

export function isMenuPayload(payload: DeliveryPayload): payload is MenuPayload {
  return payload.kind === "text" && "buttons" in payload && Array.isArray(payload.buttons) &&
    payload.buttons.every((row: unknown) => Array.isArray(row) && row.every((button: unknown) =>
      button !== null && typeof button === "object" && "text" in button && typeof button.text === "string" &&
      "data" in button && typeof button.data === "string"));
}
