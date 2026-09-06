"use client";

import { useId, useRef, useState } from "react";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  confirm: string;
  confirmWhen?: { field: string; value: string };
  children: React.ReactNode;
  className?: string;
  id?: string;
};

/**
 * Asks inline before irreversible actions, including cached-image deletion. Without
 * JavaScript the confirmation is skipped rather than the action being blocked,
 * so the form keeps working.
 */
export function ConfirmForm({ action, confirm, confirmWhen, children, className, id }: Props) {
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const descriptionId = useId();

  return (
    <form
      action={action}
      className={className}
      id={id}
      onChange={() => setConfirming(false)}
      onSubmit={(event) => {
        const needsConfirmation = !confirmWhen || new FormData(event.currentTarget).get(confirmWhen.field) === confirmWhen.value;
        const confirmed = confirming && event.nativeEvent instanceof SubmitEvent && event.nativeEvent.submitter === confirmButton.current;
        if (!needsConfirmation || confirmed) {
          setConfirming(false);
          return;
        }
        event.preventDefault();
        setConfirming(true);
      }}
    >
      {children}
      {confirming ? <div className="inline-confirmation" role="group" aria-labelledby={descriptionId}>
        <p id={descriptionId} role="alert">{confirm}</p>
        <div>
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
          <button type="submit" ref={confirmButton}>Confirm delete</button>
        </div>
      </div> : null}
    </form>
  );
}
