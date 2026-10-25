import type { Page } from 'playwright-core';

type TouchInput = { send(method: string, params: object): Promise<unknown>; detach?(): Promise<void> };
type ScrollBox = { x: number; y: number; width: number; height: number };

export async function panNavigation(page: Page, box: ScrollBox, down: boolean) {
  await page.mouse.move(Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2));
  // Desktop WebKit delivers trackpad pans as pixel wheel deltas through its
  // native scrolling path, not as touchscreen TouchEvents. Ramp each stroke
  // up and down rather than jumping directly to the scroll endpoint.
  for (const delta of [24, 48, 72, 96, 96, 72, 48, 24]) {
    await page.mouse.wheel(0, down ? delta : -delta);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  }
}

export async function navigationTouchInput(page: Page, webkit: boolean): Promise<TouchInput> {
  if (!webkit) return page.context().newCDPSession(page);
  // Playwright 1.60 has no public WebKit protocol session. Its local bridge
  // exposes Input events without substituting untrusted DOM dispatches.
  const localPage = page as Page & { _connection: { toImpl(page: Page): {
    delegate: { _pageProxySession: TouchInput };
  } } };
  return localPage._connection.toImpl(page).delegate._pageProxySession;
}

export async function swipeNavigation(page: Page, input: TouchInput, box: ScrollBox, down: boolean, webkit: boolean) {
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + (down ? box.height - 80 : 80));
  const distance = Math.round((down ? -1 : 1) * (box.height - 160));
  const send = (type: string, offset: number) => input.send('Input.dispatchTouchEvent', {
    type, touchPoints: [{ id: 0, x, y: y + offset }],
  });
  await send('touchStart', 0);
  // Cross the app's 6px drag threshold before the native pan threshold.
  await send('touchMove', down ? -8 : 8);
  const frame = () => page.evaluate(() => new Promise<void>(resolve =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await frame();
  for (let step = 1; step <= 8; step++) {
    await send('touchMove', Math.round(distance * step / 8));
    await frame();
  }
  // WebKit requires the released point; Chromium accepts an empty point list.
  if (webkit) await send('touchEnd', distance);
  else await input.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
}
