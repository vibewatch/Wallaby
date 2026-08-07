"use client";

import { RotateCcw, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, useTransition } from "react";

import { undoAction } from "@/lib/actions";
import type { ActionResult, ToastTone, UndoToken } from "@/lib/toast";

type Toast = { id: number; message: string; tone: ToastTone; undo?: UndoToken };

/** Undoable toasts linger; plain confirmations get out of the way sooner. */
const DISMISS_MS = 5_000;
const DISMISS_WITH_UNDO_MS = 9_000;

const ToastContext = createContext<(result: ActionResult) => void>(() => {});

/** Push a toast from any client component below the provider. */
export function useToast() {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(0);

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const push = useCallback((result: ActionResult) => {
    if (!result?.message) return;
    const id = nextId.current++;
    // Only one toast at a time: rapid archiving should not build a stack that
    // covers the library.
    setToasts([{ id, message: result.message, tone: result.tone ?? "info", undo: result.undo }]);
  }, []);

  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toast-viewport" role="region" aria-label="Notifications">
        {toasts.map((toast) => <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} onPush={push} />)}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss, onPush }: {
  toast: Toast;
  onDismiss: (id: number) => void;
  onPush: (result: ActionResult) => void;
}) {
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    const timer = setTimeout(() => onDismiss(toast.id), toast.undo ? DISMISS_WITH_UNDO_MS : DISMISS_MS);
    return () => clearTimeout(timer);
  }, [onDismiss, toast.id, toast.undo]);

  function revert() {
    const token = toast.undo;
    if (!token) return;
    startTransition(async () => {
      const result = await undoAction(token);
      onPush(result);
    });
  }

  return (
    <output className={`toast toast-${toast.tone}`}>
      <span>{toast.message}</span>
      {toast.undo ? (
        <button type="button" className="toast-undo" onClick={revert} disabled={pending}>
          <RotateCcw size={13} /> {pending ? "Undoing…" : "Undo"}
        </button>
      ) : null}
      <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={() => onDismiss(toast.id)}><X size={13} /></button>
    </output>
  );
}
