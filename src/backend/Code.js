function doGet() {
  let environment;
  try {
    environment = getEnvironment_();
  } catch (error) {
    // Fail closed: log the detail, show the visitor nothing about the configuration.
    console.error(error);
    return HtmlService.createHtmlOutput('<p>ChoreNest is not available.</p>').setTitle('ChoreNest');
  }

  const template = HtmlService.createTemplateFromFile('frontend/Index');
  template.environment = environment;
  return template
    .evaluate()
    .setTitle('ChoreNest')
    // HtmlService ignores viewport meta tags in the HTML itself.
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** Template helper that inlines another frontend file. The trailing underscore keeps it out of google.script.run. */
function include_(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}
