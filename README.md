# ChoreNest

Roommate cleaning rotation web app on Google Apps Script, with Google Sheets as the database.

- Server code — [src/backend/](src/backend/) (rotation engine: [Rotation.js](src/backend/Rotation.js))
- Web pages — [src/frontend/](src/frontend/)
- clasp wrappers and helpers — [scripts/](scripts/)
- Tests — [test/](test/) (Node) and [e2e/](e2e/) (Playwright, mocked backend)

---

## Setup

### Prerequisites

- Node.js 18+
- [Apps Script API](https://script.google.com/home/usersettings) enabled for your Google account

### 1) Log in and create projects

```bash
npm install
npm run login
```

This signs in to ChoreNest's own credential file (`.clasp-auth/`, gitignored), never another clasp login. `npm run login:status` shows the account.

Create two Apps Script projects and two Google Sheets (DEV, PROD). Set each Sheet's time zone to Berlin (**File → Settings**).

### 2) Script Properties

Set these in each project. Never reuse secrets between DEV and PROD.

| Property | Description |
|---|---|
| `ENVIRONMENT` | `DEV` or `PROD` |
| `SPREADSHEET_ID` | Sheet ID from the URL (between `/d/` and `/edit`) |
| `SESSION_SECRET`, `PASSWORD_PEPPER` | From `npm run secrets` (once per environment). A new pepper invalidates all passwords; a new secret signs everyone out. |
| `PHOTO_FOLDER_ID` | From `setupPhotoFolder` (step 5) |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_URL` | Reminders (see Telegram) |

### 3) Configure clasp

```bash
cp .clasp.example.json .clasp.dev.json
cp .clasp.example.json .clasp.prod.json
```

Set `scriptId` in each (and `"environment": "PROD"` in the PROD file). These files are gitignored.

### 4) Deploy DEV

```bash
npm run deploy:dev
```

Copy the printed deployment ID into `.clasp.dev.json` so the URL stays the same.

### 5) Prepare the Sheet, photos and first admin

In the Apps Script editor (see Maintenance), run:

1. `setupDatabase`, then `diagnoseDatabase` and check for `"ok": true`.
2. `setupPhotoFolder`, then set `PHOTO_FOLDER_ID` to the ID it returns. Photos stay off until then.
3. `createAccount` with `ACCOUNT_ROLE` `ADMIN`, then sign in.

The first editor run asks you to approve the OAuth scopes (Sheets, external requests, triggers, your email, `drive.file`). If scopes change later, approve again and redeploy.

---

## Commands

| Command | What it does |
|---|---|
| `npm test` | Node tests |
| `npm run test:e2e` | Playwright tests (Chrome; `E2E_CHANNEL=msedge` for Edge) |
| `npm run push:dev` / `deploy:dev` | Push to DEV / push and update the DEV deployment |
| `npm run push:prod` | Push to PROD HEAD only. **Never deploys.** Clean tree and typed `PROD` required. |
| `npm run deploy:prod` | Push and update the PROD deployment. Clean tree, typed `PROD`, no `EditorTools.js`. |
| `npm run secrets` | Print a new `SESSION_SECRET` and `PASSWORD_PEPPER` |
| `npm run temp-password` | Print a random temporary password (not saved) |
| `npm run bundle:noble` | Rebuild `NobleHashes.js` (`-- --check` verifies it) |

---

## How It Works

- **Rotation.** Roommates take turns in `ROTATION` order. A turn covers one weekend and is due Monday 00:00 Berlin. A missed turn stays overdue with its roommate until a `CLEANING_LOGS` row closes it. Logs are never rewritten.
- **Cleaning.** The current assignee marks the turn done. Every write runs under the script lock and re-checks the session.
- **Vacations.** Roommates plan, edit, end and delete their own. Turns inside a vacation are skipped. A vacation that already skipped a turn, or whose removal would change the current turn, cannot be deleted. Deleting sets `cancelled_at`; rows are never removed.
- **Swaps.** A roommate asks another to swap one weekend each. Only the receiver can accept or decline, and only an accepted swap changes who cleans.
- **Profiles and avatars.** A card in *Coming up* opens a roommate's profile: completed turns, on-time rate, next turn and recent cleanings, all worked out from the logs. A turn is on time if marked before its weekend ended. Roommates pick one of eight bundled avatars for themselves only.
- **Leaderboard** (History tab). On-time cleaning 15 points, late 10, vacation skip or owner-closed turn 0. Points go to whoever actually cleaned. Streaks count on-time turns; late and owner-closed turns reset them, skips do not. Shows this month (Berlin) or all time.
- **Photos.** The cleaner can add one optional JPEG per cleaning (shrunk to 1280 px and 500 KB in the browser, checked again on the server). The cleaner or an admin can delete it; any signed-in roommate can view it. Photos live in a private Drive folder per environment and load only when opened. A failed upload never affects the cleaning.
- **History.** Last 14 days by default, with 30 days, 90 days and all time. **Download CSV** saves the chosen range.
- **Environments.** DEV and PROD are separate projects and Sheets from one source tree. A project refuses the other's Sheet, and session tokens are bound to their environment.

---

## Sign-In and Accounts

- Username and password. A temporary password expires after 72 hours and must be replaced at first sign-in.
- Passwords are 10–128 characters, hashed with PBKDF2 and a pepper. Never edit `password_hash` by hand.
- Five wrong passwords lock the account for 15 minutes.
- A session lasts 14 days per device. Sign out, a password change or a reset ends all of a roommate's sessions.
- **Admins** (**Profile → Manage household**) add roommates, create accounts, issue temporary passwords (shown once), end sessions, disable sign-in and change roles. At least one admin must always be able to sign in. Mark a roommate as moved out (`active`) in the Sheet.
- Text written to the Sheet must not start with `=`, `+`, `-`, `@` or a tab.

---

## Maintenance (Editor Only)

`src/backend/EditorTools.js` holds thin wrappers you run in the Apps Script editor.

**Every top-level function of a web app is callable from the browser. The wrappers may only exist while the web app is private to its owner and are never part of a PROD deployment.** `clasp-env.js` enforces this. They run only for the script owner, and only while the Script Property `MAINTENANCE_UNTIL` is a time within the next hour (ISO, for example `2026-10-13T20:30:00Z`). Delete it when done.

| Function | What it does |
|---|---|
| `setupDatabase` | Creates missing sheets and columns and marks the Sheet's environment. Safe to repeat. Run it after any push that adds columns. Back up the Sheet first. |
| `diagnoseDatabase` | DEV only, read-only. Reports schema problems and rows the app would reject. |
| `setupPhotoFolder` | Creates this environment's private photo folder and returns its ID. Run it again to remove orphaned photos. Only this folder works; never share it. |
| `onboardRoommate` | Set `ONBOARD_NAME`, `ONBOARD_EMAIL` (optional `ONBOARD_TELEGRAM`, `ONBOARD_POSITION`). Admins can also add roommates in the app. |
| `resolveOverdueTurn` | Set `RESOLVE_DUE_DAY` (the turn's Sunday, `YYYY-MM-DD`) and `RESOLVE_REASON`. Closes an overdue turn so the rotation moves on. |
| `createAccount`, `resetAccountPassword` | Set `ACCOUNT_MEMBER_CODE` and `ACCOUNT_TEMP_PASSWORD` (from `npm run temp-password`). To create, also set `ACCOUNT_USERNAME` and optionally `ACCOUNT_ROLE`. Give the password to the roommate in person within 72 hours. |
| `previewFridayReminder`, `installFridayReminder`, `removeFridayReminder` | Reminder tools (see Telegram) |

Delete the `ONBOARD_*`, `RESOLVE_*` and `ACCOUNT_*` properties afterwards.

---

## Telegram Reminders

A Friday trigger (09:00–10:00 Berlin) posts the current cleaner, any overdue turn and the next cleaner. A run does nothing outside Friday 08:30–12:00 Berlin.

- Properties: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `APP_URL` (https), optional `TELEGRAM_DRY_RUN`. **DEV is a dry run unless it is `false`; PROD sends unless it is `true`.**
- Run `previewFridayReminder` (never sends), then `installFridayReminder` once per environment.
- A week is sent at most once. If Telegram may have received the message, the week is `unconfirmed` and is not retried: check the chat and post the preview text by hand if needed.

---

## Release and PROD

PROD changes only through `push:prod` and `deploy:prod` from a clean, committed tree. Roommates use the *deployment*; the editor and the reminder trigger run **HEAD**.

**First release**
1. Verify on DEV and commit. Back up the PROD Sheet and set its Script Properties.
2. With `EditorTools.js` still committed and the manifest `access: MYSELF`, run `npm run push:prod` (no deployment).
3. In the PROD editor, open the maintenance window and run `setupDatabase`, `setupPhotoFolder` (then set `PHOTO_FOLDER_ID`), `createAccount` (first `ADMIN`), `previewFridayReminder`, `installFridayReminder`. Delete `MAINTENANCE_UNTIL`.
4. Delete `EditorTools.js`, set the manifest access you want, commit, and run `npm run deploy:prod`. Copy the deployment ID into `.clasp.prod.json`.

**Later maintenance on PROD** (avoid Friday mornings)
1. Branch from the release commit, restore `EditorTools.js` (`git show <deleting-commit>^:src/backend/EditorTools.js > src/backend/EditorTools.js`), set `access: MYSELF`, commit.
2. `npm run push:prod`, run the tool in the editor, delete `MAINTENANCE_UNTIL`.
3. **Restore HEAD:** switch back to the release commit and run `npm run push:prod` again.

**Routine release:** commit, then `npm run deploy:prod`. It fails while `EditorTools.js` exists.

**Rollback:** `git switch --detach <last-good-commit>`, run `npm run deploy:dev` (or `deploy:prod`), then switch back. The URL and data are unchanged. If the newer version added Sheet columns, delete those header cells, or the older code refuses the Sheet.

---

## Notes

- **Never commit** config files, credentials, script IDs, deployment IDs or tokens (all gitignored).
- **Photos need a folder:** until `PHOTO_FOLDER_ID` is set, uploads report "Photos aren't set up yet".
