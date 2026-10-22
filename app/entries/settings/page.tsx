import { Braces, Download, KeyRound, LockKeyhole, Play, Route, Rss, Save, SlidersHorizontal, Sparkles, Tags, Trash2, Upload } from "lucide-react";
import type { Metadata } from "next";
import Link from "next/link";

import { AccountSettings } from "@/components/account-settings";
import { CreateTokenForm } from "@/components/create-token-form";
import { TwoFactorSettings } from "@/components/two-factor-settings";
import { deleteIgnoreOriginRule, deleteSiteCredential, deleteTag, deleteTaggingRule, importTaggingRules, renameTag, resetTaggingRules, revokeApiToken, revokeFeedToken, rotateFeedToken, runTaggingRules, saveIgnoreOriginRule, saveSiteCredential, saveTaggingRule, updateFeedLimit, updateIgnoreOriginRule, updatePreferences, updateTaggingRule } from "@/lib/actions";
import { requireUser } from "@/lib/auth-user";
import { db } from "@/lib/db";
import { isCredentialEncryptionConfigured } from "@/lib/secret-box";
import { isTwoFactorEmailConfigured, isTwoFactorEncryptionConfigured, isTwoFactorMethod } from "@/lib/two-factor";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const user = await requireUser();
  const [preference, tokens, profile, siteCredentials, taggingRules, libraryTags, ignoreOriginRules, trustedDeviceCount, recoveryCodeCount] = await Promise.all([
    db.userPreference.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} }),
    db.apiToken.findMany({ where: { userId: user.id }, orderBy: { createdAt: "desc" } }),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, username: true, email: true, twoFactorMethod: true } }),
    db.siteCredential.findMany({ where: { userId: user.id }, orderBy: { host: "asc" } }),
    db.taggingRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.tag.findMany({ where: { userId: user.id }, include: { _count: { select: { entries: true } } }, orderBy: { label: "asc" } }),
    db.ignoreOriginRule.findMany({ where: { userId: user.id }, orderBy: { createdAt: "asc" } }),
    db.trustedDevice.count({ where: { userId: user.id, expiresAt: { gt: new Date() } } }),
    db.recoveryCode.count({ where: { userId: user.id } }),
  ]);
  const credentialEncryptionReady = isCredentialEncryptionConfigured();
  const twoFactorMethod = isTwoFactorMethod(profile.twoFactorMethod) ? profile.twoFactorMethod : "NONE";

  return (
    <div className="settings-page">
      <header className="settings-header"><p className="eyebrow">Personalize Wallaby</p><h1>Settings</h1><p>Make your library feel like your own reading room.</p></header>
      <AccountSettings profile={profile} />
      <TwoFactorSettings method={twoFactorMethod} email={profile.email} encryptionReady={isTwoFactorEncryptionConfigured()} emailReady={isTwoFactorEmailConfigured()} recoveryCodeCount={recoveryCodeCount} trustedDeviceCount={trustedDeviceCount} />
      <section className="settings-section">
        <div className="settings-label"><SlidersHorizontal size={18} /><div><h2>Reading & library</h2><p>Pagination, language, and reader typography.</p></div></div>
        <form action={updatePreferences} className="settings-form">
          <label><span>Entries per page</span><input type="number" name="itemsPerPage" min="5" max="100" defaultValue={preference.itemsPerPage} /></label>
          <label><span>Reading speed (words/min)</span><input type="number" name="readingSpeed" min="50" max="1000" defaultValue={preference.readingSpeed} /></label>
          <label><span>Language</span><input name="language" defaultValue={preference.language} /></label>
          <label><span>Colour theme</span><select name="theme" defaultValue={preference.theme}><option value="auto">Match system</option><option value="light">Light</option><option value="dark">Dark</option></select></label>
          <label><span>Reader typeface</span><select name="font" defaultValue={preference.font}><option value="serif">Serif</option><option value="sans">Sans serif</option></select></label>
          <label><span>Text size</span><input type="number" name="fontSize" min="0.75" max="2" step="0.05" defaultValue={preference.fontSize} /></label>
          <label><span>Line height</span><input type="number" name="lineHeight" min="1.2" max="2.5" step="0.05" defaultValue={preference.lineHeight} /></label>
          <label><span>Reader width (px)</span><input type="number" name="maxWidth" min="480" max="1400" defaultValue={preference.maxWidth} /></label>
          <label><span>After archiving an entry</span><select name="afterArchive" defaultValue={preference.afterArchive}><option value="stay">Stay on it</option><option value="next">Open the next entry in the list</option><option value="list">Return to the list</option></select></label>
          <label className="settings-toggle"><input type="checkbox" name="actionMarkAsRead" value="1" defaultChecked={preference.actionMarkAsRead} /><span>Archive entries when I finish reading them</span></label>
          <label className="settings-toggle"><input type="checkbox" name="listMode" value="1" defaultChecked={preference.listMode} /><span>Use compact list cards</span></label>
          <label className="settings-toggle"><input type="checkbox" name="displayThumbnails" value="1" defaultChecked={preference.displayThumbnails} /><span>Display article thumbnails</span></label>
          <label className="custom-css-field"><span>Custom article CSS declarations</span><textarea name="customCss" rows={4} defaultValue={preference.customCss ?? ""} placeholder="letter-spacing: .01em; text-align: justify;" /></label>
          <button className="primary-button">Save preferences</button>
        </form>
      </section>
      <section className="settings-section">
        <div className="settings-label"><Route size={18} /><div><h2>Redirect origins</h2><p>Choose redirect sources that should not be retained as article origins.</p></div></div>
        <div className="settings-content">
          <form action={saveIgnoreOriginRule} className="rule-form origin-rule-form">
            <input name="rule" required maxLength={255} placeholder={'host = "rss.example.com"'} aria-label="Ignore-origin rule" />
            <button className="primary-button">Add rule</button>
          </form>
          <p className="rule-help">Variables: host and _all (the complete original URL). Operators: = for equality and ~ for a safe case-insensitive regular expression.</p>
          <div className="rule-list origin-rule-list">
            {ignoreOriginRules.map((rule) => <article key={rule.id}>
              <div className="rule-summary"><code>{rule.rule}</code></div>
              <details><summary>Edit</summary><form action={updateIgnoreOriginRule.bind(null, rule.id)} className="rule-edit-form">
                <input name="rule" required maxLength={255} defaultValue={rule.rule} aria-label={`Ignore-origin expression ${rule.rule}`} />
                <button className="secondary-button"><Save size={13} /> Update</button>
              </form></details>
              <form action={deleteIgnoreOriginRule.bind(null, rule.id)}><button aria-label={`Delete ignore-origin rule ${rule.rule}`}><Trash2 size={14} /></button></form>
            </article>)}
            {!ignoreOriginRules.length ? <p className="muted">No personal redirect-origin rules.</p> : null}
          </div>
        </div>
      </section>
      <section className="settings-section" id="tags">
        <div className="settings-label"><Tags size={18} /><div><h2>Tags</h2><p>Rename, merge, or remove library-wide labels.</p></div></div>
        <div className="settings-content tag-manager">
          <p className="rule-help">Renaming a tag to an existing label merges their entries without duplicates.</p>
          {libraryTags.map((tag) => <article key={tag.id}>
            <form action={renameTag.bind(null, tag.id)}><input name="label" defaultValue={tag.label} required aria-label={`Rename tag ${tag.label}`} /><span>{tag._count.entries} {tag._count.entries === 1 ? "entry" : "entries"}</span><button className="secondary-button"><Save size={13} /> Save</button></form>
            <form action={deleteTag.bind(null, tag.id)}><button className="text-danger" aria-label={`Delete tag ${tag.label}`}><Trash2 size={14} /></button></form>
          </article>)}
          {!libraryTags.length ? <p className="muted">No tags yet.</p> : null}
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label"><Sparkles size={18} /><div><h2>Automatic tags</h2><p>wallabag-compatible rules run whenever an entry is saved.</p></div></div>
        <div className="settings-content">
          <form action={saveTaggingRule} className="rule-form">
            <input name="rule" required placeholder={'readingTime <= 5 AND language = "en"'} aria-label="Tagging rule" />
            <input name="tags" required placeholder="short read, english" aria-label="Tags to apply" />
            <button className="primary-button">Add rule</button>
          </form>
          <p className="rule-help">Variables: title, url, isArchived, isStarred, content, language, mimetype, readingTime, domainName. Operators: =, is, !=, &lt;, &lt;=, &gt;, &gt;=, matches, notmatches, NOT, AND, OR.</p>
          <div className="rule-list">
            {taggingRules.map((rule) => {
              const tags = Array.isArray(rule.tags) ? rule.tags.filter((value): value is string => typeof value === "string") : [];
              return <article key={rule.id}>
                <div className="rule-summary"><code>{rule.rule}</code><span>→ {tags.map((tag) => `#${tag}`).join(" ")}</span></div>
                <details><summary>Edit</summary><form action={updateTaggingRule.bind(null, rule.id)} className="rule-edit-form">
                  <input name="rule" required defaultValue={rule.rule} aria-label={`Rule expression ${rule.rule}`} />
                  <input name="tags" required defaultValue={tags.join(", ")} aria-label={`Rule tags ${rule.rule}`} />
                  <button className="secondary-button"><Save size={13} /> Update</button>
                </form></details>
                <form action={deleteTaggingRule.bind(null, rule.id)}><button aria-label={`Delete rule ${rule.rule}`}><Trash2 size={14} /></button></form>
              </article>;
            })}
          </div>
          <div className="rule-actions">
            <form action={runTaggingRules}><button className="secondary-button"><Play size={13} /> Apply all rules to existing entries</button></form>
            <a className="secondary-button" href="/api/taggingrule/export.json"><Download size={13} /> Export rules</a>
            <form action={importTaggingRules} className="rule-import"><label><Upload size={13} /><span>Import JSON</span><input name="file" type="file" accept="application/json,.json" required /></label><button className="secondary-button">Import</button></form>
            <form action={resetTaggingRules}><button className="text-danger" disabled={!taggingRules.length}><Trash2 size={13} /> Delete all rules</button></form>
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label"><Rss size={18} /><div><h2>Private feed</h2><p>A revocable token for feed-reader access.</p></div></div>
        <div className="settings-content">
          {preference.feedToken ? <code className="feed-code">/feed/{profile.username}/{preference.feedToken}/unread</code> : <p className="muted">No feed token has been created.</p>}
          {preference.feedToken ? <div className="feed-links"><a href={`/feed/${profile.username}/${preference.feedToken}/unread`}>Unread Atom</a><a href={`/feed/${profile.username}/${preference.feedToken}/starred`}>Starred Atom</a><a href={`/feed/${profile.username}/${preference.feedToken}/archive`}>Archive Atom</a><a href={`/feed/${profile.username}/${preference.feedToken}/all?format=rss`}>All RSS</a></div> : null}
          <form action={updateFeedLimit} className="feed-limit"><label><span>Entries per feed page</span><input type="number" name="feedLimit" min="1" max="1000" defaultValue={preference.feedLimit} /></label><button className="secondary-button">Save feed limit</button></form>
          <div className="inline-actions"><form action={rotateFeedToken}><button className="secondary-button">{preference.feedToken ? "Rotate token" : "Create token"}</button></form>{preference.feedToken ? <form action={revokeFeedToken}><button className="text-danger">Revoke</button></form> : null}</div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label"><Braces size={18} /><div><h2>API access</h2><p>Bearer tokens for clients using the wallabag-shaped API.</p></div></div>
        <div className="settings-content">
          <p className="rule-help">Need OAuth2 authorization-code or refresh-token credentials? <Link href="/entries/developer">Manage developer clients</Link>.</p>
          <p className="rule-help">Using Chrome or Firefox? <a href="https://github.com/huangyingting/Wallaby/tree/main/extensions" target="_blank" rel="noreferrer">Install the Wallaby browser companion</a> and create a dedicated token below to connect it.</p>
          <CreateTokenForm />
          <div className="token-list">
            {tokens.map((token) => <div key={token.id}><KeyRound size={15} /><span><strong>{token.name}</strong><small>Created {token.createdAt.toLocaleDateString()} · {token.lastUsedAt ? `last used ${token.lastUsedAt.toLocaleDateString()}` : "never used"}</small></span><form action={revokeApiToken.bind(null, token.id)}><button aria-label={`Revoke ${token.name}`}><Trash2 size={15} /></button></form></div>)}
            {!tokens.length ? <p className="muted">No API tokens yet.</p> : null}
          </div>
        </div>
      </section>
      <section className="settings-section">
        <div className="settings-label"><LockKeyhole size={18} /><div><h2>Site credentials</h2><p>Encrypted logins for publications supported by the extraction site configs.</p></div></div>
        <div className="settings-content">
          {!credentialEncryptionReady ? <p className="settings-warning">Set a valid 32-byte `SITE_CREDENTIALS_KEY` before storing site logins.</p> : (
            <form action={saveSiteCredential} className="credential-form">
              <input name="host" required placeholder="publication.example" aria-label="Site hostname" />
              <input name="username" required autoComplete="off" placeholder="Username" aria-label="Site username" />
              <input name="password" required type="password" autoComplete="new-password" placeholder="Password" aria-label="Site password" />
              <button className="primary-button">Save encrypted login</button>
            </form>
          )}
          <div className="token-list credential-list">
            {siteCredentials.map((credential) => <div key={credential.id}><LockKeyhole size={15} /><span><strong>{credential.host}</strong><small>Encrypted with AES-256-GCM · updated {credential.updatedAt.toLocaleDateString()}</small></span><form action={deleteSiteCredential.bind(null, credential.id)}><button aria-label={`Delete login for ${credential.host}`}><Trash2 size={15} /></button></form></div>)}
            {!siteCredentials.length ? <p className="muted">No site credentials stored.</p> : null}
          </div>
        </div>
      </section>
    </div>
  );
}
