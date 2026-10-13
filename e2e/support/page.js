const fs = require('node:fs');
const path = require('node:path');
const { expect } = require('@playwright/test');
const { installMock, schedule, vacations } = require('./mock');

const SHOTS = path.join(__dirname, '..', 'results', 'screenshots');

/** Opens the app with a mocked backend. `seed` sets localStorage values only if they are not there yet. */
async function openApp(page, { seed = { 'chorenest-beta-notice': 'dismissed' }, query = '', ...mock } = {}) {
  const problems = [];
  page.on('console', (message) => {
    if (message.type() === 'error' || message.type() === 'warning') problems.push(`console ${message.type()}: ${message.text()}`);
  });
  page.on('pageerror', (error) => problems.push(`page error: ${error.message}`));
  await installMock(page, { scheduleResponses: [schedule()], vacationsResponse: vacations(), ...mock });
  await page.addInitScript((values) => {
    for (const [key, value] of Object.entries(values)) if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
  }, seed);
  await page.goto(`/${query}`);
  return { problems };
}

const calls = (page, name) => page.evaluate((wanted) => window.__calls.filter((call) => !wanted || call.name === wanted), name);

/**
 * Layout health at the current size: no sideways scrolling, the section bar is visible and reachable, nothing in the
 * header or bar overlaps, and the end of the page is not hidden behind the bar.
 */
async function expectHealthyLayout(page, label) {
  const report = await page.evaluate(() => {
    const box = (element) => {
      const r = element.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height };
    };
    const visible = (element) => element.getClientRects().length > 0;
    const overlap = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const doc = document.documentElement;
    const viewport = { width: doc.clientWidth, height: window.innerHeight };
    const tabs = Array.from(document.querySelectorAll('.tab')).map(box);
    const bar = box(document.getElementById('tabs'));
    const header = ['.brand', '.top-actions'].map((selector) => box(document.querySelector(selector)));
    const clipped = Array.from(document.querySelectorAll('.top *, .tabs *, main *, .beta-notice *'))
      .filter((element) => visible(element) && element.getBoundingClientRect().right > viewport.width + 1)
      .map((element) => element.className || element.tagName);
    const lastBlock = Array.from(document.querySelectorAll('main > div:not([hidden]) > *, main > div:not([hidden]) .layout > *')).filter(visible).pop();
    window.scrollTo(0, document.body.scrollHeight);
    const last = lastBlock ? box(lastBlock) : null;
    const covered = last && bar.top > 0 && last.bottom > bar.top + 1 && getComputedStyle(document.getElementById('tabs')).position === 'fixed';
    window.scrollTo(0, 0);
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      viewport,
      bar,
      barPosition: getComputedStyle(document.getElementById('tabs')).position,
      tabsInside: tabs.every((t) => t.left >= -0.5 && t.right <= viewport.width + 0.5 && t.top >= -0.5 && t.bottom <= viewport.height + 0.5),
      tabsApart: tabs.every((t, i) => tabs.every((u, j) => i === j || !overlap(t, u))),
      tabHeights: tabs.map((t) => Math.round(t.height)),
      headerApart: !overlap(header[0], header[1]),
      clipped,
      covered: Boolean(covered),
    };
  });
  const where = `${label} @ ${report.viewport.width}px`;
  expect(report.overflowX, `${where}: horizontal overflow (past right edge: ${report.clipped.join(", ")})`).toBeLessThanOrEqual(0);
  expect(report.clipped, `${where}: elements past the right edge`).toEqual([]);
  expect(report.tabsInside, `${where}: section bar inside the viewport`).toBe(true);
  expect(report.tabsApart, `${where}: tabs overlap`).toBe(true);
  expect(report.headerApart, `${where}: brand and actions overlap`).toBe(true);
  expect(report.covered, `${where}: end of page hidden behind the bar`).toBe(false);
  if (report.viewport.width < 760) {
    expect(report.barPosition).toBe('fixed');
    expect(Math.round(report.bar.bottom), `${where}: bar sits at the bottom edge`).toBe(report.viewport.height);
    for (const height of report.tabHeights) expect(height, `${where}: tap target height`).toBeGreaterThanOrEqual(44);
  } else {
    expect(report.barPosition).toBe('static');
  }
}

async function shot(page, testInfo, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: path.join(SHOTS, `${testInfo.project.name}-${name}.png`) });
}

module.exports = { openApp, calls, expectHealthyLayout, shot, schedule, vacations };
