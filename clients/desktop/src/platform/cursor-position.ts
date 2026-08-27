import { screen } from "electron";

export function cursorScreenPoint(): { x: number; y: number } {
  return screen.getCursorScreenPoint();
}
