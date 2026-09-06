"use client";

import { useActionState, useEffect } from "react";

import { ConfirmForm } from "@/components/confirm-form";
import { useToast } from "@/components/toast";
import type { ActionResult } from "@/lib/toast";

type Props = {
  /**
   * A server action in `useActionState` shape. Actions that ignore the form
   * body — a bound `toggleStarred(entryId)`, say — may declare fewer
   * parameters; the extra arguments are simply unused.
   */
  action: (state: ActionResult, formData: FormData) => Promise<ActionResult>;
  children: React.ReactNode;
  className?: string;
  id?: string;
  confirmation?: { field: string; value: string; message: string };
};

/**
 * A server-action form that reports its outcome as a toast. `useActionState`
 * keeps the plain form submission working without JavaScript while giving the
 * client the result to announce once it is available.
 */
export function ActionForm({ action, children, className, id, confirmation }: Props) {
  const [state, formAction] = useActionState(action, null);
  const toast = useToast();

  useEffect(() => {
    if (state) toast(state);
  }, [state, toast]);

  return confirmation
    ? <ConfirmForm action={formAction} className={className} id={id} confirm={confirmation.message} confirmWhen={confirmation}>{children}</ConfirmForm>
    : <form action={formAction} className={className} id={id}>{children}</form>;
}
