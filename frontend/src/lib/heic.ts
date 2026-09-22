/**
 * Normalize HEIC/HEIF photos to JPEG before upload.
 *
 * iPhone camera roll defaults to HEIC. Browsers (and the CHS <img> pipeline)
 * cannot render that format, so every upload path runs files through this
 * helper first. JPEG/PNG/WebP pass through unchanged — no re-encode.
 *
 * EXIF timestamp/GPS are read from the original (exifr supports HEIC) and
 * written back onto the JPEG so Module-Spec-Photo-Capture §6.1 still holds
 * after conversion.
 */

export const HEIC_PROCESS_ERROR =
  "Couldn't process this photo — try again or use a different photo";

export interface PreparedPhoto {
  file: File;
  converted: boolean;
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

const HEIC_MIME = new Set(["image/heic", "image/heif", "image/heic-sequence", "image/heif-sequence"]);
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heif"]);
const PASSTHROUGH_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/webp", "image/gif"]);

export function fileNameOf(file: Blob, fallback = ""): string {
  return (file instanceof File ? file.name : fallback) || fallback;
}

export function isHeicByNameOrType(file: Blob, name = fileNameOf(file)): boolean {
  const type = (file.type || "").toLowerCase();
  if (HEIC_MIME.has(type)) return true;
  const n = name.toLowerCase();
  return n.endsWith(".heic") || n.endsWith(".heif");
}

/** ISO-BMFF `ftyp` brand check — iOS often reports an empty or generic MIME. */
export function looksLikeHeicBytes(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  const ftyp = String.fromCharCode(bytes[4], bytes[5], bytes[6], bytes[7]);
  if (ftyp !== "ftyp") return false;
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return HEIC_BRANDS.has(brand);
}

export async function shouldConvertToJpeg(file: Blob, name = fileNameOf(file)): Promise<boolean> {
  if (isHeicByNameOrType(file, name)) return true;
  const type = (file.type || "").toLowerCase();
  if (PASSTHROUGH_MIME.has(type)) return false;
  try {
    const buf = await file.slice(0, 16).arrayBuffer();
    return looksLikeHeicBytes(new Uint8Array(buf));
  } catch {
    return false;
  }
}

interface PhotoExif {
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

export async function readPhotoExif(file: Blob): Promise<PhotoExif> {
  try {
    const exifrMod = await import("exifr");
    const exifr = exifrMod.default ?? exifrMod;
    const [parsed, gps] = await Promise.all([
      exifr.parse(file, { pick: ["DateTimeOriginal", "CreateDate", "DateTime"] }),
      exifr.gps(file).catch(() => null),
    ]);
    const raw = parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? parsed?.DateTime;
    let takenAt: string | null = null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      takenAt = raw.toISOString();
    } else if (typeof raw === "string") {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) takenAt = d.toISOString();
    }
    return {
      takenAt,
      latitude: gps && Number.isFinite(gps.latitude) ? gps.latitude : null,
      longitude: gps && Number.isFinite(gps.longitude) ? gps.longitude : null,
    };
  } catch {
    return { takenAt: null, latitude: null, longitude: null };
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

function formatExifDate(d: Date): string {
  return `${d.getUTCFullYear()}:${pad2(d.getUTCMonth() + 1)}:${pad2(d.getUTCDate())} ${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`;
}

function toDms(dec: number): [[number, number], [number, number], [number, number]] {
  const abs = Math.abs(dec);
  const deg = Math.floor(abs);
  const minFloat = (abs - deg) * 60;
  const min = Math.floor(minFloat);
  const sec = Math.round((minFloat - min) * 60 * 100);
  return [
    [deg, 1],
    [min, 1],
    [sec, 100],
  ];
}

function arrayBufferToBinaryString(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  const chunks: string[] = [];
  const size = 0x8000;
  for (let i = 0; i < bytes.length; i += size) {
    chunks.push(String.fromCharCode(...bytes.subarray(i, i + size)));
  }
  return chunks.join("");
}

function binaryStringToBlob(binary: string, type: string): Blob {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return new Blob([bytes], { type });
}

export async function injectExifIntoJpeg(jpeg: Blob, exif: PhotoExif): Promise<Blob> {
  if (!exif.takenAt && exif.latitude == null && exif.longitude == null) return jpeg;
  try {
    type Piexif = {
      ImageIFD: { DateTime: number };
      ExifIFD: { DateTimeOriginal: number; DateTimeDigitized: number };
      GPSIFD: {
        GPSLatitudeRef: number;
        GPSLatitude: number;
        GPSLongitudeRef: number;
        GPSLongitude: number;
      };
      dump: (data: Record<string, unknown>) => string;
      insert: (exif: string, jpeg: string) => string;
    };
    const piexifMod = (await import("piexifjs")) as unknown as Piexif & { default?: Piexif };
    const piexif = piexifMod.default ?? piexifMod;
    const zeroth: Record<number, string> = {};
    const exifIfd: Record<number, string> = {};
    const gps: Record<number, unknown> = {};

    if (exif.takenAt) {
      const d = new Date(exif.takenAt);
      if (!Number.isNaN(d.getTime())) {
        const formatted = formatExifDate(d);
        zeroth[piexif.ImageIFD.DateTime] = formatted;
        exifIfd[piexif.ExifIFD.DateTimeOriginal] = formatted;
        exifIfd[piexif.ExifIFD.DateTimeDigitized] = formatted;
      }
    }
    if (exif.latitude != null && exif.longitude != null) {
      gps[piexif.GPSIFD.GPSLatitudeRef] = exif.latitude >= 0 ? "N" : "S";
      gps[piexif.GPSIFD.GPSLatitude] = toDms(exif.latitude);
      gps[piexif.GPSIFD.GPSLongitudeRef] = exif.longitude >= 0 ? "E" : "W";
      gps[piexif.GPSIFD.GPSLongitude] = toDms(exif.longitude);
    }

    const dump = piexif.dump({ "0th": zeroth, Exif: exifIfd, GPS: gps });
    const binary = arrayBufferToBinaryString(await jpeg.arrayBuffer());
    const inserted = piexif.insert(dump, binary);
    return binaryStringToBlob(inserted, "image/jpeg");
  } catch {
    return jpeg;
  }
}

async function canvasToJpeg(file: Blob): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, bitmap.width);
  canvas.height = Math.max(1, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close?.();
    throw new Error("canvas");
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close?.();
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92),
  );
  if (!blob) throw new Error("toBlob");
  return blob;
}

async function heic2anyConvert(file: Blob): Promise<Blob> {
  const heic2anyMod = await import("heic2any");
  const heic2any = heic2anyMod.default ?? heic2anyMod;
  const result = await heic2any({ blob: file, toType: "image/jpeg", quality: 0.92 });
  const blob = Array.isArray(result) ? result[0] : result;
  if (!(blob instanceof Blob)) throw new Error("heic2any");
  return blob;
}

export async function convertHeicToJpeg(file: Blob): Promise<Blob> {
  try {
    return await canvasToJpeg(file);
  } catch {
    /* Safari can decode HEIC natively; other browsers need heic2any */
  }
  try {
    return await heic2anyConvert(file);
  } catch {
    throw new Error(HEIC_PROCESS_ERROR);
  }
}

function asFile(blob: Blob, name: string, type: string): File {
  if (blob instanceof File && blob.name === name && blob.type === type) return blob;
  return new File([blob], name, { type, lastModified: Date.now() });
}

export async function preparePhotoForUpload(file: Blob, name = fileNameOf(file, "photo.jpg")): Promise<PreparedPhoto> {
  const convert = await shouldConvertToJpeg(file, name);
  if (!convert) {
    return {
      file: asFile(file, name || "photo.jpg", file.type || "application/octet-stream"),
      converted: false,
      takenAt: null,
      latitude: null,
      longitude: null,
    };
  }

  const exif = await readPhotoExif(file);
  let jpeg: Blob;
  try {
    jpeg = await convertHeicToJpeg(file);
  } catch (err) {
    if (err instanceof Error && err.message === HEIC_PROCESS_ERROR) throw err;
    throw new Error(HEIC_PROCESS_ERROR);
  }

  const withExif = await injectExifIntoJpeg(jpeg, exif);
  const jpegName = name.replace(/\.(heic|heif)$/i, ".jpg") || "photo.jpg";
  const finalName = /\.jpe?g$/i.test(jpegName) ? jpegName : `${jpegName}.jpg`;
  return {
    file: asFile(withExif, finalName, "image/jpeg"),
    converted: true,
    takenAt: exif.takenAt,
    latitude: exif.latitude,
    longitude: exif.longitude,
  };
}

/** Convert HEIC/HEIF to a JPEG File, or return the original when unneeded. */
export async function ensureJpegPhoto(file: Blob, name = fileNameOf(file)): Promise<File> {
  const prepared = await preparePhotoForUpload(file, name);
  return prepared.file;
}
