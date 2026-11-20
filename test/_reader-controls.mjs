/** Open the visible toolbar entry before clicking a control in its popover. */
export async function clickReaderTool(page, selector) {
  const menu = await page.$eval(selector, node => {
    const panel = node.closest('[popover]');
    return panel && !panel.matches(':popover-open') ? panel.id : '';
  });
  if (menu) await page.locator(`[popovertarget="${menu}"]`).click();
  await page.locator(selector).click();
}

/** Open a paper from the shelf if needed, then select a visible left-panel tab. */
export async function showReaderPanel(page, key) {
  if (!await page.$eval('body', node => node.classList.contains('reading'))) {
    await page.locator('#homeList .home-item-go').click();
    await page.waitForFunction(() => document.body.classList.contains('reading') && window.__viewer?.pdf);
  }
  if (await page.$eval('body', node => node.classList.contains('no-left'))) {
    await page.locator('#topbarLeftToggle').click();
  }
  const selector = `#railLeft [data-rail="${key}"]`;
  if (!await page.$eval(selector, node => node.classList.contains('active'))) await page.locator(selector).click();
}
