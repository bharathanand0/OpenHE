import { createContext, useContext, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check, Loader2, Save, Undo2 } from 'lucide-react';

/** The topbar element pages render their save controls into. */
export const SaveSlotContext = createContext<HTMLElement | null>(null);

/**
 * Discard and Save, shown in the topbar like OpenAula's save button.
 * Ctrl/Cmd+S saves while there is something to save.
 */
export function SaveBar({
  dirty,
  busy,
  canSave = true,
  saved = false,
  title,
  onSave,
  onDiscard
}: {
  dirty: boolean;
  busy: boolean;
  canSave?: boolean;
  /** Show the "Saved" state (just written, nothing pending). */
  saved?: boolean;
  /** Why saving is not possible, shown on hover. */
  title?: string;
  onSave: () => void;
  onDiscard: () => void;
}) {
  const slot = useContext(SaveSlotContext);
  const save = useRef(onSave);
  save.current = onSave;
  const enabled = dirty && !busy && canSave;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        save.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled]);

  const state = busy
    ? 'is-saving'
    : enabled
      ? 'is-can-save'
      : saved && !dirty
        ? 'is-saved'
        : 'is-idle';
  const controls = (
    <>
      <button
        type="button"
        className="ghost-button drv-discard"
        disabled={!dirty || busy}
        onClick={onDiscard}
      >
        <Undo2 size={15} /> Discard
      </button>
      <button
        type="button"
        className={`woot-save-btn apply-button ${state}`}
        disabled={!enabled}
        title={title ?? 'Ctrl+S'}
        onClick={onSave}
      >
        {busy ? (
          <>
            <Loader2 size={15} className="drv-spin" /> Saving…
          </>
        ) : saved && !dirty ? (
          <>
            <Check size={15} /> Saved
          </>
        ) : (
          <>
            <Save size={15} /> Save to keyboard
          </>
        )}
      </button>
    </>
  );
  return slot ? createPortal(controls, slot) : <div className="drv-actions">{controls}</div>;
}
