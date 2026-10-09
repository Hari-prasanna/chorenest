const ALLOWED_ENVIRONMENTS = ['DEV', 'PROD'];

/**
 * Returns the environment name from the ENVIRONMENT Script Property.
 * Throws if it is missing or not exactly DEV or PROD.
 */
function getEnvironment() {
  const value = PropertiesService.getScriptProperties().getProperty('ENVIRONMENT');
  if (ALLOWED_ENVIRONMENTS.indexOf(value) === -1) {
    throw appError_('CONFIG_INVALID', 'Invalid ENVIRONMENT Script Property: ' + JSON.stringify(value));
  }
  return value;
}

/** An Error with a stable `code` that the browser API can report. */
function appError_(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
