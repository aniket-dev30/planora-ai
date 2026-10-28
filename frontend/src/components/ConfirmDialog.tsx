import { useEffect, useId, useRef } from 'react';

type Props = {
  title: string;
  description: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
};

/**
 * Modal confirmation built on the native <dialog>: focus is trapped, Escape cancels, background is
 * inert, and focus returns to the opener when it closes. Render it only while a confirmation is pending.
 */
export function ConfirmDialog({ title, description, confirmLabel, onConfirm, onCancel }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return undefined;
    if (!dialog.open) dialog.showModal();
    return () => {
      if (dialog.open) dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => { event.preventDefault(); onCancel(); }}
      onClick={(event) => { if (event.target === ref.current) onCancel(); }}
    >
      <h3 id={titleId}>{title}</h3>
      <p id={descriptionId}>{description}</p>
      <div className="confirm-actions">
        <button type="button" className="ghost-btn" autoFocus onClick={onCancel}>Cancel</button>
        <button type="button" className="primary-btn danger-solid" onClick={onConfirm}>{confirmLabel}</button>
      </div>
    </dialog>
  );
}
