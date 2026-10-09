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
6. In each project's Apps Script editor, run `setupDatabase` once. It creates missing sheets and headers and never overwrites data.
7. In DEV, run `diagnoseDatabase` and check for `"ok": true`.

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
