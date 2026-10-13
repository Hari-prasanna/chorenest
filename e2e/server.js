// Serves the real frontend files for local browser tests: it fills in the Apps Script template tags and nothing else.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const SRC = path.join(__dirname, '..', 'src');
const PORT = Number(process.env.E2E_PORT || 4173);

// doGet adds the title and the viewport tag through HtmlService; the same two are added here.
const HEAD = '<title>ChoreNest</title><meta name="viewport" content="width=device-width, initial-scale=1">';

function render(environment) {
  let page = fs.readFileSync(path.join(SRC, 'frontend', 'Index.html'), 'utf8');
  page = page.replace(/<\?!= include_\('([^']+)'\) \?>/g, (_, name) => fs.readFileSync(path.join(SRC, `${name}.html`), 'utf8'));
  page = page.replace('<head>', `<head>${HEAD}`);
  return page.replace(/<\? if \(environment === 'DEV'\) \{ \?>([\s\S]*?)<\? \} \?>/g, (_, inner) => (environment === 'DEV' ? inner : ''));
}

http
  .createServer((request, response) => {
    const url = new URL(request.url, `http://localhost:${PORT}`);
    if (url.pathname !== '/') {
      response.writeHead(url.pathname === '/favicon.ico' ? 204 : 404).end(); // browsers ask for an icon; the real page sets its own
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(render(url.searchParams.get('env') === 'PROD' ? 'PROD' : 'DEV'));
  })
  .listen(PORT, '127.0.0.1');
