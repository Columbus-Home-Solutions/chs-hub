import { formatDateTime, formatPhone } from "../../lib/format";
import {
  telHref,
  type UnassignedVoiceNote,
} from "@chs/shared/message-center-unassigned";
import { relativeTimestamp } from "./helpers";

export function UnassignedDetail({
  note,
  dismissedIds,
  onDismiss,
  onBack,
}: {
  note: UnassignedVoiceNote;
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
  onBack?: () => void;
}) {
  const unreviewed = !dismissedIds.has(note.id);
  const callHref = telHref(note.callback_phone);

  return (
    <div class="mc-thread">
      <div class="mc-header">
        {onBack && (
          <button class="mc-back" onClick={onBack} aria-label="Back to list">
            ←
          </button>
        )}
        <div class="mc-header__info">
          <span class="mc-header__name">
            {note.callback_phone ? formatPhone(note.callback_phone) : "Unknown number"}
          </span>
          <span class="mc-header__phone">{relativeTimestamp(note.created_at)}</span>
        </div>
      </div>

      <div class="mc-messages">
        <div class="mc-bubble mc-bubble--inbound">
          <div class="mc-bubble__body">{note.raw_content || "No transcript."}</div>
          <div class="mc-bubble__meta">{formatDateTime(note.created_at)}</div>
        </div>
      </div>

      <div class="mc-unassigned-detail__actions">
        {callHref ? (
          <a class="btn btn--primary" href={callHref}>
            Call back
          </a>
        ) : (
          <span class="text--muted">No callback number</span>
        )}
        {unreviewed ? (
          <button
            type="button"
            class="btn btn--tertiary"
            onClick={() => onDismiss(note.id)}
          >
            Dismiss
          </button>
        ) : null}
      </div>
    </div>
  );
}
