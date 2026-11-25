// TEMPORARY editor-only wrappers for setup, diagnostics, onboarding, resolving an overdue turn, account provisioning and
// the reminder trigger.
// Every top-level function of a web app can be called from the browser, so these are only acceptable while the web
// app is private to its owner. Delete this file before opening the web app to anyone else: scripts/clasp-env.js
// refuses to push while it exists unless the manifest access is MYSELF, and never deploys it to PROD (see README,
// "Release and PROD maintenance").
// The helpers they call are owner-only and closed unless the MAINTENANCE_UNTIL window is open.
function setupDatabase() {
  return setupDatabase_();
}

function diagnoseDatabase() {
  return diagnoseDatabase_();
}

function onboardRoommate() {
  return onboardRoommate_();
}

function resolveOverdueTurn() {
  return resolveOverdueTurn_();
}

function createAccount() {
  return createAccount_();
}

function resetAccountPassword() {
  return resetAccountPassword_();
}

function previewFridayReminder() {
  return previewFridayReminder_();
}

function installFridayReminder() {
  return installFridayReminder_();
}

function removeFridayReminder() {
  return removeFridayReminder_();
}
