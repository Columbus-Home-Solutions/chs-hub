import { formatPhone } from "../../lib/format";
import {
  telHref,
  type UnassignedVoiceNote,
} from "@chs/shared/message-center-unassigned";
import { relativeTimestamp, truncate } from "./helpers";

export function UnassignedList({
  notes,
  dismissedIds,
  onDismiss,
  onSelect,
  selectedId,
  selectable = false,
}: {
  notes: UnassignedVoiceNote[];
  dismissedIds: Set<string>;
  onDismiss: (id: string) => void;
  onSelect?: (note: UnassignedVoiceNote) => void;
  selectedId?: string | null;
  /** Page: row click selects for the detail pane. Panel: inline Call back + Dismiss. */
  selectable?: boolean;
}) {
  if (notes.length === 0) {
    return (
      <div class="mc-conv-list">
        <div class="mc-conv-list__empty">No unassigned missed-call logs.</div>
      </div>
    );
  }

  return (
    <div class="mc-conv-list">
      {notes.map((note) => {
        const unreviewed = !dismissedIds.has(note.id);
        const callHref = telHref(note.callback_phone);
        const selected = selectedId === note.id;
        const rowClass = `mc-unassigned-row${unreviewed ? " mc-unassigned-row--unreviewed" : ""}${selected ? " mc-unassigned-row--selected" : ""}`;

        if (selectable) {
          return (
            <button
              key={note.id}
              type="button"
              class={rowClass}
              onClick={() => onSelect?.(note)}
            >
              <div class="mc-conv-row__top">
                <span class="mc-conv-row__name">
                  {note.callback_phone ? formatPhone(note.callback_phone) : "Unknown number"}
                </span>
                <span class="mc-conv-row__time">{relativeTimestamp(note.created_at)}</span>
              </div>
              <div class="mc-conv-row__preview">{truncate(note.raw_content, 80)}</div>
            </button>
          );
        }

        return (
          <div
            key={note.id}
            class={rowClass}
          >
            <div class="mc-conv-row__top">
              <span class="mc-conv-row__name">
                {note.callback_phone ? formatPhone(note.callback_phone) : "Unknown number"}
              </span>
              <span class="mc-conv-row__time">{relativeTimestamp(note.created_at)}</span>
            </div>
            <div class="mc-conv-row__preview">{truncate(note.raw_content, 80)}</div>
            <div class="mc-unassigned-row__actions">
              {callHref ? (
                <a class="btn btn--primary btn--sm" href={callHref}>
                  Call back
                </a>
              ) : null}
              {unreviewed ? (
                <button
                  type="button"
                  class="btn btn--tertiary btn--sm"
                  onClick={() => onDismiss(note.id)}
                >
                  Dismiss
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
