/**
 * One-time (re-runnable) conversion of HEIC/HEIF photos already in R2.
 *
 * Workers cannot decode HEIC, so this runs locally:
 *   npx tsx scripts/convert-heic-photos.ts
 *
 * For each photos row:
 *   1. Download r2_key from remote R2
 *   2. If the bytes are HEIC/HEIF, convert to JPEG (keep EXIF timestamp/GPS)
 *   3. Write JPEG back to the same key with Content-Type image/jpeg
 *   4. Write an ~800px JPEG thumb to thumb_key
 *   5. GET the remote object again and refuse to count it done unless it is JPEG
 *
 * JPEG/PNG originals are left alone.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import convert from "heic-convert";
import exifr from "exifr";
import piexif from "piexifjs";
import sharp from "sharp";

const BUCKET = "chs-hub-files";
const DB = "chs-hub-db";
const THUMB_MAX = 800;
const JPEG_QUALITY = 0.92;

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "mif1", "msf1", "heif"]);

interface PhotoRow {
  id: string;
  r2_key: string;
  thumb_key: string | null;
  r2_thumbnail_key: string | null;
  taken_at: string | null;
  latitude: number | null;
  longitude: number | null;
  gps_lat: number | null;
  gps_lng: number | null;
  job_number: number | null;
  job_title: string | null;
}

interface PhotoExif {
  takenAt: string | null;
  latitude: number | null;
  longitude: number | null;
}

function sleep(ms: number): void {
  execFileSync("sleep", [String(Math.max(1, Math.ceil(ms / 1000)))]);
}

function wrangler(args: string[], opts: { encoding?: "utf8"; maxBuffer?: number } = {}): string {
  let last: unknown;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      return execFileSync("npx", ["wrangler", ...args], {
        encoding: opts.encoding ?? "utf8",
        maxBuffer: opts.maxBuffer ?? 32 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      last = err;
      const msg = err instanceof Error ? err.message : String(err);
      if (!/fetch failed|connectivity/i.test(msg) || attempt === 4) throw err;
      console.warn(`  wrangler retry ${attempt}/3 after fetch failure`);
      sleep(1500 * attempt);
    }
  }
  throw last;
}

function d1Query<T>(sql: string): T[] {
  const out = wrangler(["d1", "execute", DB, "--remote", "--json", "--command", sql]);
  const parsed = JSON.parse(out) as Array<{ results?: T[] }>;
  return parsed[0]?.results ?? [];
}

function d1Exec(sql: string): void {
  wrangler(["d1", "execute", DB, "--remote", "--command", sql]);
}

function r2Get(key: string, dest: string): void {
  wrangler(["r2", "object", "get", `${BUCKET}/${key}`, "--remote", "--file", dest]);
}

function r2Put(key: string, file: string): void {
  wrangler([
    "r2",
    "object",
    "put",
    `${BUCKET}/${key}`,
    "--remote",
    "--file",
    file,
    "--content-type",
    "image/jpeg",
  ]);
}

export function sniffImage(buf: Uint8Array): "jpeg" | "png" | "heic" | "unknown" {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "jpeg";
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47
  ) {
    return "png";
  }
  if (buf.length >= 12) {
    const ftyp = String.fromCharCode(buf[4], buf[5], buf[6], buf[7]);
    const brand = String.fromCharCode(buf[8], buf[9], buf[10], buf[11]).toLowerCase();
    if (ftyp === "ftyp" && HEIC_BRANDS.has(brand)) return "heic";
  }
  return "unknown";
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

function bufferToBinaryString(buf: Buffer): string {
  const chunks: string[] = [];
  const size = 0x8000;
  for (let i = 0; i < buf.length; i += size) {
    chunks.push(String.fromCharCode(...buf.subarray(i, i + size)));
  }
  return chunks.join("");
}

function binaryStringToBuffer(binary: string): Buffer {
  const bytes = Buffer.alloc(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

async function readExif(buf: Buffer): Promise<PhotoExif> {
  try {
    const [parsed, gps] = await Promise.all([
      exifr.parse(buf, { pick: ["DateTimeOriginal", "CreateDate", "DateTime"] }),
      exifr.gps(buf).catch(() => null),
    ]);
    const raw = parsed?.DateTimeOriginal ?? parsed?.CreateDate ?? parsed?.DateTime;
    let takenAt: string | null = null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) takenAt = raw.toISOString();
    else if (typeof raw === "string") {
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

function injectExif(jpeg: Buffer, exif: PhotoExif): Buffer {
  if (!exif.takenAt && exif.latitude == null && exif.longitude == null) return jpeg;
  try {
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
    return binaryStringToBuffer(piexif.insert(dump, bufferToBinaryString(jpeg)));
  } catch {
    return jpeg;
  }
}

async function heicToJpeg(buf: Buffer): Promise<{ jpeg: Buffer; exif: PhotoExif }> {
  const exif = await readExif(buf);
  const converted = await convert({
    buffer: buf,
    format: "JPEG",
    quality: JPEG_QUALITY,
  });
  const jpeg = injectExif(Buffer.from(converted), exif);
  if (sniffImage(jpeg) !== "jpeg") throw new Error("conversion did not produce JPEG");
  return { jpeg, exif };
}

async function makeThumb(jpeg: Buffer): Promise<Buffer> {
  return sharp(jpeg)
    .rotate()
    .resize(THUMB_MAX, THUMB_MAX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 85 })
    .toBuffer();
}

function sqlStr(v: string): string {
  return `'${v.replace(/'/g, "''")}'`;
}

function maybeUpdateRow(row: PhotoRow, exif: PhotoExif): void {
  const sets: string[] = [];
  if (exif.takenAt) sets.push(`taken_at = ${sqlStr(exif.takenAt)}`);
  if (exif.latitude != null && (row.latitude == null || row.gps_lat == null)) {
    sets.push(`latitude = ${exif.latitude}`);
    sets.push(`gps_lat = ${exif.latitude}`);
  }
  if (exif.longitude != null && (row.longitude == null || row.gps_lng == null)) {
    sets.push(`longitude = ${exif.longitude}`);
    sets.push(`gps_lng = ${exif.longitude}`);
  }
  if (!sets.length) return;
  d1Exec(`UPDATE photos SET ${sets.join(", ")} WHERE id = ${sqlStr(row.id)}`);
}

function putAndVerify(key: string, bytes: Buffer, work: string): void {
  const src = join(work, "upload.jpg");
  const dest = join(work, "verify.bin");
  writeFileSync(src, bytes);
  r2Put(key, src);
  r2Get(key, dest);
  const got = readFileSync(dest);
  if (sniffImage(got) !== "jpeg") {
    throw new Error(`remote ${key} is still ${sniffImage(got)} after put — R2 write did not land`);
  }
  if (Math.abs(got.length - bytes.length) > 64) {
    throw new Error(`remote ${key} size ${got.length} != uploaded ${bytes.length}`);
  }
}

async function convertPhoto(row: PhotoRow, work: string): Promise<"converted" | "skipped"> {
  const origPath = join(work, "orig.bin");
  r2Get(row.r2_key, origPath);
  const orig = readFileSync(origPath);
  const kind = sniffImage(orig);
  const label = row.job_number != null ? `JOB-${row.job_number}` : row.id.slice(0, 8);
  if (kind !== "heic") {
    console.log(`skip ${label} ${row.id.slice(0, 8)} (${kind}, ${orig.length} bytes)`);
    return "skipped";
  }

  console.log(`convert ${label} ${row.id.slice(0, 8)} (${orig.length} bytes HEIC)`);
  const { jpeg, exif } = await heicToJpeg(orig);
  const thumb = await makeThumb(jpeg);
  putAndVerify(row.r2_key, jpeg, work);
  const thumbKey = row.thumb_key || row.r2_thumbnail_key;
  if (thumbKey && thumbKey !== row.r2_key) {
    putAndVerify(thumbKey, thumb, work);
  }
  maybeUpdateRow(row, exif);
  console.log(
    `  ok jpeg ${jpeg.length} bytes · thumb ${thumb.length} bytes` +
      (exif.takenAt ? ` · exif ${exif.takenAt}` : ""),
  );
  return "converted";
}

async function main() {
  const rows = d1Query<PhotoRow>(`
    SELECT p.id, p.r2_key, p.thumb_key, p.r2_thumbnail_key, p.taken_at,
           p.latitude, p.longitude, p.gps_lat, p.gps_lng,
           j.job_number, j.title AS job_title
      FROM photos p
      LEFT JOIN jobs j ON j.id = p.job_id
     ORDER BY p.created_at
  `);
  console.log(`photos in D1: ${rows.length}`);

  let converted = 0;
  let skipped = 0;
  const work = mkdtempSync(join(tmpdir(), "chs-heic-"));
  try {
    for (const row of rows) {
      const result = await convertPhoto(row, work);
      if (result === "converted") converted += 1;
      else skipped += 1;
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }

  console.log(`done. converted=${converted} skipped=${skipped}`);
  if (converted === 0) process.exitCode = 0;
}

const isMain = process.argv[1]?.includes("convert-heic-photos");
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
