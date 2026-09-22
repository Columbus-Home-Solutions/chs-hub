import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HEIC_PROCESS_ERROR,
  isHeicByNameOrType,
  looksLikeHeicBytes,
  preparePhotoForUpload,
  shouldConvertToJpeg,
} from "../frontend/src/lib/heic.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function heicHeader(brand = "heic"): Uint8Array {
  const b = new Uint8Array(16);
  b.set([0, 0, 0, 24]);
  b.set([0x66, 0x74, 0x79, 0x70], 4); // ftyp
  const codes = brand.split("").map((c) => c.charCodeAt(0));
  b.set(codes, 8);
  return b;
}

function jpegFile(name = "site.jpg"): File {
  return new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], name, { type: "image/jpeg" });
}

function heicFile(name = "IMG_1234.HEIC", type = "image/heic"): File {
  return new File([heicHeader()], name, { type });
}

describe("HEIC detection", () => {
  it("matches MIME and file extension", () => {
    expect(isHeicByNameOrType(heicFile())).toBe(true);
    expect(isHeicByNameOrType(new File([], "photo.heif", { type: "" }))).toBe(true);
    expect(isHeicByNameOrType(jpegFile())).toBe(false);
  });

  it("sniffs ISO-BMFF ftyp brands used by iPhone HEIC/HEIF", () => {
    expect(looksLikeHeicBytes(heicHeader("heic"))).toBe(true);
    expect(looksLikeHeicBytes(heicHeader("mif1"))).toBe(true);
    expect(looksLikeHeicBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]))).toBe(false);
  });

  it("converts HEIC even when the browser reports a generic MIME", async () => {
    const unlabeled = new File([heicHeader()], "IMG_0001.JPG", { type: "application/octet-stream" });
    expect(await shouldConvertToJpeg(unlabeled)).toBe(true);
    expect(await shouldConvertToJpeg(jpegFile())).toBe(false);
  });
});

describe("preparePhotoForUpload", () => {
  it("leaves JPEG/PNG alone — no re-encode", async () => {
    const original = jpegFile();
    const prepared = await preparePhotoForUpload(original);
    expect(prepared.converted).toBe(false);
    expect(prepared.file).toBe(original);
    expect(prepared.takenAt).toBeNull();
  });

  it("fails a corrupt HEIC with the user-facing error instead of uploading it", async () => {
    await expect(preparePhotoForUpload(heicFile())).rejects.toThrow(HEIC_PROCESS_ERROR);
  });
});

describe("HEIC conversion is on every photo upload path", () => {
  const capture = readFileSync(join(repoRoot, "frontend/src/lib/capture.ts"), "utf8");
  const photosTab = readFileSync(join(repoRoot, "frontend/src/views/jobs/PhotosTab.tsx"), "utf8");
  const punchTab = readFileSync(join(repoRoot, "frontend/src/views/jobs/PunchListTab.tsx"), "utf8");
  const visit = readFileSync(join(repoRoot, "frontend/src/views/estimating/EstimateRequestDetail.tsx"), "utf8");
  const bidReq = readFileSync(join(repoRoot, "frontend/src/views/estimating/BidRequestModal.tsx"), "utf8");
  const bidPage = readFileSync(join(repoRoot, "frontend/src/views/public/BidPage.tsx"), "utf8");
  const punchPage = readFileSync(join(repoRoot, "frontend/src/views/punch/PunchPage.tsx"), "utf8");
  const subPage = readFileSync(join(repoRoot, "frontend/src/views/public/SubPage.tsx"), "utf8");
  const warranty = readFileSync(join(repoRoot, "frontend/src/views/portal/WarrantyClaimsTab.tsx"), "utf8");

  it("converts inside the shared uploadPhoto / uploadReceipt helpers", () => {
    expect(capture).toContain('import { preparePhotoForUpload } from "./heic"');
    expect(capture).toContain("preparePhotoForUpload(file)");
    expect(photosTab).toContain("uploadPhoto(");
    expect(punchTab).toContain("uploadPhoto(");
    expect(visit).toContain("uploadPhoto(");
  });

  it("converts FormData photo uploads that bypass uploadPhoto", () => {
    expect(bidReq).toContain("ensureJpegPhoto");
    expect(bidPage).toContain("ensureJpegPhoto");
    expect(punchPage).toContain("ensureJpegPhoto");
    expect(subPage).toContain("ensureJpegPhoto");
    expect(warranty).toContain("ensureJpegPhoto");
  });
});
