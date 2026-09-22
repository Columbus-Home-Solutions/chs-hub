import { describe, expect, it } from "vitest";
import { sniffImage } from "../scripts/convert-heic-photos.ts";

function heicHeader(brand = "heic"): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 24]);
  b.set([0x66, 0x74, 0x79, 0x70], 4);
  b.set(brand.split("").map((c) => c.charCodeAt(0)), 8);
  return b;
}

describe("convert-heic-photos sniffImage", () => {
  it("recognizes JPEG, PNG, and iPhone HEIC brands", () => {
    expect(sniffImage(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(sniffImage(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBe("png");
    expect(sniffImage(heicHeader("heic"))).toBe("heic");
    expect(sniffImage(heicHeader("mif1"))).toBe("heic");
    expect(sniffImage(new Uint8Array(16))).toBe("unknown");
  });
});
