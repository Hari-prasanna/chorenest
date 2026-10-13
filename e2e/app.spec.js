const { test, expect } = require('@playwright/test');
const { openApp, calls, expectHealthyLayout, shot, schedule } = require('./support/page');
const { person } = require('./support/mock');

const HARI = { 'chorenest-beta-notice': 'dismissed', 'chorenest-roommate': 'id-Hari' };
const TABS = ['schedule', 'vacation', 'swaps', 'history'];
const panel = (page, name) => page.locator(`#panel-${name}`);
const tab = (page, name) => page.locator(`.tab[data-tab="${name}"]`);

test.describe('tab navigation', () => {
  test('switching tabs is instant, sends nothing, and replays no animation', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    await expect(page.locator('.hero')).toBeVisible();
    await page.waitForTimeout(700); // the first entrance animation finishes
    expect(await calls(page)).toHaveLength(1);

    for (const name of ['vacation', 'swaps', 'history', 'schedule', 'history', 'schedule']) {
      const timing = await page.evaluate(async (target) => {
        const start = performance.now();
        document.querySelector(`.tab[data-tab="${target}"]`).click();
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { ms: performance.now() - start, animating: document.getAnimations().map((a) => a.animationName || a.transitionProperty) };
      }, name);
      expect(timing.ms, `${name}: click to painted`).toBeLessThan(150);
      expect(timing.animating, `${name}: nothing animates after a switch`).toEqual([]);
      for (const other of TABS) {
        if (other === name) await expect(panel(page, other)).toBeVisible();
        else await expect(panel(page, other)).toBeHidden();
      }
      await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
      await expectHealthyLayout(page, `tab ${name}`);
    }
    expect(await calls(page), 'no backend calls from switching').toHaveLength(1);
    await shot(page, testInfo, 'schedule-light');
    expect(problems).toEqual([]);
  });

  test('swaps and history are honest work-in-progress pages', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    for (const [name, title] of [['swaps', 'Swaps'], ['history', 'History']]) {
      await tab(page, name).click();
      await expect(panel(page, name)).toContainText(title);
      await expect(panel(page, name)).toContainText('Work in progress');
      await expect(panel(page, name).locator('button, input, select, form, a')).toHaveCount(0);
      await expectHealthyLayout(page, name);
      await shot(page, testInfo, name);
    }
    expect(await calls(page)).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test('the Vacation tab opens the vacation dialog, which fits the screen', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { seed: HARI });
    await tab(page, 'vacation').click();
    await shot(page, testInfo, 'vacation-tab');
    await page.getByRole('button', { name: 'See and plan vacations' }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Trust-based for now');
    await expect(dialog).toContainText('Hari');
    const box = await dialog.boundingBox();
    const viewport = page.viewportSize();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    await shot(page, testInfo, 'vacation-dialog');
    expect(await calls(page, 'listVacations')).toHaveLength(1);
    expect(problems).toEqual([]);
  });

  test('coming back to a stale schedule fetches a fresh copy, a recent one does not', async ({ page }) => {
    await openApp(page);
    await expect(page.locator('.hero')).toBeVisible();
    await tab(page, 'history').click();
    await tab(page, 'schedule').click();
    expect(await calls(page, 'getRotationSchedule'), 'a recent schedule is kept').toHaveLength(1);

    await tab(page, 'history').click();
    await page.evaluate(() => {
      const real = Date.now;
      Date.now = () => real() + 6 * 60 * 1000;
    });
    await tab(page, 'schedule').click();
    await expect.poll(async () => (await calls(page, 'getRotationSchedule')).length).toBe(2);
    await expect(page.locator('.hero')).toBeVisible();
  });
});

test.describe('profile and Beta notice', () => {
  test('the first visit shows the Beta notice and badge; dismissing it sticks across reloads', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { seed: {} });
    await expect(page.locator('.beta-badge')).toHaveText('Beta');
    const notice = page.locator('#beta-notice');
    await expect(notice).toBeVisible();
    await expect(notice).toContainText('Some issues may take longer to fix while the admin is away');
    await expectHealthyLayout(page, 'beta notice');
    await shot(page, testInfo, 'beta-notice');

    await notice.getByRole('button', { name: 'Got it' }).click();
    await expect(notice).toBeHidden();
    await page.reload();
    await expect(page.locator('.hero')).toBeVisible();
    await expect(notice).toBeHidden();
    expect(problems).toEqual([]);
  });

  test('the profile entry is honest about identity, and its dialog works with mouse and keyboard', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    const profile = page.locator('#profile-button');
    await expect(profile).toContainText('Just looking');
    await expect(profile).toContainText('No name picked');
    await expect(profile).toHaveAttribute('aria-label', 'Profile: no name picked');

    await profile.click();
    const dialog = page.locator('#profile-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('It isn’t a login and it isn’t verified');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    await page.selectOption('#who-select', 'id-Hari');
    await expect(profile).toContainText('Hari');
    await expect(profile).toContainText('Not verified');
    await expect(profile).toHaveAttribute('aria-label', 'Profile: Hari, not verified');
    await profile.click();
    await expect(dialog).toContainText('Viewing as Hari');
    expect(await dialog.innerText()).not.toMatch(/logged in|log in|sign in|authenticated/i);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    await shot(page, testInfo, 'profile-dialog');

    await dialog.getByRole('button', { name: 'Change name' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'schedule')).toBeVisible();
    await expect(page.locator('#who-select')).toBeFocused();
    expect(await calls(page)).toHaveLength(1);
    expect(problems).toEqual([]);
  });
});

test.describe('themes', () => {
  test('Light, Dark and System apply, persist, and keep the layout healthy', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    const lightBackground = await background();

    await page.getByRole('button', { name: 'Dark' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expect.poll(background).not.toBe(lightBackground);
    await expectHealthyLayout(page, 'dark');
    await shot(page, testInfo, 'schedule-dark');
    await tab(page, 'swaps').click();
    await shot(page, testInfo, 'swaps-dark');

    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

    await page.getByRole('button', { name: 'System' }).click();
    await page.emulateMedia({ colorScheme: 'light' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    expect(problems).toEqual([]);
  });
});

test.describe('loading and error states', () => {
  test('a skeleton shows while loading, then the schedule', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { delay: 900 });
    await expect(page.locator('.skeleton-hero')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
    await expectHealthyLayout(page, 'loading');
    await shot(page, testInfo, 'loading');
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'false');
    expect(problems).toEqual([]);
  });

  test('a network failure offers Try again, which recovers', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { scheduleResponses: [{ __network: true }] });
    await expect(page.getByRole('heading', { name: 'Couldn’t reach the server' })).toBeVisible();
    await expectHealthyLayout(page, 'network error');
    await shot(page, testInfo, 'error-network');
    await tab(page, 'history').click();
    await tab(page, 'schedule').click();
    await expect(page.getByRole('heading', { name: 'Couldn’t reach the server' })).toBeVisible();
    await page.evaluate((ok) => {
      window.__mock.scheduleResponses = [ok];
    }, schedule());
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(page.locator('.hero')).toBeVisible();
    expect(await calls(page, 'getRotationSchedule')).toHaveLength(2);
    expect(problems.filter((p) => !/network/i.test(p))).toEqual([]);
  });

  test('a server problem shows a plain message and its code, never the server text', async ({ page }, testInfo) => {
    await openApp(page, { scheduleResponses: [{ ok: false, error: { code: 'DATABASE_NOT_SET_UP', message: 'Secret server detail' } }] });
    await expect(page.getByRole('heading', { name: 'ChoreNest isn’t set up correctly' })).toBeVisible();
    await expect(page.locator('#app')).toContainText('DATABASE_NOT_SET_UP');
    await expect(page.locator('body')).not.toContainText('Secret server detail');
    await expectHealthyLayout(page, 'config error');
    await shot(page, testInfo, 'error-config');
  });
});

test.describe('cleaning confirmation', () => {
  test('only the picked roommate on their open turn can mark it, after a confirmation', async ({ page }, testInfo) => {
    const next = schedule({ current: { ...schedule().upcoming[0], status: 'pending' }, upcoming: [schedule().upcoming[1], schedule().upcoming[2], schedule().upcoming[0]] });
    const { problems } = await openApp(page, { seed: HARI, scheduleResponses: [schedule(), next] });
    const mark = page.getByRole('button', { name: /Mark as cleaned/ });
    await expect(mark).toBeVisible();
    await mark.scrollIntoViewIfNeeded();
    const reachable = await mark.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return button.contains(top);
    });
    expect(reachable, 'the bottom bar never covers the button').toBe(true);

    await mark.click();
    const dialog = page.locator('#confirm-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Mark Entire Home as cleaned?');
    const box = await dialog.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    await shot(page, testInfo, 'confirm-dialog');
    await dialog.getByRole('button', { name: 'Not yet' }).click();
    await expect(dialog).toBeHidden();
    expect(await calls(page, 'markCleaned'), 'Not yet sends nothing').toHaveLength(0);

    await mark.click();
    await dialog.getByRole('button', { name: /Yes, it’s clean/ }).click();
    await expect(page.locator('.notice-success')).toContainText('Nice work, Hari!');
    const sent = await calls(page, 'markCleaned');
    expect(sent).toHaveLength(1);
    expect(sent[0].args).toEqual([{ roommate_id: 'id-Hari', rotation_id: 'slot-Hari', due_at: schedule().current.due_at }]);
    expect(await calls(page, 'getRotationSchedule'), 'the schedule is refreshed after saving').toHaveLength(2);
    await expect(page.locator('.hero')).toContainText('Jijo');
    await expect(mark).toHaveCount(0);
    await shot(page, testInfo, 'cleaned');
    expect(problems).toEqual([]);
  });

  test('nobody sees the button without picking a name, or on someone else’s turn', async ({ page }) => {
    await openApp(page);
    await expect(page.getByRole('button', { name: /Mark as cleaned/ })).toHaveCount(0);
    await page.selectOption('#who-select', 'id-Jijo');
    await expect(page.getByRole('button', { name: /Mark as cleaned/ })).toHaveCount(0);
    await page.selectOption('#who-select', 'id-Hari');
    await expect(page.getByRole('button', { name: /Mark as cleaned/ })).toBeVisible();
    expect(await calls(page, 'markCleaned')).toHaveLength(0);
  });

  test('long names and many roommates keep the layout healthy', async ({ page }, testInfo) => {
    const long = 'Bartholomew-Maximilian Featherstonehaugh-Wolfeschlegelsteinhausen';
    const roommates = [person('Arun'), person(long), person('Jijo')];
    const turn = (name, n) => ({ ...schedule().upcoming[0], owner: person(name), assignee: person(name), rotation_id: `slot-${name}`, weekend_starts_at: schedule().upcoming[0].weekend_starts_at, due_at: schedule().upcoming[0].due_at, n });
    await openApp(page, {
      seed: { 'chorenest-beta-notice': 'dismissed', 'chorenest-roommate': `id-${long}` },
      scheduleResponses: [schedule({ current: { ...turn(long), status: 'overdue' }, upcoming: [turn('Arun'), turn(long), turn('Jijo')], roommates })],
    });
    await expect(page.locator('.hero')).toContainText(long);
    await expectHealthyLayout(page, 'long name');
    await shot(page, testInfo, 'long-name');
  });
});
