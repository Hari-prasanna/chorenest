# ChoreNest

Roommate cleaning rotation web app on Google Apps Script, vanilla JavaScript and Google Sheets.

- `src/backend/`: Apps Script server code, including the pure rotation engine (`Rotation.js`)
- `src/frontend/`: HTML served by the web app
- `scripts/clasp-env.js`: push and deploy for one environment
- `test/`: Node tests

## Setup

Requires Node.js 18+ and the [Apps Script API](https://script.google.com/home/usersettings) enabled for your Google account.

1. `npm install`, then `npm run login`. This signs in to ChoreNest's **own** credential file (`.clasp-auth/`, gitignored), never the machine-wide `~/.clasprc.json`, so another clasp login on the same PC (for example a work account) is neither used nor changed. `npm run login:status` shows the account in use. If the personal login is missing or expired, push and deploy stop with an instruction and never try another account.
2. Create two Apps Script projects (DEV and PROD) and two Google Sheets, one per environment. Set each Sheet's time zone to Berlin (**File → Settings**); it must match the script's `Europe/Berlin`.
3. In each project's **Script Properties**, set `ENVIRONMENT` (`DEV` or `PROD`) and `SPREADSHEET_ID` (the part of the Sheet URL between `/d/` and `/edit`). For sign-in, also set `SESSION_SECRET` and `PASSWORD_PEPPER`: run `npm run secrets` in a terminal once per environment (two independent 32-byte values; nothing is saved) and paste them in. Never reuse values between DEV and PROD. Changing `PASSWORD_PEPPER` invalidates every password; changing `SESSION_SECRET` signs everyone out.
   ROOMMATES has eight authentication columns (`username`, `role`, `password_hash`, `must_change_password`, `session_version`, `failed_logins`, `locked_until`, `password_expires_at`). After pushing a version that adds any of them, run `setupDatabase` once; until then the app reports a setup problem. Never edit `password_hash` by hand.
4. Create the gitignored clasp configs and set `scriptId` in each:
   ```
   cp .clasp.example.json .clasp.dev.json
   cp .clasp.example.json .clasp.prod.json
   ```
   In `.clasp.prod.json`, also set `"environment": "PROD"`.
5. Run `npm run deploy:dev`, then copy the deployment ID it prints into `deploymentId` so the web app URL stays the same. Do the same for PROD.
6. Run the maintenance tools below: `setupDatabase` once in each project, then `diagnoseDatabase` in DEV and check for `"ok": true`.

## Maintenance (temporary)

Setup, diagnostics, adding roommates and resolving an overdue turn are private helpers (`setupDatabase_`, `diagnoseDatabase_`, `onboardRoommate_`, `resolveOverdueTurn_`) that the browser cannot call. `src/backend/EditorTools.js` holds four thin wrappers (`setupDatabase`, `diagnoseDatabase`, `onboardRoommate`, `resolveOverdueTurn`) so you can run them from the Apps Script editor.

`diagnoseDatabase` (DEV only) also lists data rows in `ROTATION`, `CLEANING_LOGS` and `SWAPS` that the app would reject or misread, under `invalidRows`, with their Sheet row numbers. Rows marked `"breaksSchedule": true` stop the schedule from loading until they are fixed by hand. It only reads: nothing is changed or deleted.

Those wrappers are temporary: every top-level function of a web app can be called from the browser. They are only acceptable while the web app is private to its owner, and they are protected twice more: the helpers run only for the script owner, and only while the Script Property `MAINTENANCE_UNTIL` is set to a time within the next hour (ISO, for example `2026-10-13T20:30:00Z`). Delete the property afterwards.

**Delete `src/backend/EditorTools.js` before opening the web app to anyone else.** `scripts/clasp-env.js` refuses to push while it exists unless the manifest access is `MYSELF` and the web app runs as `USER_DEPLOYING`. To run maintenance again later, restore the file, push, run, delete, push.

### Adding a roommate

In the project's **Script Properties** set `ONBOARD_NAME` and `ONBOARD_EMAIL`, optionally `ONBOARD_TELEGRAM` and `ONBOARD_POSITION` (a free rotation position; the default is after the last one). Open the maintenance window, then run `onboardRoommate` in the editor. It gives the roommate the next member code (for example `JHN-005`), adds their rotation position, and removes the `ONBOARD_*` properties. Running it again adds nobody, and no email is sent.

### Resolving an overdue turn

An overdue turn stays with its roommate until a log closes it. To close it without a cleaning, set the Script Properties `RESOLVE_DUE_DAY` (the turn's last day, the Sunday the app shows as "Was due", as `YYYY-MM-DD`) and `RESOLVE_REASON` (required, up to 300 characters). Open the maintenance window, then run `resolveOverdueTurn` in the editor. It appends one `admin_resolved` row to `CLEANING_LOGS` with the reason in `notes`, and the rotation moves on as it does after a completion. It refuses a turn that isn't overdue, a day that doesn't match, and a turn that a vacation skips automatically. Delete the `RESOLVE_*` properties afterwards.

### Migrating DEV to the sign-in schema (once)

The new code expects seven more ROOMMATES columns, and the old deployed version rejects them as unknown, so steps 3–5 belong together. `deploy:dev` refuses an uncommitted working tree, so commit first.

1. **Back up**: in Google Sheets, *File → Make a copy* of the DEV spreadsheet. Note the time.
2. **Secrets**: run `npm run secrets` in a terminal and paste `SESSION_SECRET` and `PASSWORD_PEPPER` into the DEV project's Script Properties.
3. **Push**: `npm run push:dev`. This changes only the editor code (HEAD); the deployed `/exec` keeps working.
4. **Extend the Sheet**: set `MAINTENANCE_UNTIL` (within the hour), run `setupDatabase` in the editor. Expected: `ROOMMATES: added username, role, password_hash, must_change_password, session_version, failed_logins, locked_until`, every other sheet `unchanged`. It only writes seven header cells; no row, ID, rotation, log or vacation is touched. Then run `diagnoseDatabase`: expect `"ok": true` and no `invalidRows`.
5. **Deploy**: `npm run deploy:dev`, which moves the existing DEV `/exec` to the new version (same URL). From step 4 until this step, the old `/exec` shows a setup error.
6. Delete `MAINTENANCE_UNTIL`.

To undo before any account exists: deploy the previous version again (Apps Script → *Manage deployments*), and delete the seven new header cells (columns are matched by name, so nothing else moves).

### Adding `password_expires_at` (once, after the sign-in release)

Same pattern as above: commit, back up the Sheet, `npm run push:dev`, run `setupDatabase` (expect `ROOMMATES: added password_expires_at`, everything else `unchanged`), `diagnoseDatabase`, then `npm run deploy:dev` straight away. A temporary password without an expiry counts as expired, so run `resetAccountPassword` for any account that has not changed its temporary password yet.

### Accounts (owner only, until the in-app admin exists)

Accounts belong to existing roommates; nothing here adds a roommate.

1. `npm run temp-password` in a terminal prints a random 16-character temporary password. It is not saved anywhere.
2. Set the Script Properties `ACCOUNT_MEMBER_CODE` (for example `ALX-001`) and `ACCOUNT_TEMP_PASSWORD`. To **create** an account also set `ACCOUNT_USERNAME` (3–32 lower-case letters, digits, `.`, `_` or `-`) and optionally `ACCOUNT_ROLE` (`ROOMMATE`, the default, or `ADMIN`).
3. Open the maintenance window and run `createAccount`, or `resetAccountPassword` for a forgotten password. The run deletes `ACCOUNT_TEMP_PASSWORD` before anything else (a failed run needs a fresh one), stores only a PBKDF2 hash, logs a one-line summary without the password, and removes the other `ACCOUNT_*` properties on success. It takes about 10 seconds.
4. Give the password to the roommate in person within 72 hours: after that it expires and needs a reset. They must choose their own at the first sign-in, before they can see anything. A reset ends all of that roommate's sessions.

Wrong current passwords during a password change count towards the same five-attempt, 15-minute lock as sign-in.

## App sections

Everyone signs in with a username and password (see Accounts). A first sign-in with a temporary password must choose a new one before anything else shows. A session lasts 14 days on that device (kept in the browser's local storage); **Sign out** in the profile ends the roommate's sessions on all devices. Schedule and Vacation work. Swaps and History are "Work in progress" pages with no actions. The profile shows the signed-in name and role.

Every household request carries the session token, and the server takes who is acting from it and from the ROOMMATES row as it is now: an ended, expired, revoked or deactivated session is refused, and the page returns to sign-in. A request never names a roommate.

## Vacations

Roommates plan, change and cancel vacations on the **Vacation** tab: first day away and first day back. Rows go into the `VACATIONS` Sheet; cancelling sets `cancelled_at` and never deletes. A started vacation, or one that already skipped a turn, can't be cancelled in the app. After updating from an older version, run `setupDatabase` once to add the `cancelled_at` column.

**Edit dates** and **I'm back** change the same row in place: the `vacation_id` and `created_at` stay. I'm back makes today (Berlin) the first day back. Neither ever changes history, so the server refuses (and the page says to ask the app owner):
- a first day away in the past, or a new first day away once the vacation has started;
- a first day back before today;
- new dates that no longer cover a weekend already recorded as `vacation_skipped` for this vacation;
- any change that would alter the current turn (who cleans, its dates or its skips);
- a change made from an outdated page: the request carries the dates the page showed, and they must still be the stored ones.

To resolve such a conflict, the owner edits the `VACATIONS` row in the Sheet by hand, then runs `diagnoseDatabase`. Cleaning logs are never rewritten.

Only the signed-in roommate can plan, change, end or cancel their own vacations; the server refuses anyone else's.

## Browser tests

`npm run test:e2e` runs Playwright against the real frontend files with a mocked backend (no Google account, no DEV or PROD access). It tests phone (375 and 390 px), tablet and desktop sizes in the installed Google Chrome; set `E2E_CHANNEL=msedge` to use Microsoft Edge. Screenshots land in `e2e/results/screenshots/` and are not committed. `npm test` stays the fast Node suite.

## Commands

| Command               | Effect                                              |
| --------------------- | --------------------------------------------------- |
| `npm test`            | Run the Node tests                                  |
| `npm run push:dev`    | Push `src/` to DEV                                  |
| `npm run deploy:dev`  | Push to DEV and update the DEV deployment           |
| `npm run deploy:prod` | Push to PROD and update the deployment, after confirmation |

## Environments

DEV and PROD are separate Apps Script projects and Sheets built from one source tree.

- A project whose `ENVIRONMENT` is missing or not exactly `DEV` or `PROD` serves an "unavailable" page.
- Each Sheet is marked with its environment by `setupDatabase`, so one environment refuses to use the other's Sheet.
- `scripts/clasp-env.js` always targets one environment's config. It refuses mismatched configs or shared script/deployment IDs.

## Deploying to PROD

1. Verify the change on DEV and commit it. PROD deploys need a clean working tree.
2. Run `npm run deploy:prod`, check the script ID, deployment ID and commit shown, and type `PROD` to continue.

Config files and credentials are gitignored. Never commit script IDs, deployment IDs or tokens.
