import { describe, expect, it } from "vitest";

import { attachedImageMessage } from "../../src/presentation/terminal-image-message";

describe("attachedImageMessage", () => {
  it("keeps an image path relative to the Session working directory", () => {
    expect(attachedImageMessage(".termloop-runtime/mobile-attachments/photo.png", "What is wrong here?"))
      .toBe("What is wrong here?\n\nI attached an image at .termloop-runtime/mobile-attachments/photo.png. Please inspect it before responding.");
  });

  it("creates a useful prompt when the user sends only a photo", () => {
    expect(attachedImageMessage(".termloop-runtime/mobile-attachments/photo.png", "   "))
      .toBe("I attached an image at .termloop-runtime/mobile-attachments/photo.png. Please inspect it.");
  });
});
