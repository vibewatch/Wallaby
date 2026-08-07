"use client";

type Props = {
  action: (formData: FormData) => void | Promise<void>;
  confirm: string;
  children: React.ReactNode;
  className?: string;
};

/**
 * A server-action form that asks before it runs. Used for changes no undo can
 * reverse — deleting an entry also removes its cached article images. Without
 * JavaScript the confirmation is skipped rather than the action being blocked,
 * so the form keeps working.
 */
export function ConfirmForm({ action, confirm, children, className }: Props) {
  return (
    <form
      action={action}
      className={className}
      onSubmit={(event) => { if (!window.confirm(confirm)) event.preventDefault(); }}
    >
      {children}
    </form>
  );
}
