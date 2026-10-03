const { test, expect } = require('@playwright/test');

test('upload sample video and generate a review script', async ({ page }) => {
  test.setTimeout(420_000);

  const consoleErrors = [];
  const requestFailures = [];
  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', err => consoleErrors.push(err.message));
  page.on('requestfailed', req => {
    const failure = req.failure();
    requestFailures.push(`${req.method()} ${req.url()} ${failure?.errorText || ''}`.trim());
  });

  await page.goto('http://localhost:4200/', { waitUntil: 'networkidle' });
  await expect(page.getByText(/Gemini configured/)).toBeVisible({ timeout: 45_000 });

  await page.locator('input[type="file"]').setInputFiles(
    'C:/Users/Shree/Downloads/vidssave.com Why Are Lizards Farmed In China_ #shorts #ytshorts 720p.mp4'
  );
  await expect(page.getByText(/READY/)).toBeVisible();

  await page.getByRole('button', { name: /Analyze & review script first/ }).click();
  await expect(page.getByRole('heading', { name: 'AI Creative Kit' })).toBeVisible({ timeout: 390_000 });

  await expect(page.locator('.script-hook h3')).toBeVisible();
  await expect(page.locator('.beat textarea').first()).toHaveValue(/.+/);

  await page.screenshot({ path: 'test-results/playwright-review-script.png', fullPage: true });

  expect(consoleErrors, `Browser console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  expect(
    requestFailures.filter(x => !x.includes('/api/jobs/') && !x.includes('blob:http://localhost:4200/')),
    `Unexpected request failures:\n${requestFailures.join('\n')}`
  ).toEqual([]);
});
