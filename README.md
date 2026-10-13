# ChoreNest

Roommate cleaning rotation web app on Google Apps Script, vanilla JavaScript and Google Sheets.

- `src/backend/`: Apps Script server code, including the pure rotation engine (`Rotation.js`)
- `src/frontend/`: HTML served by the web app
- `scripts/clasp-env.js`: push and deploy for one environment
- `test/`: Node tests

## Setup

Requires Node.js 18+ and the [Apps Script API](https://script.google.com/home/usersettings) enabled for your Google account.

1. `npm install`, then `npm run login`.
2. Create two Apps Script projects (DEV and PROD) and two Google Sheets, one per environment. Set each Sheet's time zone to Berlin (**File → Settings**); it must match the script's `Europe/Berlin`.
3. In each project's **Script Properties**, set `ENVIRONMENT` (`DEV` or `PROD`) and `SPREADSHEET_ID` (the part of the Sheet URL between `/d/` and `/edit`).
4. Create the gitignored clasp configs and set `scriptId` in each:
   ```
   cp .clasp.example.json .clasp.dev.json
   cp .clasp.example.json .clasp.prod.json
   ```
   In `.clasp.prod.json`, also set `"environment": "PROD"`.
5. Run `npm run deploy:dev`, then copy the deployment ID it prints into `deploymentId` so the web app URL stays the same. Do the same for PROD.
6. Run the maintenance tools below: `setupDatabase` once in each project, then `diagnoseDatabase` in DEV and check for `"ok": true`.

## Maintenance (temporary)

Setup, diagnostics and adding roommates are private helpers (`setupDatabase_`, `diagnoseDatabase_`, `onboardRoommate_`) that the browser cannot call. `src/backend/EditorTools.js` holds three thin wrappers (`setupDatabase`, `diagnoseDatabase`, `onboardRoommate`) so you can run them from the Apps Script editor.

Those wrappers are temporary: every top-level function of a web app can be called from the browser. They are only acceptable while the web app is private to its owner, and they are protected twice more: the helpers run only for the script owner, and only while the Script Property `MAINTENANCE_UNTIL` is set to a time within the next hour (ISO, for example `2026-10-13T20:30:00Z`). Delete the property afterwards.

**Delete `src/backend/EditorTools.js` before opening the web app to anyone else.** `scripts/clasp-env.js` refuses to push while it exists unless the manifest access is `MYSELF` and the web app runs as `USER_DEPLOYING`. To run maintenance again later, restore the file, push, run, delete, push.

### Adding a roommate

In the project's **Script Properties** set `ONBOARD_NAME` and `ONBOARD_EMAIL`, optionally `ONBOARD_TELEGRAM` and `ONBOARD_POSITION` (a free rotation position; the default is after the last one). Open the maintenance window, then run `onboardRoommate` in the editor. It gives the roommate the next member code (for example `JHN-005`), adds their rotation position, and removes the `ONBOARD_*` properties. Running it again adds nobody, and no email is sent.

## App sections

Schedule and Vacation work. Swaps and History are "Work in progress" pages with no actions. The profile button at the top right shows only the name picked from the list, labelled "not verified": there is no login yet.

## Vacations

Roommates plan and cancel vacations in the app (**Vacations** card on the main screen): first day away and first day back. Rows go into the `VACATIONS` Sheet; cancelling sets `cancelled_at` and never deletes. A started vacation, or one that already skipped a turn, can't be cancelled in the app. The name picked on the page is not a login, so for now anyone with the link can change a vacation for any name. After updating from an older version, run `setupDatabase` once to add the `cancelled_at` column.

## Browser tests

`npm run test:e2e` runs Playwright against the real frontend files with a mocked backend (no Google account, no DEV or PROD access). It tests phone (375 and 390 px), tablet and desktop sizes in the installed Microsoft Edge; set `E2E_CHANNEL=chrome` to use Chrome. Screenshots land in `e2e/results/screenshots/` and are not committed. `npm test` stays the fast Node suite.

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
