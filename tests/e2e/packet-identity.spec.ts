import { test, expect, type Page, type Route } from '@playwright/test';

const PACKET_ID = 'P1';
const PACKET_TITLE = 'Playwright Packet Alpha';
const PACKET_SUMMARY = 'Launch and verify packet identity across the desktop shell.';

function emptyMissionState() {
  return {
    version: 2 as const,
    prompt: '',
    summary: '',
    packets: [],
    updatedAt: '2026-03-28T00:00:00.000Z',
  };
}

async function fulfillMissionState(route: Route, missionState: ReturnType<typeof emptyMissionState>) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ mission: missionState }),
  });
}

async function stubDesktopPacketApis(page: Page) {
  let missionState = emptyMissionState();

  await page.route('**/api/setup/config', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ completedAt: '2026-03-28T00:00:00.000Z' }),
    });
  });

  await page.route('**/api/orchestrator/state', async (route) => {
    if (route.request().method() === 'POST') {
      const payload = route.request().postDataJSON() as { mission?: typeof missionState };
      missionState = payload.mission ?? missionState;
    }

    await fulfillMissionState(route, missionState);
  });

  for (const path of ['**/api/codex/transcript**', '**/api/claude-code/transcript**']) {
    await page.route(path, async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ transcript: [] }),
      });
    });
  }
}

test.describe('Packet identity propagation', () => {
  test.beforeEach(async ({ page }) => {
    await stubDesktopPacketApis(page);
    await page.addInitScript(() => {
      localStorage.removeItem('cortex-ide:dashboard-tiles:v1');
      localStorage.removeItem('cortex-ide:thoughts:mission-control-v1');
      localStorage.setItem('cortex-ide:orchestrator:runtime', 'codex');
    });
    await page.goto('/dashboard');
    await page.waitForSelector('[data-tile-active="true"]', { timeout: 15_000 });
  });

  test('P1 launches with consistent identity across Mission Control, workspace, and chat rail', async ({ page }) => {
    await page.getByRole('button', { name: 'Thoughts' }).click();
    await expect(page.getByRole('button', { name: 'Mission Control' })).toBeVisible();

    await page.getByRole('button', { name: 'Add Packet' }).click();
    await expect(page.getByText(PACKET_ID, { exact: true })).toBeVisible();

    await page.getByPlaceholder('Packet title').fill(PACKET_TITLE);
    await page.getByPlaceholder('What should this packet accomplish?').fill(PACKET_SUMMARY);

    await page.getByRole('button', { name: 'Launch', exact: true }).click();

    const activeWorkspaceTile = page.locator('[data-tile-active="true"]').first();
    await expect(activeWorkspaceTile).toContainText(PACKET_ID);
    await expect(activeWorkspaceTile).toContainText(PACKET_TITLE);
    await expect(activeWorkspaceTile).toContainText(`Packet ID: ${PACKET_ID}`);
    await expect(activeWorkspaceTile).toContainText(`Packet: ${PACKET_TITLE}`);

    const chatRailLaneSwitcher = page.getByRole('button', { name: 'Switch lane' });
    await expect(chatRailLaneSwitcher).toContainText(PACKET_TITLE);
    await expect(chatRailLaneSwitcher).toContainText(PACKET_ID);
    await expect(page.getByText('Waiting for first activity')).toBeVisible();
  });
});
