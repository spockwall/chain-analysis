import { expect, test } from "@playwright/test";

const explorerAddress = "0x28c6c06298d514db089934071355e5743bf21d60";

function uniqueAddress(): string {
  const suffix = Date.now().toString(16).padStart(40, "0").slice(-40);
  return `0x${suffix}`;
}

test("analyst smoke journey: login, ingest, explore, queue label, annotate", async ({ page }) => {
  const queuedAddress = uniqueAddress();

  await page.goto("/login");
  await page.getByTestId("login-email").fill("operator@example.com");
  await page.getByTestId("login-password").fill("Operator@chain2024!");
  await page.getByTestId("login-submit").click();

  await expect(page).toHaveURL(/\/explorer/);
  await expect(page.getByTestId("nav-tab-explorer")).toBeVisible();

  await page.getByTestId("address-search").fill(queuedAddress);
  await page.getByTestId("address-search-submit").click();
  await expect(page.getByTestId("graph-stats-transactions")).toContainText("0 transactions");
  await page.getByTestId("fetch-address").click();
  await expect(page.getByText(/Queued ingest/)).toBeVisible();

  await page.getByTestId("address-search").fill(explorerAddress);
  await page.getByTestId("address-search-submit").click();
  await expect(page.getByTestId("graph-stats-entities")).toContainText(/entities/);
  await expect(page.getByTestId("graph-stats-transactions")).toContainText(/transactions/);

  await page.getByTestId("nav-tab-labels").click();
  await expect(page).toHaveURL(/\/labels/);
  await page.getByTestId("label-addresses-input").fill(queuedAddress);
  await page.getByTestId("label-queue-submit").click();
  await expect(page.getByText(/Queued 1 task/)).toBeVisible();

  const row = page.locator(`[data-testid="label-task-row"][data-entity-address="${queuedAddress}"]`);
  await expect(row).toBeVisible();
  await row.getByTestId("label-annotate-button").click();

  await page.getByTestId("annotation-entity-type").selectOption("EOA");
  await page.getByTestId("annotation-risk-medium").click();
  await page.getByTestId("annotation-labels").fill("smoke-test");
  await page.getByTestId("annotation-notes").fill("Smoke journey annotation");
  await page.getByTestId("annotation-confidence").fill("0.8");
  await page.getByTestId("annotation-submit").click();

  await expect(page.getByText("Annotation submitted")).toBeVisible();
});
