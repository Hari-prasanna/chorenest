# ChoreNest

A roommate cleaning rotation web app built on Google Apps Script, vanilla JavaScript and Google Sheets.

```
src/
  appsscript.json     Apps Script manifest
  backend/            Server-side Apps Script (.js)
  frontend/           HTML served by HtmlService
scripts/clasp-env.js  Environment-targeted push and deploy
```

## Setup

Requirements: Node.js 18+, and a Google account with the [Apps Script API](https://script.google.com/home/usersettings) enabled.

1. Install dependencies and sign in to clasp:
   ```
   npm install
   npm run login
   ```
2. Create two standalone Apps Script projects at [script.google.com](https://script.google.com), named for example `ChoreNest DEV` and `ChoreNest PROD`.
3. In each project, open **Project Settings → Script Properties** and add `ENVIRONMENT` with the value `DEV` or `PROD`.
4. Create the local config files from the example:
   ```
   cp .clasp.example.json .clasp.dev.json
   cp .clasp.example.json .clasp.prod.json
   ```
   Set `scriptId` in each file (from **Project Settings → IDs**). In `.clasp.prod.json`, set `"environment": "PROD"`.
5. Run your first deploy for each environment (see below). Copy the deployment ID it prints into that file's `deploymentId`, so future deploys keep the same web app URL.

The `.clasp.*.json` files and clasp credentials are gitignored. Never commit script IDs, deployment IDs or tokens.

## Commands

| Command               | Effect                                                         |
| --------------------- | -------------------------------------------------------------- |
| `npm run push:dev`    | Push `src/` to the DEV project (updates the `/dev` test URL).  |
| `npm run deploy:dev`  | Push to DEV and update the DEV web app deployment.             |
| `npm run deploy:prod` | Push to PROD and update the PROD deployment, after confirmation. |

## Environment isolation

- One source tree (`src/`) is pushed to two separate Apps Script projects. Code is never copied between them.
- Each project's `ENVIRONMENT` Script Property says which environment it is. If the property is missing or is anything other than `DEV` or `PROD`, the app serves a generic "not available" page and logs the error.
- DEV pages show a **DEV** badge.
- `scripts/clasp-env.js` passes the selected environment's config file straight to clasp. There is no shared `.clasp.json`, so a plain `clasp push` fails instead of picking a project.
- The script refuses to run if:
  - a config file's `environment` field doesn't match the command;
  - `rootDir` isn't `src`;
  - DEV and PROD share a script ID or deployment ID.

## Deployment

DEV changes are pushed and deployed freely during development.

PROD is promoted manually:

1. Verify the change on DEV.
2. Commit it. PROD deploys are refused if the working tree has uncommitted changes.
3. Run `npm run deploy:prod`. The script shows the target script ID, deployment ID and commit. Type `PROD` to continue. Nothing is pushed unless you type it.

Each deployment description records the environment and git commit, for example `PROD a1b2c3d`.
