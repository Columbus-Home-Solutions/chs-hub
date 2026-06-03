import { useEffect } from "preact/hooks";
import { AuthProvider } from "./store/auth";
import { ToastProvider } from "./store/toast";
import { AppShell } from "./components/layout/AppShell";
import { ToastViewport } from "./components/ui/Toast";
import { AppRouter } from "./router";
import { isNativePlatform, registerPushDevice } from "./lib/native";

export function App() {
  // On the Capacitor native shell, register this device for push (SIMULATE
  // dispatch this sprint). On web/PWA this is a no-op — the existing path runs
  // unchanged, so the PWA never regresses.
  useEffect(() => {
    if (isNativePlatform()) void registerPushDevice();
  }, []);

  return (
    <AuthProvider>
      <ToastProvider>
        <AppShell>
          <AppRouter />
        </AppShell>
        <ToastViewport />
      </ToastProvider>
    </AuthProvider>
  );
}
