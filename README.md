# ChoreNest

Roommate cleaning rotation web app on Google Apps Script: vanilla JavaScript, Google Sheets as the database.

- `src/backend/`: Apps Script server code. `Rotation.js` is the pure rotation engine.
- `src/frontend/`: HTML served by the web app.
- `scripts/`: clasp wrappers (`clasp-env.js`), login, secrets and temporary-password helpers.
- `test/`: Node tests. `e2e/`: Playwright tests with a mocked backend.

## Setup

Needs Node.js 18+ and the [Apps Script API](https://script.google.com/home/usersettings) enabled for your Google account.

1. `npm install`, then `npm run login`. This signs in to ChoreNest's own credential file (`.clasp-auth/`, gitignored), never `~/.clasprc.json`, so another clasp login (for example a work account) is not used. `npm run login:status` shows the account. If the login is missing, push and deploy stop and never try another account.
2. Create two Apps Script projects (DEV, PROD) and two Google Sheets, one per environment. Set each Sheet's time zone to Berlin (**File → Settings**); it must match the script's `Europe/Berlin`.
3. In each project's **Script Properties** set:
   - `ENVIRONMENT`: `DEV` or `PROD`.
   - `SPREADSHEET_ID`: the part of the Sheet URL between `/d/` and `/edit`.
   - `SESSION_SECRET` and `PASSWORD_PEPPER`: run `npm run secrets` once per environment and paste the two values (nothing is saved). Never reuse them between DEV and PROD. Changing the pepper invalidates every password; changing the secret signs everyone out.
4. Create the gitignored configs and set `scriptId` in each (in `.clasp.prod.json` also set `"environment": "PROD"`):
   ```
   cp .clasp.example.json .clasp.dev.json
   cp .clasp.example.json .clasp.prod.json
   ```
5. `npm run deploy:dev`, then copy the printed deployment ID into `deploymentId` in `.clasp.dev.json` so the URL stays the same.
6. In the editor run `setupDatabase` once, then `diagnoseDatabase` (DEV) and check for `"ok": true` (see Maintenance).
7. Create the first admin account (`createAccount` with `ACCOUNT_ROLE` `ADMIN`, see Maintenance), then sign in.

Config files, credentials, script IDs, deployment IDs and tokens are gitignored. Never commit them.

## Commands

| Command | Effect |
| --- | --- |
| `npm test` | Node tests |
| `npm run test:e2e` | Playwright against the real frontend with a mocked backend (Chrome; `E2E_CHANNEL=msedge` for Edge). Screenshots go to `e2e/results/screenshots/`. |
| `npm run push:dev` | Push `src/` to DEV (editor code, HEAD) |
| `npm run deploy:dev` | Push to DEV and update the DEV deployment |
| `npm run push:prod` | Push `src/` to PROD HEAD only. **Never deploys.** Clean tree and typed `PROD` required. |
| `npm run deploy:prod` | Push to PROD and update the deployment. Clean tree, typed `PROD`, and no `EditorTools.js`. |
| `npm run secrets` | Print a new `SESSION_SECRET` and `PASSWORD_PEPPER` |
| `npm run temp-password` | Print a random temporary password (not saved) |
| `npm run login`, `npm run login:status` | Personal clasp login, and which account is used |
| `npm run bundle:noble` | Rebuild `NobleHashes.js` (`-- --check` verifies it) |

`scripts/clasp-env.js` targets one environment's config per run and refuses mismatched configs or shared script/deployment IDs.

## How it works

- **Environments.** DEV and PROD are separate projects and Sheets built from one source tree. A project whose `ENVIRONMENT` is missing or not `DEV`/`PROD` serves an "unavailable" page. `setupDatabase` marks each Sheet with its environment, so a project refuses the other's Sheet. Session tokens are bound to their environment.
- **Rotation.** Roommates take turns in `ROTATION` order. A turn covers one weekend and is due Monday 00:00 Berlin (so Sunday 23:59 is on time). A missed turn stays with its roommate, overdue, until a `CLEANING_LOGS` row closes it. Logs are never rewritten.
- **Cleaning.** The current assignee marks the turn done. The server re-derives the turn under the script lock.
- **Vacations.** Roommates plan, edit, end (**I'm back**) and cancel their own vacations. A turn inside a vacation is skipped (a `vacation_skipped` log) when the next page load or reminder run reconciles. Cancelling sets `cancelled_at`; rows are never deleted. The server refuses changes that would alter history (dates in the past, a turn already skipped, the current turn, an out-of-date page). The owner then fixes the `VACATIONS` row in the Sheet and runs `diagnoseDatabase`.
- **Swaps.** A roommate asks another to swap one weekend each, up to 26 turns ahead. Only the receiver can accept or decline; only the requester can cancel. Only an accepted swap changes who cleans, and only on those two weekends.
- **History.** A table of cleaning weekend, roommate, status and resolved date. It shows the last 14 days by default (a weekend counts when its Sunday is within the last 14 Berlin calendar days, today included), with 30 days, 90 days and all time as filters. The server filters and pages it (25 per page). **Download CSV** saves every record of the chosen range; text starting with `=`, `+`, `-` or `@` is prefixed with an apostrophe so a spreadsheet never runs it. Notes and emails are never sent.
- **Writes.** Every write runs under the script lock and re-checks the session against the Sheet.

## Sign-in and accounts

- Everyone signs in with a username and password. A temporary password must be replaced before anything else shows. It expires after 72 hours (a missing expiry counts as expired).
- Passwords are 10–128 characters, hashed with PBKDF2-HMAC-SHA256 (600,000 iterations) and a pepper. Never edit `password_hash` by hand.
- Five wrong passwords lock the account for 15 minutes. Unknown user, wrong password and locked account get the same answer.
- A session lasts 14 days per device (the token is in the browser's local storage). **Sign out**, a password change and a reset end the roommate's sessions on all devices.
- Every request carries the token. The server takes identity and role from the token and the current ROOMMATES row; a request never names who is acting.
- **Admins** (**Profile → Manage household**) add roommates, create accounts, issue temporary passwords (shown once, never stored or logged), end sessions, disable sign-in and change roles. The role is read from the Sheet on every call. An admin cannot disable, demote or sign out themselves, and at least one admin must always be able to sign in. Marking a roommate as moved out (`active`) is done in the Sheet.
- Text written to the Sheet must not start with `=`, `+`, `-`, `@` or a tab (formula protection).

## Maintenance (editor only)

The browser cannot call the private helpers (names ending in `_`). `src/backend/EditorTools.js` holds nine thin wrappers so you can run them in the Apps Script editor: `setupDatabase`, `diagnoseDatabase`, `onboardRoommate`, `resolveOverdueTurn`, `createAccount`, `resetAccountPassword`, `previewFridayReminder`, `installFridayReminder`, `removeFridayReminder`.

**Every top-level function of a web app is callable from the browser. These wrappers may only exist while the web app is private to its owner, and they are never part of a PROD deployment.** `clasp-env.js` refuses to push them unless the manifest has `access: MYSELF` and `executeAs: USER_DEPLOYING`, and refuses to deploy them to PROD at all. The helpers also run only for the script owner and only while the Script Property `MAINTENANCE_UNTIL` is a time within the next hour (ISO, for example `2026-10-13T20:30:00Z`). Delete the property when done.

- **`setupDatabase`** creates missing sheets and header columns and marks the Sheet's environment. Safe to repeat: it never edits, moves or deletes cells. Run it after pushing code that adds columns; until then the app reports a setup problem. Back up the Sheet first (**File → Make a copy**).
- **`diagnoseDatabase`** (DEV only, read-only) reports schema problems and lists rows in `ROTATION`, `CLEANING_LOGS` and `SWAPS` that the app would reject, with Sheet row numbers. `"breaksSchedule": true` means the schedule will not load until the row is fixed by hand.
- **`onboardRoommate`**: set `ONBOARD_NAME` and `ONBOARD_EMAIL` (optional `ONBOARD_TELEGRAM`, `ONBOARD_POSITION`) and run it. It adds the roommate with the next member code (for example `JHN-005`) and a rotation position, removes the `ONBOARD_*` properties and sends no email. Admins can also add roommates in the app.
- **`resolveOverdueTurn`**: set `RESOLVE_DUE_DAY` (the turn's last day, a Sunday, `YYYY-MM-DD`) and `RESOLVE_REASON` (required, up to 300 characters) and run it. It appends one `admin_resolved` log and the rotation moves on. It refuses a turn that is not overdue, a wrong day, and a turn a vacation skips. Delete the `RESOLVE_*` properties afterwards.
- **Accounts** (also the fallback when no admin can sign in). Accounts belong to existing roommates.
  1. `npm run temp-password` prints a password.
  2. Set `ACCOUNT_MEMBER_CODE` and `ACCOUNT_TEMP_PASSWORD`. To create an account also set `ACCOUNT_USERNAME` (3–32 lower-case letters, digits, `.`, `_` or `-`, starting with a letter) and optionally `ACCOUNT_ROLE` (`ROOMMATE` by default, or `ADMIN`).
  3. Run `createAccount`, or `resetAccountPassword` for a forgotten password. It deletes `ACCOUNT_TEMP_PASSWORD` first, stores only a hash, logs no password and takes about 10 seconds.
  4. Give the password to the roommate in person within 72 hours.

## Telegram reminders

`Telegram.js` builds the Friday message from the real rotation (current cleaner and weekend, overdue turn, swaps, next cleaner, app link) and sends it through the Neatify bot. `Reminder.js` runs it from one trigger: Fridays 09:00–10:00 Europe/Berlin. A run does nothing outside Friday 08:30–12:00 Berlin time, and `runFridayReminder` refuses unless this project's own trigger started it.

- Script Properties: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` (a number like `-1001234567890`, or `@channelname`), `APP_URL` (https), optional `TELEGRAM_DRY_RUN`. **DEV is a dry run unless it is `false`; PROD sends unless it is `true`.** A dry run builds the message and sends nothing. The token is never logged or returned. Keep it per environment.
- Run `previewFridayReminder` (never sends) to see the text, then `installFridayReminder` once per environment. It replaces any existing reminder trigger; `removeFridayReminder` deletes it.
- Each run first records due vacation skips, then claims the week in the Script Property `REMINDER_STATE` under the lock, so a week is sent at most once.
- A certain failure (not configured, rejected) frees the week for another run. If Telegram may have received the message (no answer, 5xx, unreadable answer) the week is `unconfirmed` and is never retried.
- **Recovering an `unconfirmed` week:** check the chat. If the message arrived, do nothing. If not, post the text from `previewFridayReminder` by hand. The next Friday is a new week and runs normally. Deleting `REMINDER_STATE` only matters if you re-run the same Friday from a re-installed trigger.

## Release and PROD maintenance

PROD changes only through `push:prod` and `deploy:prod`, from a clean, committed tree. The version roommates use is the *deployment*. The editor and installed triggers (the reminder) run **HEAD**, the last pushed code.

**First release**
1. Verify on DEV and commit. Back up the PROD Sheet. Set the PROD Script Properties (Setup step 3, Telegram).
2. With `EditorTools.js` still committed and the manifest `access: MYSELF`, run `npm run push:prod`. This creates no deployment.
3. In the PROD editor, open the maintenance window and run `setupDatabase`, `createAccount` (the first `ADMIN`), `previewFridayReminder`, `installFridayReminder`. Delete `MAINTENANCE_UNTIL`.
4. Delete `EditorTools.js`, set the manifest access you want and commit. Run `npm run deploy:prod` (it pushes HEAD too, so triggers now run the release code). Copy the deployment ID into `.clasp.prod.json`.

**Later maintenance on PROD** (for example `diagnoseDatabase`, `resolveOverdueTurn`, reinstalling the trigger). Avoid Friday mornings: the trigger runs whatever HEAD holds.
1. Branch from the release commit. Restore the file and make the manifest owner-only: `git show <deleting-commit>^:src/backend/EditorTools.js > src/backend/EditorTools.js`, set `access: MYSELF` in `src/appsscript.json`, commit.
2. `npm run push:prod`. The deployment roommates use does not change.
3. Open the maintenance window, run the tool in the editor, delete `MAINTENANCE_UNTIL`.
4. **Restore HEAD:** switch back to the release commit and run `npm run push:prod` again. Until then HEAD still contains the wrappers.

**Routine release:** commit, run `npm run deploy:prod`, and check the script ID, deployment ID and commit shown. It fails while `EditorTools.js` exists.

**Rollback:** `git switch --detach <last-good-commit>`, then `npm run deploy:dev` (or `deploy:prod`), then switch back to your branch. The deployment keeps its URL. Data is untouched. If the newer version added Sheet columns, the older code refuses the Sheet until you delete those new header cells (columns are matched by name, so nothing else moves).
