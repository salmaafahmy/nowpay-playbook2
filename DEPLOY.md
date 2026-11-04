# NowPay Knowledge Portal — public read + PIN-protected editing

Branch: `feature/supabase-auth-editor` (nothing here touches `main`).

## How it works now

| Who | What they can do |
|---|---|
| **Anyone** (no login) | See the full Knowledge Base immediately. Read-only access to `kb_data` through the publishable key. |
| **Someone who enters the PIN** | Use the Edit / Add buttons. The PIN is checked by the `kb-editor` Edge Function. A correct PIN gives a signed token valid for 30 minutes, kept in browser memory only. |

```
Browser ──read (publishable key, RLS: SELECT only)──────────────► kb_data
Browser ──POST verify {pin} / save {token, …}──► Edge Function ──secret key──► backup → write kb_data
```

* The PIN exists **only** as an Edge Function secret. It is not in any file in this repo.
* The Supabase secret / `service_role` key exists **only** inside the Edge Function environment (injected by Supabase).
* Every write: validated → previous content copied to `kb_data_backups` → new content written, in one database transaction.
* Editing can add and change content. It cannot delete rows, topics, sections or categories (the server refuses).

## Files in this branch

| File | Purpose |
|---|---|
| `index.html` | Same design/search/notifications/Excel. Now starts without any script, exposes hooks for the editor, supports custom categories, and HTML-escapes search highlighting. |
| `kb-admin.js` | Public loader, PIN prompt, inline Edit/Add buttons, forms, save through the Edge Function. |
| `kb-admin.css` | Styles for the above. |
| `supabase/migrations/20261103000000_public_read_pin_write.sql` | RLS (public read-only), backups table, rate-limit table, server-only functions. |
| `supabase/functions/kb-editor/` | The Edge Function (`index.ts`, `handler.ts`, `validate.ts`). |
| `supabase/config.toml` | `verify_jwt = false` for `kb-editor` (see step 3). |
| `supabase/tools/hash-pin.mjs` | Makes the hashed PIN secret so the PIN itself is never stored. |

## One-time setup

You need the [Supabase CLI](https://supabase.com/docs/guides/cli) logged in (`supabase login`) and linked to project `jubjcrwsmhfcnkxhhqkm`.

### 1. Back up, then apply the database migration

1. Dashboard → Table Editor → `kb_data` → export, or run `select * from kb_data;` and save the result. (Your data is not modified by the migration; this is just good practice.)
2. Apply the migration, either:
   * Dashboard → **SQL Editor** → paste `supabase/migrations/20261103000000_public_read_pin_write.sql` → Run, **or**
   * `supabase db push`

What it changes: it replaces the RLS **policies** on `kb_data` with a single "everyone can SELECT" policy and removes insert/update/delete privileges from `anon` and `authenticated`. It never deletes or rewrites rows. It is safe to run twice.

Check: `select count(*) from kb_data;` still returns your 18 groups.

### 2. Choose the PIN and store it as a secret

Use 4–8 digits. **6 digits is recommended** (a 4-digit PIN has only 10,000 combinations).

Recommended (the PIN is stored only as a salted hash):

```bash
node supabase/tools/hash-pin.mjs          # asks for the PIN (hidden), prints one line
supabase secrets set EDITOR_PIN_HASH='pbkdf2-sha256$210000$…$…'    # paste the printed line, keep the quotes
```

Simpler alternative (stored as a plain Supabase secret — never visible to the browser):

```bash
supabase secrets set EDITOR_PIN='123456'   # use your own PIN
```

If both are set, the hash wins. If neither is set, the function refuses everything (fails closed).

Strongly recommended — only let your own website call the function:

```bash
supabase secrets set ALLOWED_ORIGINS='https://YOUR-USER.github.io'
```

(comma-separate several origins; use the origin only, no path).

Optional extra secret for signing session tokens: `supabase secrets set EDITOR_TOKEN_SECRET="$(openssl rand -hex 32)"`.
Without it, tokens are signed with a key derived from the server secret key and the PIN.

### 3. Deploy the Edge Function

```bash
supabase functions deploy kb-editor --no-verify-jwt --project-ref jubjcrwsmhfcnkxhhqkm
```

`--no-verify-jwt` (also set in `supabase/config.toml`) is required: your project uses `sb_publishable_…` keys, which the platform's JWT check does not understand. The function authorizes every request itself with the PIN / signed token.

The function reads the server key from the `SUPABASE_SECRET_KEYS` environment variable (falling back to `SUPABASE_SERVICE_ROLE_KEY`). Supabase injects both automatically — you do not set them.

### 4. Verify (2 minutes)

```bash
URL=https://jubjcrwsmhfcnkxhhqkm.supabase.co

# a) public can read
curl -s "$URL/rest/v1/kb_data?select=id" -H "apikey: sb_publishable_yOcwh1QlWTetDCHuBSbWWw_KMIFeCEE" | head -c 300

# b) public can NOT write (expect 401/403 and an error body)
curl -s -X PATCH "$URL/rest/v1/kb_data?id=eq.sla" -H "apikey: sb_publishable_yOcwh1QlWTetDCHuBSbWWw_KMIFeCEE" \
  -H "Content-Type: application/json" -d '{"content":[]}'

# c) wrong PIN is rejected (expect 401 {"error":"bad_pin","attempts_left":4})
curl -s -X POST "$URL/functions/v1/kb-editor" -H "Content-Type: application/json" -d '{"action":"verify","pin":"000000"}'
```

Then open the site, click any ✏️ button, enter the real PIN, change something small, save, reload in another browser: the change is there. In SQL Editor, `select group_id, action, created_at from kb_data_backups order by id desc limit 5;` shows the backup that was taken first.

### 5. Publish the site files

Commit the changed files to the `feature/supabase-auth-editor` branch only:

```bash
git checkout feature/supabase-auth-editor
git apply supabase-pin-editor.patch        # or copy the files from the zip over the branch
git add -A && git commit -m "Public read, PIN-protected editing via Edge Function"
git push origin feature/supabase-auth-editor
```

Do **not** merge into `main` until you have tested the branch.

## Rate limiting

* Per client (salted hash of the IP, no raw IPs stored): **5 wrong PINs per 15 minutes**, then locked for 15 minutes. A correct PIN resets that client's counter.
* Globally (protects against guessing from many IPs): **60 wrong PINs per 15 minutes**, then everyone is locked for 5 minutes.
* Every attempt is counted *before* the PIN is checked; if counting fails the request is refused.
* Note for offices: people behind the same network share an IP, so 5 mistakes from different colleagues can lock that office for 15 minutes.

All limits can be changed with secrets: `PIN_MAX_ATTEMPTS`, `PIN_WINDOW_SECONDS`, `PIN_LOCK_SECONDS`, `PIN_GLOBAL_MAX_ATTEMPTS`, `PIN_GLOBAL_LOCK_SECONDS`, `TOKEN_TTL_SECONDS` (default 1800), `BACKUPS_KEEP_PER_GROUP` (default 200, minimum 20).

## Changing / rotating the PIN

Set the secret again (`EDITOR_PIN_HASH` or `EDITOR_PIN`); no redeploy is needed. Every existing editing session stops working immediately (tokens are bound to the PIN).

## Restoring from a backup

Each save stores the content as it was *before* the change in `kb_data_backups`. To roll a group back:

```sql
-- look at what is available
select id, group_id, action, created_at from kb_data_backups where group_id = 'topics' order by id desc limit 20;

-- restore backup #123 (this itself overwrites the current value; take a fresh export first if unsure)
update kb_data set content = (select content from kb_data_backups where id = 123), updated_at = now()
 where id = 'topics';
```

Backups are only readable with the service key / SQL editor, never by website visitors. The newest 200 per group are kept.

## Notes

* The old email/password login is gone from the site. Existing Supabase Auth users are not used any more; you may disable sign-ups in Authentication → Providers → Email if you wish.
* A new data group `kb_meta` is created the first time someone adds a category ("branch"). The 18 existing groups are untouched.
* If a group has no row in `kb_data` yet, the first edit seeds it from the copy embedded in `index.html`, so nothing is lost.
* The embedded copy in `index.html` is a fallback: it is shown instantly and when Supabase is unreachable (a notice explains that editing is unavailable).
* The publishable key in `kb-admin.js` is meant to be public. Never put a secret key or the PIN in any frontend file.
