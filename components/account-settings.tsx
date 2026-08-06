"use client";

import { useActionState } from "react";

import { changePassword, deleteAccount, resetAccountData, updateProfile } from "@/lib/actions";

type Profile = { name: string | null; username: string; email: string | null };

export function AccountSettings({ profile }: { profile: Profile }) {
  const [profileState, profileAction, profilePending] = useActionState(updateProfile, {});
  const [passwordState, passwordAction, passwordPending] = useActionState(changePassword, {});
  const [resetState, resetAction, resetPending] = useActionState(resetAccountData, {});
  const [deleteState, deleteAction, deletePending] = useActionState(deleteAccount, {});

  return (
    <>
      <section className="settings-section">
        <div className="settings-label"><span className="settings-glyph" aria-hidden="true">Aa</span><div><h2>Profile</h2><p>Update the identity used by the app, feeds, and sign-in.</p></div></div>
        <form action={profileAction} className="settings-form account-form">
          <label><span>Display name</span><input name="name" required maxLength={100} defaultValue={profile.name ?? profile.username} autoComplete="name" /></label>
          <label><span>Username</span><input name="username" required minLength={3} maxLength={50} pattern="[a-z0-9][a-z0-9._-]{2,49}" defaultValue={profile.username} autoComplete="username" /></label>
          <label><span>Email</span><input name="email" required type="email" maxLength={320} defaultValue={profile.email ?? ""} autoComplete="email" /></label>
          <label><span>Current password</span><input name="currentPassword" required type="password" maxLength={200} autoComplete="current-password" /></label>
          <AccountStatus state={profileState} />
          <button className="primary-button" disabled={profilePending}>{profilePending ? "Saving…" : "Save profile"}</button>
        </form>
      </section>
      <section className="settings-section">
        <div className="settings-label"><span className="settings-glyph" aria-hidden="true">••</span><div><h2>Password</h2><p>Changing it signs out every browser session.</p></div></div>
        <form action={passwordAction} className="settings-form account-form">
          <label><span>Current password</span><input name="currentPassword" required type="password" maxLength={200} autoComplete="current-password" /></label>
          <label><span>New password</span><input name="newPassword" required type="password" minLength={8} maxLength={200} autoComplete="new-password" /></label>
          <label><span>Confirm new password</span><input name="confirmPassword" required type="password" minLength={8} maxLength={200} autoComplete="new-password" /></label>
          <AccountStatus state={passwordState} />
          <button className="primary-button" disabled={passwordPending}>{passwordPending ? "Updating…" : "Change password"}</button>
        </form>
      </section>
      <section className="settings-section danger-section">
        <div className="settings-label"><span className="settings-glyph danger" aria-hidden="true">!</span><div><h2>Reset or delete</h2><p>These operations permanently remove selected data.</p></div></div>
        <div className="settings-content danger-zone">
          <form action={resetAction} className="danger-form">
            <label><span>Reset scope</span><select name="scope" defaultValue="annotations"><option value="annotations">Annotations</option><option value="tags">Tags</option><option value="archived">Archived entries</option><option value="tagging-rules">Tagging rules</option><option value="entries">All entries</option></select></label>
            <label><span>Current password</span><input name="currentPassword" required type="password" maxLength={200} autoComplete="current-password" /></label>
            <AccountStatus state={resetState} />
            <button className="text-danger danger-button" disabled={resetPending}>{resetPending ? "Resetting…" : "Reset selected data"}</button>
          </form>
          <form action={deleteAction} className="danger-form delete-account-form">
            <p>Delete the account and every related entry, token, rule, import, and preference.</p>
            <label><span>Type username to confirm</span><input name="username" required autoComplete="off" /></label>
            <label><span>Current password</span><input name="currentPassword" required type="password" maxLength={200} autoComplete="current-password" /></label>
            <AccountStatus state={deleteState} />
            <button className="text-danger danger-button" disabled={deletePending}>{deletePending ? "Deleting…" : "Delete account"}</button>
          </form>
        </div>
      </section>
    </>
  );
}

function AccountStatus({ state }: { state: { error?: string; message?: string } }) {
  if (state.error) return <p className="account-status error" role="alert">{state.error}</p>;
  if (state.message) return <p className="account-status success" role="status">{state.message}</p>;
  return null;
}
