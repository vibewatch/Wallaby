import { ImageDown, Save, Shield, Trash2, UserPlus } from "lucide-react";
import type { Metadata } from "next";

import { createInstanceOriginRule, createManagedUser, deleteInstanceOriginRule, deleteManagedUser, resetManagedUserPassword, updateImageDownloadSettings, updateInstanceOriginRule, updateManagedUser } from "@/lib/actions";
import { getImageDownloadConfiguration } from "@/lib/article-images";
import { requireAdmin } from "@/lib/auth-user";
import { db } from "@/lib/db";

export const metadata: Metadata = { title: "Administration" };

export default async function AdminPage() {
  const admin = await requireAdmin();
  const [users, instanceRules, imageConfiguration] = await Promise.all([
    db.user.findMany({ include: { _count: { select: { entries: true, annotations: true, apiTokens: true } } }, orderBy: { createdAt: "asc" } }),
    db.ignoreOriginInstanceRule.findMany({ orderBy: { createdAt: "asc" } }),
    getImageDownloadConfiguration(),
  ]);
  return (
    <div className="settings-page admin-page">
      <header className="settings-header"><p className="eyebrow">Instance controls</p><h1>Administration</h1><p>Manage local accounts, roles, access, and redirect-origin policy.</p></header>
      <section className="portability-card">
        <div className="portability-title"><ImageDown size={20} /><div><h2>Offline article images</h2><p>Store safe local copies of remote raster images. A persistent media volume is required in production.</p></div></div>
        <form action={updateImageDownloadSettings} className="settings-form image-settings-form">
          <label className="settings-toggle"><input name="downloadImagesEnabled" type="checkbox" value="1" defaultChecked={imageConfiguration.downloadImagesEnabled} /><span>Download images when entries are saved or reloaded</span></label>
          <label><span>Images per entry</span><input name="imageMaxCount" type="number" min="1" max="100" defaultValue={imageConfiguration.imageMaxCount} /></label>
          <label><span>Maximum image size (MB)</span><input name="imageMaxMb" type="number" min="0.1" max="20" step="0.1" defaultValue={imageConfiguration.imageMaxBytes / 1_000_000} /></label>
          <label><span>Maximum per entry (MB)</span><input name="imageEntryMaxMb" type="number" min="1" max="200" step="1" defaultValue={imageConfiguration.imageEntryMaxBytes / 1_000_000} /></label>
          <label><span>Maximum per user (MB)</span><input name="imageUserMaxMb" type="number" min="10" max="2000" step="10" defaultValue={imageConfiguration.imageUserMaxBytes / 1_000_000} /></label>
          <button className="primary-button">Save image policy</button>
        </form>
      </section>
      <section className="portability-card">
        <div className="portability-title"><UserPlus size={20} /><div><h2>Create a user</h2><p>New accounts receive an isolated library and default preferences.</p></div></div>
        <form action={createManagedUser} className="admin-create-form">
          <input name="name" required maxLength={100} placeholder="Display name" aria-label="New user display name" />
          <input name="username" required minLength={3} maxLength={50} pattern="[a-z0-9][a-z0-9._-]{2,49}" placeholder="username" aria-label="New user username" />
          <input name="email" required type="email" maxLength={320} placeholder="reader@example.com" aria-label="New user email" />
          <input name="password" required type="password" minLength={8} maxLength={200} placeholder="Initial password" aria-label="New user password" autoComplete="new-password" />
          <select name="role" defaultValue="USER" aria-label="New user role"><option value="USER">Reader</option><option value="ADMIN">Administrator</option></select>
          <button className="primary-button">Create user</button>
        </form>
      </section>
      <section className="portability-card">
        <div className="portability-title"><Shield size={20} /><div><h2>Users</h2><p>{users.length} local {users.length === 1 ? "account" : "accounts"}; the final administrator is protected.</p></div></div>
        <div className="admin-user-list">
          {users.map((user) => <article key={user.id} data-user-id={user.id}>
            <form action={updateManagedUser.bind(null, user.id)} className="admin-user-form">
              <input name="name" required maxLength={100} defaultValue={user.name ?? user.username} aria-label={`Display name for ${user.username}`} />
              <input name="username" required minLength={3} maxLength={50} defaultValue={user.username} aria-label={`Username for ${user.username}`} />
              <input name="email" required type="email" maxLength={320} defaultValue={user.email ?? ""} aria-label={`Email for ${user.username}`} />
              <select key={user.role} name="role" defaultValue={user.role} aria-label={`Role for ${user.username}`}><option value="USER">Reader</option><option value="ADMIN">Administrator</option></select>
              <button className="secondary-button"><Save size={13} /> Save</button>
            </form>
            <p>{user._count.entries} entries · {user._count.annotations} annotations · {user._count.apiTokens} API tokens · joined {user.createdAt.toLocaleDateString()}</p>
            <div className="admin-user-actions">
              <details><summary>Reset password</summary><form action={resetManagedUserPassword.bind(null, user.id)}><input name="password" required type="password" minLength={8} maxLength={200} placeholder="New password" aria-label={`New password for ${user.username}`} /><button className="secondary-button">Reset</button></form></details>
              {user.id !== admin.id ? <form action={deleteManagedUser.bind(null, user.id)}><button className="text-danger" aria-label={`Delete user ${user.username}`}><Trash2 size={13} /> Delete</button></form> : <small>Current account</small>}
            </div>
          </article>)}
        </div>
      </section>
      <section className="portability-card">
        <div className="portability-title"><Shield size={20} /><div><h2>Instance redirect origins</h2><p>These safe rules apply before every user’s personal rules.</p></div></div>
        <form action={createInstanceOriginRule} className="rule-form origin-rule-form">
          <input name="rule" required maxLength={255} placeholder={'host = "feed.example.com"'} aria-label="Instance ignore-origin rule" />
          <button className="primary-button">Add instance rule</button>
        </form>
        <p className="rule-help">Variables: host and _all. Operators: = and safe case-insensitive ~ regular expressions.</p>
        <div className="rule-list admin-origin-rule-list">
          {instanceRules.map((rule) => <article key={rule.id}>
            <form action={updateInstanceOriginRule.bind(null, rule.id)} className="admin-rule-form">
              <input name="rule" required maxLength={255} defaultValue={rule.rule} aria-label={`Instance rule ${rule.rule}`} />
              <button className="secondary-button"><Save size={13} /> Save</button>
            </form>
            <form action={deleteInstanceOriginRule.bind(null, rule.id)}><button aria-label={`Delete instance rule ${rule.rule}`}><Trash2 size={14} /></button></form>
          </article>)}
          {!instanceRules.length ? <p className="muted">No instance rules are configured.</p> : null}
        </div>
      </section>
    </div>
  );
}
