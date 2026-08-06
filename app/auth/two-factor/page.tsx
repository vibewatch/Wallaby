import { BookOpenText } from "lucide-react";
import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { TwoFactorChallengeForm } from "@/components/two-factor-challenge-form";
import { getLoginChallenge, TWO_FACTOR_CHALLENGE_COOKIE } from "@/lib/two-factor";

export const metadata: Metadata = { title: "Two-factor sign in" };

export default async function TwoFactorPage() {
  const token = (await cookies()).get(TWO_FACTOR_CHALLENGE_COOKIE)?.value;
  const challenge = await getLoginChallenge(token);
  if (!challenge) redirect("/auth/signin");
  return (
    <main className="signin-page">
      <section className="signin-story" aria-label="About Wallaby">
        <div className="brand-mark light-mark"><BookOpenText size={22} strokeWidth={1.8} /></div>
        <p className="eyebrow light-eyebrow">One more proof</p>
        <h1>Protect what<br />you keep.</h1>
        <p className="signin-intro">Your password was accepted. Complete the second step to open your private reading library.</p>
      </section>
      <section className="signin-panel">
        <div className="signin-box">
          <p className="eyebrow">Two-factor authentication</p>
          <h2>Enter your security code</h2>
          <p className="muted">{challenge.method === "EMAIL" ? `We sent a six-digit code to ${challenge.destination ?? "your email address"}.` : "Use a current authenticator code or one unused recovery code."}</p>
          <TwoFactorChallengeForm method={challenge.method} />
        </div>
        <p className="privacy-note">Short-lived challenge · Single-use codes · No tracking</p>
      </section>
    </main>
  );
}
