const { test, expect } = require('@playwright/test');
const { openApp, calls, expectHealthyLayout, shot, schedule, vacations } = require('./support/page');
const { person } = require('./support/mock');

// Signed in as Hari, whose turn is current in the mocked schedule.
const HARI = 'Hari';
const TABS = ['schedule', 'vacation', 'swaps', 'history'];
// A loaded page has asked for the schedule, then once for the household vacations.
const LOADED = ['getRotationSchedule', 'listVacations'];
const callNames = async (page) => (await calls(page)).map((call) => call.name);
const panel = (page, name) => page.locator(`#panel-${name}`);
const tab = (page, name) => page.locator(`.tab[data-tab="${name}"]`);

test.describe('tab navigation', () => {
  test('switching tabs is instant, sends nothing, and replays no animation', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    await expect(page.locator('.hero')).toBeVisible();
    await page.waitForTimeout(700); // the first entrance animation finishes
    await expect.poll(() => callNames(page)).toEqual(LOADED);

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
    expect(await callNames(page), 'switching only loads Swaps and History, once each').toEqual([...LOADED, 'listSwaps', 'listCleaningHistory']);
    await shot(page, testInfo, 'schedule-default');
    expect(problems).toEqual([]);
  });

  // Regression: DEV v19 read event.target, so a tap on a tab's icon or label (or on the broom inside "Mark as cleaned")
  // did nothing, and coming back to Schedule replayed the entrance animation.
  test('a real tap on a tab\'s icon or label switches, and Mark as cleaned opens the dialog', async ({ page }) => {
    const { problems } = await openApp(page, { as: HARI });
    await expect(page.locator('.hero')).toBeVisible();
    await page.waitForTimeout(700); // the first entrance animation finishes
    for (const name of ['vacation', 'swaps', 'history', 'schedule']) {
      for (const part of ['.tab-icon', 'span:not(.tab-icon)']) {
        const inner = tab(page, 'schedule' === name ? 'history' : 'schedule').locator(part);
        await inner.click(); // leave first, so every tap below is a real switch
        await tab(page, name).locator(part).click();
        await expect(panel(page, name), `${name} via ${part}`).toBeVisible();
        await expect(tab(page, name)).toHaveAttribute('aria-current', 'page');
      }
    }
    await tab(page, 'history').locator('.tab-icon').click();
    await tab(page, 'schedule').locator('.tab-icon').click();
    const animating = await page.evaluate(() => document.getAnimations().map((a) => a.animationName || a.transitionProperty));
    expect(animating, 'returning to Schedule replays no entrance animation').toEqual([]);

    await page.locator('.mark-button').click();
    await expect(page.locator('#confirm-dialog')).toBeVisible();
    expect(await calls(page, 'getRotationSchedule'), 'tapping tabs sends nothing').toHaveLength(1);
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

test.describe('household vacations', () => {
  const card = (page, name) => panel(page, 'vacation').locator('.vacation-card', { hasText: name });

  test('the Vacation tab shows every roommate’s vacation inline, grouped as Away now, Upcoming and Recently back', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await tab(page, 'vacation').click();
    const overview = panel(page, 'vacation');
    await expect(overview.getByRole('heading', { name: 'Vacations' })).toBeVisible();
    await expect(page.locator('#vacation-dialog')).toBeHidden();
    for (const [heading, name, status] of [['Away now', 'Arun', 'Away now'], ['Upcoming', 'Hari', 'Upcoming'], ['Recently back', 'Jijo', 'Returned']]) {
      await expect(overview.getByRole('heading', { name: heading })).toBeVisible();
      await expect(card(page, name).locator('.badge')).toHaveText(status);
      await expect(card(page, name)).toContainText('First day away');
      await expect(card(page, name)).toContainText('First day back');
    }
    // The cleaning impact is folded away until asked for.
    await expect(card(page, 'Arun').locator('.chip')).toBeHidden();
    await card(page, 'Arun').getByText('Cleaning impact').click();
    await expect(card(page, 'Arun').locator('.chip')).toBeVisible();
    await expect(card(page, 'Arun').locator('.chip')).toContainText('Turn skipped');
    await card(page, 'Arun').getByText('Cleaning impact').click();
    await expect(card(page, 'Arun').locator('.chip')).toBeHidden();
    await expect(card(page, 'Jijo').locator('summary')).toHaveText('Cleaning impact');

    // Only Hari's own upcoming vacation has actions: Edit dates and Delete.
    await expect(card(page, 'Arun').locator('button')).toHaveCount(0);
    await expect(card(page, 'Jijo').locator('button')).toHaveCount(0);
    await expect(card(page, 'Hari').getByRole('button', { name: 'Delete vacation' })).toBeEnabled();
    await expect(card(page, 'Hari').getByRole('button', { name: 'Edit dates' })).toBeEnabled();
    await expect(overview.getByRole('button', { name: /Plan vacation/ })).toBeVisible();

    const columns = await overview.locator('.vacation-grid').first().evaluate((grid) => getComputedStyle(grid).gridTemplateColumns.split(' ').length);
    expect(columns, 'two columns of cards on wide screens, one on phones').toBe(page.viewportSize().width >= 760 ? 2 : 1);
    await expectHealthyLayout(page, 'vacation overview');
    await shot(page, testInfo, 'vacation-tab');
    expect(await callNames(page)).toEqual(LOADED);
    expect(problems).toEqual([]);
  });

  test('"Who’s away" sits under the current turn with real vacation data, and the turn itself is unchanged', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    const hero = page.locator('.hero');
    const away = page.locator('.away-card');
    await expect(away).toContainText('Arun');
    await expect(away).toContainText('Away · back');
    await expect(away).toContainText('Hari');
    await expect(away).toContainText('Leaves');
    await expect(away).not.toContainText('Jijo');
    await expect(hero).toContainText('Hari');
    await expect(hero).toContainText('Pending');
    const [heroBox, awayBox] = [await hero.boundingBox(), await away.boundingBox()];
    expect(awayBox.y, 'the current cleaner comes first').toBeGreaterThan(heroBox.y + heroBox.height - 1);

    // On a phone the cleaner, the dates and the button fit on the first screen, above the bottom bar.
    const mark = page.getByRole('button', { name: /Mark as cleaned/ });
    const markBox = await mark.boundingBox();
    const barTop = (await page.locator('#tabs').boundingBox()).y;
    expect(markBox.y + markBox.height, 'Mark as cleaned is visible without scrolling').toBeLessThanOrEqual(page.viewportSize().width < 760 ? barTop : page.viewportSize().height);
    await expectHealthyLayout(page, 'schedule with who is away');
    await shot(page, testInfo, 'schedule-away');
    expect(problems).toEqual([]);
  });

  test('every signed-in roommate can plan a vacation; there is no name picker anywhere', async ({ page }) => {
    const { problems } = await openApp(page); // Jijo, whose turn it is not
    await expect(page.locator('#who-select')).toHaveCount(0);
    await expect(page.getByText(/Pick your name|Not verified|Just looking/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Mark as cleaned/ })).toHaveCount(0);
    await tab(page, 'vacation').click();
    await expect(panel(page, 'vacation').getByRole('button', { name: /Plan vacation/ })).toBeVisible();
    for (const call of await calls(page)) expect(JSON.stringify(call.args)).not.toContain('roommate_id');
    expect(problems).toEqual([]);
  });

  test('Plan vacation opens a focused form that fits the screen, and the overview confirms the save', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await tab(page, 'vacation').click();
    await panel(page, 'vacation').getByRole('button', { name: /Plan vacation/ }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('heading', { name: 'Plan a vacation for Hari' })).toBeVisible();
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
    await shot(page, testInfo, 'vacation-form');

    await dialog.getByRole('button', { name: 'Save vacation' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Pick both dates.');
    await page.fill('#vacation-start', '2027-03-01');
    await page.fill('#vacation-return', '2027-03-08');
    await dialog.getByRole('button', { name: 'Save vacation' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'vacation').locator('.notice-success')).toContainText('Vacation saved.');
    const saved = (await calls(page, 'saveVacation')).map((call) => call.args);
    expect(saved).toEqual([[{ token: 'token-Hari', start_date: '2027-03-01', return_date: '2027-03-08' }]]);
    await expect.poll(() => callNames(page)).toEqual([...LOADED, 'saveVacation', 'getRotationSchedule', 'listVacations']);
    await expectHealthyLayout(page, 'after saving a vacation');
    expect(problems).toEqual([]);
  });

  test('a vacation load failure is explained on the tab and on the schedule, and Try again recovers', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI, vacationsResponse: { ok: false, error: { code: 'DATABASE_NOT_SET_UP', message: 'Secret server detail' } } });
    await expect(page.locator('.away-card')).toContainText('Couldn’t load vacations.');
    await expect(page.locator('.hero')).toContainText('Hari');
    await tab(page, 'vacation').click();
    await expect(panel(page, 'vacation').getByRole('heading', { name: 'Couldn’t load vacations' })).toBeVisible();
    await expect(page.locator('body')).not.toContainText('Secret server detail');
    await expectHealthyLayout(page, 'vacation error');
    await shot(page, testInfo, 'vacation-error');

    await page.evaluate((good) => {
      window.__mock.vacationsResponse = good;
    }, vacations());
    await panel(page, 'vacation').getByRole('button', { name: 'Try again' }).click();
    await expect(card(page, 'Arun')).toBeVisible();
    await tab(page, 'schedule').click();
    await expect(page.locator('.away-card')).toContainText('Arun');
    expect(problems).toEqual([]);
  });

  test('a network failure while loading vacations asks to check the connection', async ({ page }) => {
    await openApp(page, { as: HARI, vacationsResponse: { __network: true } });
    await tab(page, 'vacation').click();
    await expect(panel(page, 'vacation')).toContainText('Check your connection and try again.');
    await expect(panel(page, 'vacation').getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('changing a vacation', () => {
  const card = (page, name) => panel(page, 'vacation').locator('.vacation-card', { hasText: name });
  const ARUN = 'Arun';
  const berlinDate = (iso) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(iso));
  const listed = (page, id) => page.evaluate((wanted) => window.__mock.vacationsResponse.vacations.find((v) => v.vacation_id === wanted), id);

  test('Edit dates opens a filled form; saving refreshes the overview and the schedule without blanking it', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await tab(page, 'vacation').click();
    const hari = await listed(page, 'v1');
    await card(page, 'Hari').getByRole('button', { name: 'Edit dates' }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog.getByRole('heading', { name: 'Change your vacation dates' })).toBeVisible();
    await expect(page.locator('#vacation-start')).toHaveValue(berlinDate(hari.start_date));
    await expect(page.locator('#vacation-return')).toHaveValue(berlinDate(hari.return_date));
    const box = await dialog.boundingBox();
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize().height);
    await shot(page, testInfo, 'vacation-edit');

    await page.evaluate(() => {
      window.__mock.delay = 400; // slow answers, so the refresh can be watched
    });
    await page.fill('#vacation-start', '2027-04-01');
    await page.fill('#vacation-return', '2027-04-06');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await tab(page, 'schedule').click();
    await expect.poll(() => callNames(page)).toEqual([...LOADED, 'updateVacation', 'getRotationSchedule', 'listVacations']);
    await expect(page.locator('.skeleton-hero'), 'the schedule is never replaced by a loading state').toHaveCount(0);
    await expect(page.locator('.hero')).toBeVisible();
    const [sent] = (await calls(page, 'updateVacation')).map((call) => call.args[0]);
    expect(sent).toEqual({ token: 'token-Hari', vacation_id: 'v1', start_date: '2027-04-01', return_date: '2027-04-06', seen_start: hari.start_date, seen_return: hari.return_date });
    await tab(page, 'vacation').click();
    await expect(panel(page, 'vacation').locator('.notice-success')).toContainText('Vacation dates updated.');
    expect(problems).toEqual([]);
  });

  test('a started vacation keeps its first day away, and I’m back ends it today after a confirmation', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: ARUN });
    await tab(page, 'vacation').click();
    const arun = card(page, 'Arun');
    await expect(arun.getByRole('button', { name: 'Delete vacation' }), 'it already skipped a turn').toHaveCount(0);
    await arun.getByRole('button', { name: 'Edit dates' }).click();
    await expect(page.locator('#vacation-start')).toBeDisabled();
    await expect(page.locator('#vacation-dialog')).toContainText('Your vacation has started, so the first day away stays.');
    await page.locator('#vacation-dialog').getByRole('button', { name: 'Not now' }).click();

    await arun.getByRole('button', { name: 'I’m back' }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog.getByRole('heading', { name: 'Back already?' })).toBeVisible();
    await expect(dialog).toContainText('becomes your first day back');
    await expect(dialog.getByRole('button', { name: 'Not yet' })).toBeFocused();
    await shot(page, testInfo, 'vacation-end');
    await dialog.getByRole('button', { name: 'Yes, I’m back' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'vacation').locator('.notice-success')).toContainText('Welcome back! Today is your first day back.');
    const arunRow = await listed(page, 'v-arun');
    expect((await calls(page, 'endVacation')).map((call) => call.args)).toEqual([[{ token: 'token-Arun', vacation_id: 'v-arun', seen_start: arunRow.start_date, seen_return: arunRow.return_date }]]);
    await expect.poll(() => callNames(page)).toEqual([...LOADED, 'endVacation', 'getRotationSchedule', 'listVacations']);
    expect(problems).toEqual([]);
  });

  test('Delete asks first with Keep it focused, sends only the vacation, and a refusal is explained', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await tab(page, 'vacation').click();
    await card(page, 'Hari').getByRole('button', { name: 'Delete vacation' }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog.getByRole('heading', { name: 'Delete this vacation?' })).toBeVisible();
    await expect(dialog).toContainText('Your turns in that time count again.');
    await expect(dialog.getByRole('button', { name: 'Keep it' })).toBeFocused();
    await shot(page, testInfo, 'vacation-delete');
    await dialog.getByRole('button', { name: 'Keep it' }).click();
    await expect(dialog).toBeHidden();
    expect(await callNames(page), 'keeping it sends nothing').toEqual(LOADED);

    await card(page, 'Hari').getByRole('button', { name: 'Delete vacation' }).click();
    await dialog.getByRole('button', { name: 'Delete vacation' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'vacation').locator('.notice-success')).toContainText('Vacation deleted.');
    expect((await calls(page, 'cancelVacation')).map((call) => call.args)).toEqual([[{ token: 'token-Hari', vacation_id: 'v1' }]]);

    await page.evaluate(() => {
      window.__mock.responses.cancelVacation = { ok: false, error: { code: 'VACATION_IN_USE', message: 'Secret detail' } };
    });
    await card(page, 'Hari').getByRole('button', { name: 'Delete vacation' }).click();
    await dialog.getByRole('button', { name: 'Delete vacation' }).click();
    await expect(panel(page, 'vacation').locator('.notice-error')).toHaveText('This vacation already skipped a turn, so it stays on record and can’t be deleted.');
    await expect(page.locator('body')).not.toContainText('Secret detail');
    await expectHealthyLayout(page, 'after a refused delete');
    expect(problems).toEqual([]);
  });

  test('a conflict with the current turn is explained in the form; a stale page reloads the list', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI, responses: { updateVacation: { ok: false, error: { code: 'VACATION_TURN_CONFLICT', message: 'Secret detail' } } } });
    await tab(page, 'vacation').click();
    await card(page, 'Hari').getByRole('button', { name: 'Edit dates' }).click();
    const dialog = page.locator('#vacation-dialog');
    await page.fill('#vacation-start', '2027-04-01');
    await page.fill('#vacation-return', '2027-04-06');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('This change would affect the current cleaning turn, so it can’t be made here. Ask the app owner to sort it out.');
    await expect(page.locator('#vacation-start')).toHaveValue('2027-04-01');
    await expect(page.locator('body')).not.toContainText('Secret detail');
    await shot(page, testInfo, 'vacation-conflict');

    await page.evaluate(() => {
      window.__mock.responses.updateVacation = { ok: false, error: { code: 'VACATION_CHANGED' } };
    });
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'vacation').locator('.notice-error')).toHaveText('This vacation changed since you loaded it. Here’s the latest.');
    expect((await callNames(page)).slice(-1)).toEqual(['listVacations']);
    await expectHealthyLayout(page, 'after a stale edit');
    expect(problems).toEqual([]);
  });

  test('I’m back that would change a processed turn is explained in the dialog, and nothing changes', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: 'Arun', responses: { endVacation: { ok: false, error: { code: 'VACATION_SKIP_RECORDED' } } } });
    await tab(page, 'vacation').click();
    await card(page, 'Arun').getByRole('button', { name: 'I’m back' }).click();
    const dialog = page.locator('#vacation-dialog');
    await expect(dialog).toContainText('Turns that are already done or skipped stay as they are.');
    await dialog.getByRole('button', { name: 'Yes, I’m back' }).click();
    await expect(dialog.getByRole('heading', { name: 'Your vacation wasn’t changed' })).toBeVisible();
    await expect(dialog.getByRole('alert')).toHaveText('A turn was already skipped for this vacation, and the new dates no longer cover it. Ask the app owner to change it.');
    await expect(dialog.getByRole('button', { name: 'OK' })).toBeFocused();
    await shot(page, testInfo, 'vacation-end-refused');
    await dialog.getByRole('button', { name: 'OK' }).click();
    await expect(dialog).toBeHidden();
    expect(await callNames(page)).toEqual([...LOADED, 'endVacation'], 'nothing is reloaded, because nothing changed');
    expect(problems).toEqual([]);
  });

  test('impossible dates are caught before anything is sent', async ({ page }) => {
    await openApp(page, { as: HARI });
    await tab(page, 'vacation').click();
    await card(page, 'Hari').getByRole('button', { name: 'Edit dates' }).click();
    const dialog = page.locator('#vacation-dialog');
    await page.fill('#vacation-start', '2027-04-06');
    await page.fill('#vacation-return', '2027-04-06');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('The first day back must be after the first day away.');
    await page.fill('#vacation-return', '');
    await dialog.getByRole('button', { name: 'Save changes' }).click();
    await expect(dialog.getByRole('alert')).toHaveText('Pick both dates.');
    expect(await calls(page, 'updateVacation')).toEqual([]);
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

  test('the profile shows the signed-in name and role from the server, and survives a reload', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    const profile = page.locator('#profile-button');
    await expect(profile).toContainText('Hari');
    await expect(profile).toContainText('Admin');
    await expect(profile).toHaveAttribute('aria-label', 'Profile: Hari, Admin');

    await profile.click();
    const dialog = page.locator('#profile-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.badge-role')).toHaveText('Admin');
    await expect(dialog).toContainText('Signed in');
    await expect(dialog.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Close' })).toBeFocused();
    await expect(dialog.locator('select')).toHaveCount(0);
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width);
    await shot(page, testInfo, 'profile-dialog');

    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    await page.reload();
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('#auth-screen')).toBeHidden();
    await expect(profile).toContainText('Hari');
    expect(await callNames(page)).toEqual(LOADED);
    expect(problems).toEqual([]);
  });

  test('Coming up shows the next three distinct turns, not the current one; the current cleaner may return on a later weekend', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    const items = page.locator('.timeline-item');
    await expect(items).toHaveCount(3);
    await expect(items.nth(0)).toContainText('Jijo');
    await expect(items.nth(1)).toContainText('Arun');
    await expect(items.nth(2)).toContainText('Hari');
    const weekends = await items.locator('.when').allInnerTexts();
    expect(new Set(weekends).size, 'three different weekends').toBe(3);
    const current = await page.locator('.hero .facts dd').first().innerText();
    expect(weekends, 'the current weekend is not listed again').not.toContain(current);
    await expect(page.locator('.hero')).toContainText('Hari');
    await expect(page.locator('.hero .note')).toHaveCount(0);
    await expect(page.getByText('Your next turn')).toHaveCount(0);
    await expectHealthyLayout(page, 'schedule with three coming up');
    await shot(page, testInfo, 'schedule-no-repeat');
    expect(problems).toEqual([]);
  });
});

test.describe('themes', () => {
  test('a first visit is Dark; Light, Dark and System apply, persist, and keep the layout healthy', async ({ page }, testInfo) => {
    await page.emulateMedia({ colorScheme: 'light' });
    const { problems } = await openApp(page);
    await expect(page.locator('html'), 'Dark even on a light system').toHaveAttribute('data-theme', 'dark');
    await expect(page.getByRole('button', { name: 'Dark' })).toHaveAttribute('aria-pressed', 'true');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

    await page.getByRole('button', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    const lightBackground = await background();
    await expectHealthyLayout(page, 'light');
    await shot(page, testInfo, 'schedule-light');
    await page.reload();
    await expect(page.locator('html'), 'a saved Light wins over the default').toHaveAttribute('data-theme', 'light');

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
    const { problems } = await openApp(page, { hold: true });
    await expect(page.locator('.skeleton-hero')).toBeVisible();
    await expect(page.locator('#app')).toHaveAttribute('aria-busy', 'true');
    await expectHealthyLayout(page, 'loading');
    await shot(page, testInfo, 'loading');
    await page.evaluate(() => window.__mock.release());
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
    const { problems } = await openApp(page, { as: HARI, scheduleResponses: [schedule(), next] });
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
    expect(sent[0].args).toEqual([{ token: 'token-Hari', rotation_id: 'slot-Hari', due_at: schedule().current.due_at }]);
    expect(await calls(page, 'getRotationSchedule'), 'the schedule is refreshed after saving').toHaveLength(2);
    await expect(page.locator('.hero')).toContainText('Jijo');
    await expect(mark).toHaveCount(0);
    await shot(page, testInfo, 'cleaned');
    expect(problems).toEqual([]);
  });

  test('another roommate does not see the button on Hari’s turn', async ({ page }) => {
    await openApp(page); // Jijo
    await expect(page.locator('.hero')).toContainText('Hari');
    await expect(page.getByRole('button', { name: /Mark as cleaned/ })).toHaveCount(0);
    expect(await calls(page, 'markCleaned')).toHaveLength(0);
  });

  test('long names and many roommates keep the layout healthy', async ({ page }, testInfo) => {
    const long = 'Bartholomew-Maximilian Featherstonehaugh-Wolfeschlegelsteinhausen';
    const roommates = [person('Arun'), person(long), person('Jijo')];
    const turn = (name, n) => ({ ...schedule().upcoming[0], owner: person(name), assignee: person(name), rotation_id: `slot-${name}`, weekend_starts_at: schedule().upcoming[0].weekend_starts_at, due_at: schedule().upcoming[0].due_at, n });
    await openApp(page, {
      as: long,
      scheduleResponses: [schedule({ current: { ...turn(long), status: 'overdue' }, upcoming: [turn('Arun'), turn(long), turn('Jijo')], roommates })],
    });
    await expect(page.locator('.hero')).toContainText(long);
    await expectHealthyLayout(page, 'long name');
    await shot(page, testInfo, 'long-name');
  });
});

// Sign-in, the first password, sessions and sign-out

/** The sign-in card fits the screen without sideways scrolling, and its controls are large enough to tap. */
async function expectHealthyAuthLayout(page, label) {
  const report = await page.evaluate(() => {
    const doc = document.documentElement;
    const card = document.querySelector('.auth-card').getBoundingClientRect();
    const controls = Array.from(document.querySelectorAll('.auth-card input, .auth-card button')).map((element) => element.getBoundingClientRect());
    return {
      overflowX: doc.scrollWidth - doc.clientWidth,
      cardInside: card.left >= 0 && card.right <= doc.clientWidth + 0.5,
      smallestControl: Math.min(...controls.map((r) => r.height)),
      tabsHidden: document.getElementById('tabs').hidden,
      mainHidden: document.getElementById('main-content').hidden,
    };
  });
  expect(report.overflowX, `${label}: no sideways scrolling`).toBeLessThanOrEqual(0);
  expect(report.cardInside, `${label}: card inside the screen`).toBe(true);
  expect(report.smallestControl, `${label}: tap targets`).toBeGreaterThanOrEqual(36);
  expect(report.tabsHidden && report.mainHidden, `${label}: no household data or navigation before sign-in`).toBe(true);
}

test.describe('sign in and sessions', () => {
  test('signed out: only the sign-in card shows, in every theme, and nothing is loaded', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: null });
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    await expect(page.getByLabel('Username')).toBeFocused();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#profile-button')).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectHealthyAuthLayout(page, 'sign-in dark');
    await shot(page, testInfo, 'sign-in-dark');
    await page.locator('#theme-toggle button[data-choice="light"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expectHealthyAuthLayout(page, 'sign-in light');
    await shot(page, testInfo, 'sign-in-light');
    expect(await calls(page)).toEqual([]);
    expect(problems).toEqual([]);
  });

  test('the password can be shown and hidden, by mouse and keyboard', async ({ page }) => {
    await openApp(page, { as: null });
    const password = page.locator('#sign-in-password');
    const toggle = page.getByRole('button', { name: 'Show password' });
    await password.fill('secret words here');
    await expect(password).toHaveAttribute('type', 'password');
    await toggle.click();
    await expect(password).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: 'Hide password' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Hide password' }).press('Enter');
    await expect(password).toHaveAttribute('type', 'password');
  });

  test('signing in shows clear progress while the password is checked, then opens the app with the session', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: null, hold: true });
    await page.getByLabel('Username').fill('hari');
    await page.getByLabel('Password', { exact: true }).fill('a long enough passphrase');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('status')).toContainText('Checking your password');
    await expect(page.getByRole('button', { name: 'Signing in…' })).toBeDisabled();
    await expect(page.getByLabel('Username')).toBeDisabled();
    await expectHealthyAuthLayout(page, 'signing in');
    await shot(page, testInfo, 'sign-in-busy');
    await page.evaluate(() => window.__mock.release());
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('#profile-button')).toContainText('Hari');
    const all = await calls(page);
    expect(all.map((call) => call.name)).toEqual(['signIn', ...LOADED]);
    expect(all[0].args[0]).toEqual({ username: 'hari', password: 'a long enough passphrase' });
    expect(all[1].args[0]).toEqual({ token: 'token-hari' });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chorenest-session')).token)).toBe('token-hari');
    expect(problems).toEqual([]);
  });

  test('a wrong password says so in plain words, keeps the username and clears the password', async ({ page }) => {
    await openApp(page, { as: null, responses: { signIn: { ok: false, error: { code: 'LOGIN_FAILED', message: 'Server detail' } } } });
    await page.getByLabel('Username').fill('hari');
    await page.getByLabel('Password', { exact: true }).fill('not the password');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toContainText('Check your username and password');
    await expect(page.getByText('Server detail')).toHaveCount(0);
    await expect(page.getByLabel('Username')).toHaveValue('hari');
    await expect(page.locator('#sign-in-password')).toHaveValue('');
    await expect(page.locator('#sign-in-password')).toBeFocused();
    await expect(page.locator('#tabs')).toBeHidden();
  });

  test('a temporary password leads to a required password change before anything else', async ({ page }, testInfo) => {
    const firstLogin = { ok: true, session: { token: 'token-temp', expires_at: '2099-01-01T00:00:00.000Z' }, viewer: { roommate_id: 'id-Jijo', name: 'Jijo', role: 'ROOMMATE', must_change_password: true } };
    const { problems } = await openApp(page, { as: null, responses: { signIn: firstLogin } });
    await page.getByLabel('Username').fill('jijo');
    await page.getByLabel('Password', { exact: true }).fill('TempPassw0rdXyzK');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
    await expect(page.locator('#tabs')).toBeHidden();
    await expect(page.locator('#current-password')).toBeFocused();
    await expectHealthyAuthLayout(page, 'password change');
    await shot(page, testInfo, 'password-change');

    await page.locator('#current-password').fill('TempPassw0rdXyzK');
    await page.locator('#new-password').fill('short');
    await page.locator('#repeat-password').fill('short');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('alert')).toContainText('at least 10 characters');
    await page.locator('#current-password').fill('TempPassw0rdXyzK');
    await page.locator('#new-password').fill('our cosy flat 2026');
    await page.locator('#repeat-password').fill('our cosy flat 2027');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('alert')).toContainText('don’t match');
    expect(await calls(page, 'changePassword')).toEqual([]);

    await page.locator('#current-password').fill('TempPassw0rdXyzK');
    await page.locator('#new-password').fill('our cosy flat 2026');
    await page.locator('#repeat-password').fill('our cosy flat 2026');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.locator('.hero')).toBeVisible();
    const [change] = await calls(page, 'changePassword');
    expect(change.args[0]).toEqual({ token: 'token-temp', current_password: 'TempPassw0rdXyzK', new_password: 'our cosy flat 2026' });
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('chorenest-session')).token)).toBe('token-changed');
    expect(problems).toEqual([]);
  });

  test('the server can still demand the password change, and its refusals are explained', async ({ page }) => {
    await openApp(page, {
      scheduleResponses: [{ ok: false, error: { code: 'PASSWORD_CHANGE_REQUIRED', message: 'x' } }],
      responses: { changePassword: { ok: false, error: { code: 'PASSWORD_CHANGE_FAILED', message: 'x' } } },
    });
    await expect(page.getByRole('heading', { name: 'Choose your own password' })).toBeVisible();
    await page.locator('#current-password').fill('wrong temporary');
    await page.locator('#new-password').fill('our cosy flat 2026');
    await page.locator('#repeat-password').fill('our cosy flat 2026');
    await page.getByRole('button', { name: 'Save password' }).click();
    await expect(page.getByRole('alert')).toContainText('too many attempts');
    await expect(page.locator('#tabs')).toBeHidden();
  });

  test('an ended or expired session goes back to sign-in, forgets the session and shows nothing of the household', async ({ page }) => {
    await openApp(page, { scheduleResponses: [{ ok: false, error: { code: 'UNAUTHENTICATED', message: 'x' } }] });
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('Your session has ended');
    await expect(page.locator('#main-content')).toBeHidden();
    expect(await page.evaluate(() => localStorage.getItem('chorenest-session'))).toBeNull();

    await page.evaluate(() => localStorage.setItem('chorenest-session', JSON.stringify({ token: 't', expires_at: '2000-01-01T00:00:00.000Z' })));
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    expect((await callNames(page)).filter((name) => name !== 'getRotationSchedule')).toEqual([]);
  });

  test('a session that ends during a save goes back to sign-in instead of showing an error', async ({ page }) => {
    await openApp(page, { as: HARI, cleanResponse: { ok: false, error: { code: 'UNAUTHENTICATED', message: 'x' } } });
    await page.getByRole('button', { name: /Mark as cleaned/ }).click();
    await page.getByRole('button', { name: /Yes, it’s clean/ }).click();
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    await expect(page.locator('#confirm-dialog')).toBeHidden();
  });

  test('signing out ends the session on the server, forgets it here and clears the page', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await expect(page.locator('.hero')).toBeVisible();
    await page.locator('#profile-button').click();
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome home' })).toBeVisible();
    await expect(page.getByText('You’re signed out.')).toBeVisible();
    await expect(page.locator('#profile-dialog')).toBeHidden();
    await expect(page.locator('#app')).toBeEmpty();
    expect(await page.evaluate(() => localStorage.getItem('chorenest-session'))).toBeNull();
    await expect.poll(async () => (await calls(page, 'signOut')).length).toBe(1);
    expect((await calls(page, 'signOut'))[0].args[0]).toEqual({ token: 'token-Hari' });
    await shot(page, testInfo, 'signed-out');
    expect(problems).toEqual([]);
  });
});

// Admin section: opened from Profile, only for ADMIN

async function openHousehold(page) {
  await page.locator('#profile-button').click();
  await page.getByRole('button', { name: 'Manage household' }).click();
  await expect(page.getByRole('heading', { name: 'Household' })).toBeVisible();
}

test.describe('admin section', () => {
  test('roommates never see it; an admin opens it from Profile and sees every account', async ({ page }, testInfo) => {
    await openApp(page); // Jijo
    await page.locator('#profile-button').click();
    await expect(page.getByRole('button', { name: 'Manage household' })).toHaveCount(0);
    await page.keyboard.press('Escape');
    expect(await calls(page, 'adminListAccounts')).toEqual([]);

    const admin = await page.context().browser().newPage({ baseURL: testInfo.project.use.baseURL, viewport: page.viewportSize() });
    const { problems } = await openApp(admin, { as: HARI });
    await openHousehold(admin);
    const cards = admin.locator('.account-card');
    await expect(cards).toHaveCount(3);
    await expect(cards.nth(0)).toContainText('Hari (you)');
    await expect(cards.nth(0).getByRole('button', { name: 'Disable sign-in' })).toHaveCount(0);
    await expect(cards.nth(1)).toContainText('Waiting for first sign-in');
    await expect(cards.nth(2).getByRole('button', { name: 'Create account' })).toBeVisible();
    await expect(admin.locator('.tab[aria-current="page"]')).toHaveCount(0);
    expect((await calls(admin, 'adminListAccounts'))[0].args[0]).toEqual({ token: 'token-Hari' });
    await expectHealthyLayout(admin, 'admin list');
    await shot(admin, testInfo, 'admin-list');
    await admin.getByRole('button', { name: 'Back to the schedule' }).click();
    await expect(admin.locator('.hero')).toBeVisible();
    expect(problems).toEqual([]);
    await admin.close();
  });

  test('adding a roommate shows the temporary password once; Done removes it from the page', async ({ page }, testInfo) => {
    const { problems } = await openApp(page, { as: HARI });
    await openHousehold(page);
    await page.getByRole('button', { name: /Add roommate/ }).click();
    const dialog = page.locator('#admin-dialog');
    await expect(dialog.getByLabel('Name', { exact: true })).toBeFocused();
    await dialog.getByLabel('Name', { exact: true }).fill('Kim Lee');
    await dialog.getByLabel('Email').fill('kim@example.com');
    await dialog.getByLabel('Username', { exact: true }).fill('kim');
    await dialog.getByLabel(/Admin/).check();
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
    await shot(page, testInfo, 'admin-add');
    await dialog.getByRole('button', { name: 'Add and create account' }).click();
    await expect(dialog.locator('.temp-password')).toHaveText('Xy7kP3qRt9mWb2Nc');
    await expect(dialog.getByRole('button', { name: 'Done' })).toBeFocused();
    await shot(page, testInfo, 'admin-temp-password');
    const [add] = await calls(page, 'adminAddRoommate');
    expect(add.args[0]).toEqual({ token: 'token-Hari', name: 'Kim Lee', email: 'kim@example.com', telegram: '', username: 'kim', role: 'ADMIN' });
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Xy7kP3qRt9mWb2Nc')).toHaveCount(0);
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('Xy7kP3qRt9mWb2Nc');
    await expect(page.locator('#panel-admin .notice')).toContainText('Kim Lee was added to the rotation.');
    expect(problems).toEqual([]);
  });

  test('a password reset is confirmed first, and Escape also wipes the one-time password', async ({ page }) => {
    await openApp(page, { as: HARI });
    await openHousehold(page);
    await page.locator('.account-card').nth(1).getByRole('button', { name: 'New temporary password' }).click();
    const dialog = page.locator('#admin-dialog');
    await expect(dialog.getByRole('heading', { name: 'New temporary password for Jijo?' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Create temporary password' }).click();
    await expect(dialog.locator('.temp-password')).toBeVisible();
    expect((await calls(page, 'adminResetSignIn'))[0].args[0]).toEqual({ token: 'token-Hari', roommate_id: 'id-Jijo' });
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    expect(await dialog.innerHTML()).toBe('');
  });

  test('when the server refuses because you are no longer an admin, the section closes', async ({ page }) => {
    await openApp(page, { as: HARI, responses: { adminDisableSignIn: { ok: false, error: { code: 'FORBIDDEN', message: 'x' } } } });
    await openHousehold(page);
    await page.locator('.account-card').nth(1).getByRole('button', { name: 'Disable sign-in' }).click();
    // Meanwhile another admin made Hari a roommate: from now on the server reports that.
    await page.evaluate(() => {
      window.__mock.viewer = { ...window.__mock.viewer, role: 'ROOMMATE' };
    });
    await page.locator('#admin-dialog').getByRole('button', { name: 'Disable sign-in' }).click();
    await expect(page.locator('#panel-admin')).toBeHidden();
    await expect(page.locator('.hero')).toBeVisible();
    await expect(page.locator('#profile-button')).toContainText('Roommate');
  });
});

test.describe('history', () => {
  test('the History tab shows the last 14 days as a table, newest first, with range filters', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    await expect(page.locator('.hero')).toBeVisible();
    await tab(page, 'history').click();
    const rows = panel(page, 'history').locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0)).toContainText('Jijo');
    await expect(rows.nth(0)).toContainText('Cleaned');
    await expect(rows.nth(1)).toContainText('Skipped: away');
    await expect(rows.nth(2)).toContainText('Closed by the app owner');
    const chips = panel(page, 'history').locator('.filter-bar .chip');
    await expect(chips).toHaveText(['Last 14 days', 'Last 30 days', 'Last 90 days', 'All time']);
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'true');
    await expect(panel(page, 'history').locator('input, form, select')).toHaveCount(0);
    expect((await calls(page, 'listCleaningHistory'))[0].args[0]).toEqual({ token: 'token-Jijo', range: '14d', page: 1 });
    await expectHealthyLayout(page, 'history');
    await shot(page, testInfo, 'history');

    await chips.nth(2).click();
    await expect(chips.nth(2)).toHaveAttribute('aria-pressed', 'true');
    await expect(chips.nth(0)).toHaveAttribute('aria-pressed', 'false');
    const all = await calls(page, 'listCleaningHistory');
    expect(all[all.length - 1].args[0]).toEqual({ token: 'token-Jijo', range: '90d', page: 1 });
    await expect(rows).toHaveCount(3);
    await expectHealthyLayout(page, 'history');
    expect(problems).toEqual([]);
  });

  test('Download CSV saves the file for the chosen range', async ({ page }) => {
    const csv = '﻿Weekend start,Weekend end,Roommate,Status,Resolved (Berlin time),Swapped turn\r\n2026-01-10,2026-01-11,Jijo,Cleaned,2026-01-11 18:30,No\r\n';
    const { problems } = await openApp(page, { responses: { exportCleaningHistory: { ok: true, filename: 'chorenest-history-14d-2026-01-13.csv', csv, count: 1 } } });
    await tab(page, 'history').click();
    const button = panel(page, 'history').getByRole('button', { name: 'Download CSV' });
    await expect(button).toBeEnabled();
    const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
    expect(download.suggestedFilename()).toBe('chorenest-history-14d-2026-01-13.csv');
    expect(require('node:fs').readFileSync(await download.path(), 'utf8')).toBe(csv);
    expect((await calls(page, 'exportCleaningHistory'))[0].args[0]).toEqual({ token: 'token-Jijo', range: '14d' });
    await expect(button).toBeEnabled();
    expect(problems).toEqual([]);
  });

  test('an empty range explains itself, offers longer ranges and disables the download', async ({ page }) => {
    const empty = { ok: true, entries: [], range: '14d', page: 1, page_size: 25, total: 0, pages: 1 };
    await openApp(page, { history: empty });
    await tab(page, 'history').click();
    await expect(panel(page, 'history')).toContainText('No cleanings in the last 14 days');
    await expect(panel(page, 'history').getByRole('button', { name: 'Download CSV' })).toBeDisabled();
    await expect(panel(page, 'history').locator('.filter-bar .chip')).toHaveCount(4);
    await expectHealthyLayout(page, 'history');
  });
});

test.describe('swaps', () => {
  test('the Swaps tab shows the request asked of me and the explanation', async ({ page }, testInfo) => {
    const { problems } = await openApp(page); // Jijo
    await tab(page, 'swaps').click();
    const swaps = panel(page, 'swaps');
    await expect(swaps).toContainText('Nothing changes until they accept');
    await expect(swaps.locator('.account-card')).toHaveCount(1);
    await expect(swaps.locator('.account-card')).toContainText('Hari');
    await expect(swaps.locator('.account-card')).toContainText('You clean');
    await expect(swaps.getByRole('button', { name: 'Accept' })).toBeVisible();
    await expect(swaps.getByRole('button', { name: 'Decline' })).toBeVisible();
    await expect(swaps.getByRole('button', { name: 'Cancel request' })).toHaveCount(0);
    expect((await calls(page, 'listSwaps'))[0].args[0]).toEqual({ token: 'token-Jijo' });
    await expectHealthyLayout(page, 'swaps');
    await shot(page, testInfo, 'swaps');
    expect(problems).toEqual([]);
  });

  test('requesting a swap previews the two weekends, then sends the choice and says nothing changes yet', async ({ page }, testInfo) => {
    const { problems } = await openApp(page);
    await tab(page, 'swaps').click();
    await panel(page, 'swaps').getByRole('button', { name: 'Request a swap' }).click();
    const dialog = page.locator('#swap-dialog');
    await expect(dialog.getByLabel('Your turn to give away')).toBeFocused();
    await dialog.getByLabel('Their turn to take').selectOption({ index: 0 });
    await expect(dialog.locator('.swap-preview')).toContainText('You clean');
    await expect(dialog.locator('.swap-preview')).toContainText('Nothing changes until Arun accepts.');
    const box = await dialog.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize().width + 0.5);
    await shot(page, testInfo, 'swap-request');
    await dialog.getByRole('button', { name: 'Send request' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'swaps').locator('.notice')).toContainText('Nothing changes until they accept.');
    const [sent] = await calls(page, 'requestSwap');
    expect(Object.keys(sent.args[0]).sort()).toEqual(['partner_id', 'their_due_at', 'token', 'your_due_at']);
    expect(sent.args[0].partner_id).toBe('id-Arun');
    expect(problems).toEqual([]);
  });

  test('accepting asks first, then refreshes the schedule without a loading state', async ({ page }) => {
    const { problems } = await openApp(page);
    await expect(page.locator('.hero')).toBeVisible();
    await tab(page, 'swaps').click();
    await panel(page, 'swaps').getByRole('button', { name: 'Accept' }).click();
    const dialog = page.locator('#swap-dialog');
    await expect(dialog.getByRole('heading', { name: 'Accept Hari’s swap?' })).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Not now' })).toBeFocused();
    await dialog.getByRole('button', { name: 'Accept swap' }).click();
    await expect(dialog).toBeHidden();
    await expect(panel(page, 'swaps').locator('.notice')).toContainText('Swap accepted');
    expect((await calls(page, 'acceptSwap'))[0].args[0]).toEqual({ token: 'token-Jijo', swap_id: 'swap-1' });
    await expect.poll(async () => (await calls(page, 'getRotationSchedule')).length).toBe(2);
    await expect(page.locator('.skeleton-hero')).toHaveCount(0);
    expect(problems).toEqual([]);
  });

  test('a stale request is explained in plain words and the list reloads', async ({ page }) => {
    await openApp(page, { responses: { acceptSwap: { ok: false, error: { code: 'SWAP_STALE', message: 'Server detail' } } } });
    await tab(page, 'swaps').click();
    await panel(page, 'swaps').getByRole('button', { name: 'Accept' }).click();
    await page.locator('#swap-dialog').getByRole('button', { name: 'Accept swap' }).click();
    await expect(panel(page, 'swaps').locator('.notice')).toContainText('so this swap no longer fits');
    await expect(page.getByText('Server detail')).toHaveCount(0);
    expect(await calls(page, 'listSwaps')).toHaveLength(2);
  });
});
