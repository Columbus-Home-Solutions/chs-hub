/**
 * Capacitor native-runtime bridge + graceful web fallback (Sprint 18, deliv. F).
 *
 * The web app is wrapped by Capacitor for iOS/Android, but the SAME bundle runs
 * as a PWA in a browser. Every native enhancement here is feature-detected
 * against the global `Capacitor` bridge that the native WebView injects at
 * runtime — so there is NO build-time dependency on the @capacitor/* npm
 * packages in the web bundle, and the PWA path keeps working unchanged when the
 * bridge is absent.
 *
 *   isNativePlatform()  → are we inside the Capacitor native shell?
 *   getPlatform()       → 'ios' | 'android' | 'web'
 *   registerPushDevice()→ (native only) request permission, get the FCM/APNS
 *                         token, and POST it to /api/devices/register. On web it
 *                         is a no-op (the existing web/notification path is
 *                         unchanged). Dispatch is SIMULATE this sprint.
 *   nativeHaptic()      → light haptic tap on native, no-op on web.
 */

interface CapacitorBridge {
  isNativePlatform?: () => boolean;
  getPlatform?: () => string;
  Plugins?: Record<string, unknown>;
}

function bridge(): CapacitorBridge | null {
  const cap = (globalThis as unknown as { Capacitor?: CapacitorBridge }).Capacitor;
  return cap ?? null;
}

export function isNativePlatform(): boolean {
  const cap = bridge();
  return Boolean(cap?.isNativePlatform?.());
}

export function getPlatform(): "ios" | "android" | "web" {
  const p = bridge()?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

function plugin<T = Record<string, unknown>>(name: string): T | null {
  const p = bridge()?.Plugins?.[name];
  return (p as T) ?? null;
}

interface PushPlugin {
  requestPermissions: () => Promise<{ receive: string }>;
  register: () => Promise<void>;
  addListener: (
    event: string,
    cb: (data: { value?: string; error?: string }) => void,
  ) => Promise<unknown> | unknown;
}

let pushWired = false;

/**
 * Register this device for push (native only). Returns a status string for the
 * UI. Idempotent — wires the bridge listeners once. The token is sent to the
 * backend; under SIMULATE the dispatcher logs the intended push (no live send).
 */
export async function registerPushDevice(): Promise<
  "registered" | "not_native" | "denied" | "unavailable" | "error"
> {
  if (!isNativePlatform()) return "not_native"; // PWA: existing web path, unchanged
  const push = plugin<PushPlugin>("PushNotifications");
  if (!push) return "unavailable";

  try {
    const perm = await push.requestPermissions();
    if (perm.receive !== "granted") return "denied";

    if (!pushWired) {
      pushWired = true;
      push.addListener("registration", (data) => {
        const token = data?.value;
        if (!token) return;
        void fetch("/api/devices/register", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ platform: getPlatform(), token }),
        });
      });
      push.addListener("registrationError", (data) => {
        console.warn("[push] registration error", data?.error);
      });
    }
    await push.register();
    return "registered";
  } catch (err) {
    console.warn("[push] register failed", (err as Error).message);
    return "error";
  }
}

/** Unregister this device's push token (native only; best-effort). */
export async function unregisterPushDevice(token: string): Promise<void> {
  await fetch("/api/devices/unregister", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
}

interface HapticsPlugin {
  impact: (opts: { style: string }) => Promise<void>;
}

/** Light haptic feedback on native; no-op on web. */
export function nativeHaptic(style: "LIGHT" | "MEDIUM" | "HEAVY" = "LIGHT"): void {
  if (!isNativePlatform()) return;
  const haptics = plugin<HapticsPlugin>("Haptics");
  void haptics?.impact({ style }).catch(() => undefined);
}

interface SplashPlugin {
  hide: (opts?: { fadeOutDuration?: number }) => Promise<void>;
}

/** Hide the Capacitor launch splash (native only; no-op on web). */
export async function hideNativeSplash(fadeOutDuration = 0): Promise<void> {
  if (!isNativePlatform()) return;
  const splash = plugin<SplashPlugin>("SplashScreen");
  if (!splash?.hide) return;
  try {
    await splash.hide({ fadeOutDuration });
  } catch {
    /* ignore — splash may already be gone */
  }
}

interface CameraPhotoResult {
  base64String?: string;
  dataUrl?: string;
  format: string;
}

interface CameraPlugin {
  getPhoto: (options: Record<string, unknown>) => Promise<CameraPhotoResult>;
  requestPermissions?: () => Promise<{ camera?: string; photos?: string }>;
}

interface AppPlugin {
  openUrl: (opts: { url: string }) => Promise<void>;
}

function base64ToBlob(base64: string, mime: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

/**
 * Native camera / photo-library picker via @capacitor/camera.
 * Returns null on web (caller should fall back to `<input type="file">`).
 * Throws on cancel/permission denial so callers can toast.
 */
export async function capturePhotoNative(): Promise<Blob | null> {
  if (!isNativePlatform()) return null;
  const camera = plugin<CameraPlugin>("Camera");
  if (!camera?.getPhoto) return null;

  try {
    await camera.requestPermissions?.();
  } catch {
    /* requestPermissions may be unavailable; getPhoto will prompt */
  }

  const photo = await camera.getPhoto({
    quality: 90,
    allowEditing: false,
    // Prompt = Camera + Photo Library (standard iOS action sheet).
    source: "PROMPT",
    resultType: "base64",
    promptLabelHeader: "Visit photo",
    promptLabelPicture: "Take Photo",
    promptLabelPhoto: "Photo Library",
    promptLabelCancel: "Cancel",
  });

  const b64 = photo.base64String;
  if (!b64) throw new Error("Camera returned no image data");
  const format = (photo.format || "jpeg").toLowerCase();
  const mime = format === "png" ? "image/png" : "image/jpeg";
  return base64ToBlob(b64, mime);
}

/** Open iOS/Android app Settings (native only) so the user can re-enable mic/camera. */
export async function openAppSettings(): Promise<void> {
  if (!isNativePlatform()) return;
  const app = plugin<AppPlugin>("App");
  if (!app?.openUrl) return;
  try {
    // iOS: app-settings: · Android: package settings via Capacitor App
    const url = getPlatform() === "ios" ? "app-settings:" : "app-settings:";
    await app.openUrl({ url });
  } catch (err) {
    console.warn("[native] openAppSettings failed", (err as Error).message);
  }
}

interface AudioRecorderPlugin {
  startRecording: (opts?: Record<string, unknown>) => Promise<void>;
  stopRecording: () => Promise<{ uri?: string; duration?: number; blob?: Blob }>;
  cancelRecording?: () => Promise<void>;
  getRecordingStatus?: () => Promise<{ status: string }>;
  requestPermissions?: () => Promise<{ recordAudio?: string }>;
  checkPermissions?: () => Promise<{ recordAudio?: string }>;
}

interface FilesystemPlugin {
  readFile: (opts: { path: string; directory?: string }) => Promise<{ data: string | Blob }>;
}

function convertFileSrc(path: string): string {
  const cap = bridge() as CapacitorBridge & { convertFileSrc?: (p: string) => string };
  return cap?.convertFileSrc?.(path) ?? path;
}

function mimeFromUri(uri: string): string {
  const lower = uri.toLowerCase();
  if (lower.endsWith(".webm")) return "audio/webm";
  if (lower.endsWith(".wav")) return "audio/wav";
  if (lower.endsWith(".mp3")) return "audio/mpeg";
  if (lower.endsWith(".aac")) return "audio/aac";
  return "audio/mp4"; // Capgo iOS writes .m4a (AAC)
}

/**
 * Read a native file:// URI into a Blob via the Filesystem bridge.
 *
 * Do NOT use fetch(convertFileSrc(uri)) when the app remote-loads over https —
 * WKWebView returns TypeError "Load failed" for those capacitor-local URLs.
 * Camera avoids this by returning base64; audio must use Filesystem.readFile.
 */
async function readNativeFileAsBlob(uri: string): Promise<{ blob: Blob; mimeType: string }> {
  const mimeType = mimeFromUri(uri);
  const fs = plugin<FilesystemPlugin>("Filesystem");
  if (!fs?.readFile) {
    throw new Error("Filesystem plugin unavailable — cannot read recording");
  }

  const candidates = [uri];
  if (uri.startsWith("file://")) candidates.push(uri.replace(/^file:\/\//, ""));
  // Some Cap versions want the path without the host-empty file:/// prefix.
  if (uri.startsWith("file:///")) candidates.push(uri.slice("file://".length));

  let lastErr: unknown;
  for (const path of candidates) {
    try {
      const { data } = await fs.readFile({ path });
      if (typeof data === "string") {
        return { blob: base64ToBlob(data, mimeType), mimeType };
      }
      if (data && typeof (data as Blob).arrayBuffer === "function") {
        const blob = data as Blob;
        return {
          blob: blob.type ? blob : new Blob([blob], { type: mimeType }),
          mimeType: blob.type || mimeType,
        };
      }
    } catch (e) {
      lastErr = e;
    }
  }

  // Last resort (rarely works under remote-load https origin — kept for bundled apps).
  try {
    const src = convertFileSrc(uri);
    const res = await fetch(src);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return { blob, mimeType: blob.type || mimeType };
  } catch (e) {
    const detail =
      lastErr instanceof Error ? lastErr.message : e instanceof Error ? e.message : "unknown";
    throw new Error(`Could not read recording file (${detail})`);
  }
}

/** True when Capgo CapacitorAudioRecorder is available (native shell). */
export function nativeAudioRecorderAvailable(): boolean {
  if (!isNativePlatform()) return false;
  return !!plugin<AudioRecorderPlugin>("CapacitorAudioRecorder")?.startRecording;
}

/**
 * Start native mic recording (@capgo/capacitor-audio-recorder).
 * Throws if unavailable or permission denied.
 */
export async function startNativeAudioRecording(): Promise<void> {
  const recorder = plugin<AudioRecorderPlugin>("CapacitorAudioRecorder");
  if (!recorder?.startRecording) throw new Error("Native audio recorder unavailable");

  const perms = await recorder.requestPermissions?.();
  if (perms?.recordAudio && perms.recordAudio !== "granted") {
    throw new Error("Microphone permission denied");
  }

  await recorder.startRecording({
    sampleRate: 44100,
    audioSessionMode: "SPOKEN_AUDIO",
  });
}

/**
 * Stop native recording and return an audio Blob for upload/transcription.
 */
export async function stopNativeAudioRecording(): Promise<{
  blob: Blob;
  mimeType: string;
  durationMs: number;
}> {
  const recorder = plugin<AudioRecorderPlugin>("CapacitorAudioRecorder");
  if (!recorder?.stopRecording) throw new Error("Native audio recorder unavailable");

  const result = await recorder.stopRecording();
  if (result.blob) {
    return {
      blob: result.blob,
      mimeType: result.blob.type || "audio/webm",
      durationMs: result.duration ?? 0,
    };
  }
  if (!result.uri) throw new Error("Recording produced no audio file");

  const { blob, mimeType } = await readNativeFileAsBlob(result.uri);
  return { blob, mimeType, durationMs: result.duration ?? 0 };
}

export async function cancelNativeAudioRecording(): Promise<void> {
  const recorder = plugin<AudioRecorderPlugin>("CapacitorAudioRecorder");
  try {
    await recorder?.cancelRecording?.();
  } catch {
    /* ignore */
  }
}
