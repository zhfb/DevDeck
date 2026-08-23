import { expect, test } from "@playwright/test";

test("opens the DevDeck workbench and SFTP empty state", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByText("DevDeck").first()).toBeVisible();
  await page.getByRole("button", { name: "SFTP" }).click();
  await expect(page.getByText("需要先打开 SSH 终端")).toBeVisible();
});

test("opens command palette and exposes host suggestions", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: /搜索主机/ }).click();
  await expect(page.getByPlaceholder("搜索主机、容器、命令…")).toBeVisible();
  await expect(page.locator("[cmdk-item]").filter({ hasText: "香港 VPS" })).toBeVisible();
});
