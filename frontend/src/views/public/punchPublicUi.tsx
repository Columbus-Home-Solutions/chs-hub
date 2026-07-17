import logoUrl from "../../assets/chs-logo.png";
import { Spinner } from "../../components/ui/Spinner";

export function PunchPublicLoading({ label = "Loading…" }: { label?: string }) {
  return (
    <div class="quote-shell">
      <Spinner center />
      <div class="quote-loading">{label}</div>
    </div>
  );
}

export function PunchPublicError({
  inactive,
  message,
}: {
  inactive: boolean;
  message?: string | null;
}) {
  return (
    <div class="quote-shell">
      <div class="quote-card quote-empty">
        <div class="quote-empty__icon">🔗</div>
        <h1>{inactive ? "Link no longer active" : "Something went wrong"}</h1>
        <p>
          {inactive
            ? "This link is no longer active. Contact Tony at (501) 551-1814."
            : message ?? "Could not load your items."}
        </p>
      </div>
    </div>
  );
}

export function PunchPublicHeader({
  title,
  address,
}: {
  title: string;
  address?: string | null;
}) {
  return (
    <header class="portal-header">
      <div class="portal-header__bar">
        <div class="portal-header__brand">
          <img class="portal-header__logo" src={logoUrl} alt="Columbus Home Solutions" />
          <div>
            <div class="portal-header__company">Columbus Home Solutions</div>
            <div class="portal-header__job">{title}</div>
          </div>
        </div>
      </div>
      {address ? (
        <div class="portal-header__client">
          <span class="portal-header__addr">{address}</span>
        </div>
      ) : null}
    </header>
  );
}

export function PunchPublicFooter() {
  return (
    <footer class="punch-page__footer">
      Questions? Call Tony:{" "}
      <a href="tel:+15015511814">(501) 551-1814</a>
    </footer>
  );
}
