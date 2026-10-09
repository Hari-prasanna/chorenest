const ALLOWED_ENVIRONMENTS = ['DEV', 'PROD'];

/**
 * Returns the environment name from the ENVIRONMENT Script Property.
 * Throws if it is missing or not exactly DEV or PROD.
 */
function getEnvironment() {
  const value = PropertiesService.getScriptProperties().getProperty('ENVIRONMENT');
  if (ALLOWED_ENVIRONMENTS.indexOf(value) === -1) {
    throw new Error('Invalid ENVIRONMENT Script Property: ' + JSON.stringify(value));
  }
  return value;
}
