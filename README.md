# DOD — shared trip collections

One collection link lets guests upload, view and download original photos and videos without signing in. Guest routes never delete, rename, move, replace files, or change Drive permissions. Google Drive remains private; the app mediates access to the selected collection folder.

Hosted at https://dod.celopats.lv on the existing Hetzner server, independently of KC Drum Lessons and CHelp Therapy. The root celopats.lv WordPress website stays on its original host.

## Runtime

Node 24.19 LTS, native HTTP server, TypeScript executed with Node type stripping, native SQLite, and a dependency-free browser interface. No npm installation or build step. Node's SQLite API is experimental in this runtime; pin the Node version and run the tests before upgrading.

```sh
npm test
PUBLIC_ORIGIN=http://localhost:3000 npm start
```

The first start writes a random owner password to `data/owner-access.txt`. Change it in the dashboard. Never publish this file or the data directory. The owner dashboard is `/admin`; guest links are `/c/<random-token>`.

## Google setup

Use your own Google Cloud project. Enable Drive API, configure Google Auth Platform and create a Web application OAuth client. Redirect URI: `https://dod.celopats.lv/oauth/callback`. Store client ID, secret and owner email in the dashboard, then authorize Google Drive. Owner email is verified against Google's userinfo endpoint. Background access uses an encrypted refresh token. OAuth uses state, an owner session, PKCE and an exact redirect URI.

Scopes: `openid`, `email`, `drive.file`. This permits app-created or explicitly authorized files rather than full Drive access. Create a fresh folder for each collection, or enable Picker API and configure a website-restricted browser API key to select an existing folder. Selecting a folder does **not** automatically authorize every pre-existing child file. Upload through DOD to make files available; importing unrelated existing files is outside this first version. Collections do not recurse into subfolders.

External OAuth apps in Testing generally have seven-day refresh-token expiry for Drive access. Use the appropriate production or Workspace internal configuration before sharing long-term; meet Google's applicable branding/verification requirements. Dashboard settings include the setup checklist.

Disconnecting removes the app's saved refresh token. To revoke the grant at Google too, remove DOD in the Google account's connected-app settings. Reconnect the same account to keep existing collection folders accessible.

## Uploads and downloads

- 8 MiB chunks, at most two queued files per browser and four concurrent chunk/status requests in the server.
- 10 GiB maximum file, 100 GiB app-upload allowance per collection in version one. Allowance is an application reservation cap, not reserved Drive storage; existing folder files and Google storage limits are separate.
- Pre-generated Drive file IDs make ambiguous final-chunk retries recoverable without new duplicate files.
- Metadata and upload offsets persist in SQLite. Resumable session URLs are encrypted and never sent to guests.
- Every upload is verified against its Drive file ID, folder and byte length before success. Original content is forwarded without compression or conversion.
- Interrupted uploads can resume while a Drive session remains valid. After page reload guests may need to reselect the original files. Expired sessions require restarting that file; incomplete reservations expire after eight days.
- Identical names create independent Drive files. Intentional reselection can create duplicates; there is no content-based deduplication.
- Only supported photo/video formats are exposed. HEIC and some video codecs may download successfully but lack a native browser preview.
- Downloads stream with backpressure and range support. Guests cannot list files outside the collection; file routes check current folder membership.
- Owner can close uploads, disable links and replace links. These do not delete Drive content. An already-started transfer may finish after a control changes.
- People with the link see all app-accessible media in the collection folder, including guest uploads. Treat the link as a private invitation, not a public URL.

## Deployment

`compose.yaml` joins the existing `kcdrumlessons_frontend` network as `dod-app`; it publishes no host ports. Run under `/opt/dod` with `data/` owned by UID 1000. Caddy receives only an additional `dod.celopats.lv` reverse-proxy block. Back up and validate Caddy before reloading; never recreate the existing WordPress stack for this app.

Container: non-root, read-only filesystem, dropped capabilities, bounded logs, 384 MiB memory and 0.75 CPU limit. The runtime data volume holds SQLite, the encryption key and the initial owner-access file. No persistent media staging or third-party analytics.

Back up the SQLite database using a consistent SQLite backup and preserve `encryption.key` separately with equivalent access protection. Both are necessary for recovery. Before deploying updates, take a backup and retain the previous source/image. A scheduled off-server backup destination is not configured yet. Do not copy live WAL files casually; stop only this app for a consistent filesystem copy if not using SQLite backup.

Rollback routing: restore the saved Caddyfile, validate it, reload Caddy, and stop only `dod` services. Guest uploads continue to exist in Drive. Do not remove `data/`.

## Verification

`npm test` uses a simulated Drive to check guest permissions, CSRF/origin controls, arbitrary-file denial, chunk offsets, final-upload retries, duplicate filenames, link controls, encrypted persistence and server restart. Protocol tests cover Drive 308 partial responses, successful completion and expired sessions. OAuth, Google Picker, real Drive file transfers and phone-browser suspension require live testing after owner authorization. These tests do not claim Google integration has been validated live.

Reference documentation:
- https://developers.google.com/workspace/drive/api/guides/manage-uploads
- https://developers.google.com/workspace/drive/api/guides/api-specific-auth
- https://developers.google.com/identity/protocols/oauth2/web-server
- https://developers.google.com/identity/protocols/oauth2
- https://developers.google.com/workspace/drive/picker/reference/picker.pickerbuilder.setappid
