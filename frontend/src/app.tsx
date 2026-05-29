import { AuthProvider } from "./store/auth";
import { ToastProvider } from "./store/toast";
import { AppShell } from "./components/layout/AppShell";
import { ToastViewport } from "./components/ui/Toast";
import { AppRouter } from "./router";

export function App() {
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
