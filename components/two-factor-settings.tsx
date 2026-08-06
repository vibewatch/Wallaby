"use client";

import { useActionState } from "react";
import Image from "next/image";

import { beginEmailTwoFactorSetup, beginTotpTwoFactorSetup, confirmEmailTwoFactorSetup, confirmTotpTwoFactorSetup, disableTwoFactorAuthentication, regenerateTwoFactorRecoveryCodes, revokeTwoFactorTrustedDevices, type TwoFactorActionState } from "@/lib/actions";
import type { TwoFactorMethod } from "@/lib/two-factor";

type Props = {
  method: TwoFactorMethod;
  email: string | null;
  encryptionReady: boolean;
  emailReady: boolean;
  recoveryCodeCount: number;
  trustedDeviceCount: number;
};

const initialState: TwoFactorActionState = {};

export function TwoFactorSettings({ method, email, encryptionReady, emailReady, recoveryCodeCount, trustedDeviceCount }: Props) {
  const [totpState, beginTotp, beginningTotp] = useActionState(beginTotpTwoFactorSetup, initialState);
  const [totpConfirmState, confirmTotp, confirmingTotp] = useActionState(confirmTotpTwoFactorSetup, initialState);
  const [emailState, beginEmail, beginningEmail] = useActionState(beginEmailTwoFactorSetup, initialState);
  const [emailConfirmState, confirmEmail, confirmingEmail] = useActionState(confirmEmailTwoFactorSetup, initialState);
  const [disableState, disable, disabling] = useActionState(disableTwoFactorAuthentication, initialState);
  const [recoveryState, regenerate, regenerating] = useActionState(regenerateTwoFactorRecoveryCodes, initialState);

  return (
    <section className="settings-section two-factor-section">
      <div className="settings-label"><span className="settings-glyph" aria-hidden="true">2×</span><div><h2>Two-factor authentication</h2><p>Require a second, short-lived code after your password.</p></div></div>
      <div className="settings-content two-factor-settings">
        <p className={`two-factor-status ${method === "NONE" ? "inactive" : "active"}`}>
          {method === "TOTP" ? `Authenticator app enabled · ${recoveryCodeCount} unused recovery codes` : method === "EMAIL" ? `Email codes enabled for ${email ?? "your account"}` : "Two-factor authentication is disabled."}
        </p>

        <details className="two-factor-method" open={method === "NONE"}>
          <summary>{method === "TOTP" ? "Replace authenticator app" : "Use an authenticator app"}</summary>
          {!encryptionReady ? <p className="settings-warning">Set `TWO_FACTOR_KEY` or a strong `AUTH_SECRET` before configuring authenticator codes.</p> : (
            <form action={beginTotp} className="compact-security-form">
              <label><span>Current password</span><input name="currentPassword" required type="password" autoComplete="current-password" /></label>
              <button className="secondary-button" disabled={beginningTotp}>{beginningTotp ? "Preparing…" : "Start authenticator setup"}</button>
            </form>
          )}
          <ActionStatus state={totpState} />
          {totpState.secret && totpState.qrCodeDataUrl && totpState.recoveryCodes ? (
            <div className="totp-setup" aria-label="Authenticator setup">
              <div className="totp-enrollment">
                <Image src={totpState.qrCodeDataUrl} alt="QR code for authenticator enrollment" width={220} height={220} unoptimized />
                <div><p>Can’t scan the code? Enter this secret manually:</p><code className="totp-secret">{totpState.secret}</code><a href={totpState.provisioningUri}>Open in an authenticator app</a></div>
              </div>
              <RecoveryCodeList codes={totpState.recoveryCodes} />
              <form action={confirmTotp} className="compact-security-form totp-confirm-form">
                <label><span>Current six-digit code</span><input name="code" required inputMode="numeric" autoComplete="one-time-code" minLength={6} maxLength={8} /></label>
                <button className="primary-button" disabled={confirmingTotp}>{confirmingTotp ? "Confirming…" : "Enable authenticator codes"}</button>
              </form>
              <ActionStatus state={totpConfirmState} />
            </div>
          ) : null}
        </details>

        <details className="two-factor-method">
          <summary>{method === "EMAIL" ? "Reconfigure email codes" : "Use codes sent by email"}</summary>
          {!emailReady ? <p className="settings-warning">Email codes require the instance SMTP settings documented in `.env.example`.</p> : !email ? <p className="settings-warning">Add an email address to your profile first.</p> : (
            <form action={beginEmail} className="compact-security-form">
              <label><span>Current password</span><input name="currentPassword" required type="password" autoComplete="current-password" /></label>
              <button className="secondary-button" disabled={beginningEmail}>{beginningEmail ? "Sending…" : "Send verification code"}</button>
            </form>
          )}
          <ActionStatus state={emailState} />
          {emailState.awaitingEmailCode ? (
            <form action={confirmEmail} className="compact-security-form">
              <label><span>Email verification code</span><input name="code" required inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} /></label>
              <button className="primary-button" disabled={confirmingEmail}>{confirmingEmail ? "Confirming…" : "Enable email codes"}</button>
              <ActionStatus state={emailConfirmState} />
            </form>
          ) : null}
        </details>

        {method === "TOTP" ? (
          <details className="two-factor-method">
            <summary>Replace recovery codes</summary>
            <p>Generating a replacement list immediately revokes every previous recovery code.</p>
            <form action={regenerate} className="compact-security-form">
              <label><span>Current password</span><input name="currentPassword" required type="password" autoComplete="current-password" /></label>
              <button className="secondary-button" disabled={regenerating}>{regenerating ? "Generating…" : "Generate replacement codes"}</button>
            </form>
            <ActionStatus state={recoveryState} />
            {recoveryState.recoveryCodes ? <RecoveryCodeList codes={recoveryState.recoveryCodes} /> : null}
          </details>
        ) : null}

        {method !== "NONE" ? (
          <div className="two-factor-management">
            <form action={revokeTwoFactorTrustedDevices}><button className="secondary-button" disabled={!trustedDeviceCount}>Revoke trusted devices ({trustedDeviceCount})</button></form>
            <form action={disable} className="compact-security-form disable-two-factor-form">
              <label><span>Current password</span><input name="currentPassword" required type="password" autoComplete="current-password" /></label>
              <button className="text-danger danger-button" disabled={disabling}>{disabling ? "Disabling…" : "Disable two-factor authentication"}</button>
              <ActionStatus state={disableState} />
            </form>
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RecoveryCodeList({ codes }: { codes: string[] }) {
  return <div className="recovery-code-panel"><strong>Save these single-use recovery codes now</strong><p>They will not be shown again. Each code replaces one authenticator code.</p><pre>{codes.join("\n")}</pre></div>;
}

function ActionStatus({ state }: { state: TwoFactorActionState }) {
  if (state.error) return <p className="account-status error" role="alert">{state.error}</p>;
  if (state.message) return <p className="account-status success" role="status">{state.message}</p>;
  return null;
}
