import { expect, test } from "@playwright/test";
import { renderDocumentHtml } from "../src/renderer/print/templates";
import { garageDay, shooter } from "./flow";

test("garage day: setup → customer → estimate → job card → invoice → paid", async ({ page, request }) => {
  page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
  page.on("console", (m) => m.type() === "error" && console.log("CONSOLE", m.text()));
  page.on("response", (r) => r.status() >= 400 && console.log("HTTP", r.status(), r.url()));
  await page.goto("/");
  const shot = shooter(page);
  await garageDay(page, shot);

  // Small garage screens (1024–1366 px wide): the item description must stay readable, not squeezed
  // to one letter per line (seen on the Windows test machine).
  for (const width of [1024, 1100, 1280, 1366]) {
    await page.setViewportSize({ width, height: 700 });
    const box = await page.getByRole("cell", { name: /Front brake service/ }).boundingBox();
    expect(box?.width ?? 0, `description column at ${width}px`).toBeGreaterThanOrEqual(180);
    await expect(page.getByRole("columnheader", { name: "Total" }), `Total column at ${width}px`).toBeInViewport({ ratio: 1 });
  }
  await shot("06b-invoice-small-screen");
  await page.setViewportSize({ width: 1440, height: 900 });

  // Dashboard & lists with data.
  await page.getByRole("navigation").getByRole("link", { name: "Dashboard", exact: true }).click();
  await shot("07-dashboard");
  await page.getByRole("navigation").getByRole("link", { name: "Invoices", exact: true }).click();
  await expect(page.getByRole("cell", { name: "INV-00001" })).toBeVisible();
  await shot("08-invoices");

  // Render the printed tax invoice exactly as the app would.
  const token = await page.evaluate(() => sessionStorage.getItem("ffgp.token"));
  const headers = { authorization: `Bearer ${token}` };
  const api = "http://127.0.0.1:4780";
  const getDoc = async (type: string) => {
    const list = await (await request.get(`${api}/api/documents?type=${type}`, { headers })).json();
    return (await (await request.get(`${api}/api/documents/${list.documents[0].id}`, { headers })).json()).document;
  };
  const garage = (await (await request.get(`${api}/api/settings`, { headers })).json()).garage;
  for (const name of ["invoice", "jobcard"] as const) {
    const printPage = await page.context().newPage();
    await printPage.setViewportSize({ width: 794, height: 1123 });
    await printPage.setContent(renderDocumentHtml(await getDoc(name), garage));
    await printPage.screenshot({ path: `test-results/screens/09-print-${name}.png`, fullPage: true });
    await printPage.pdf({ path: `test-results/screens/print-${name}.pdf`, format: "A4", printBackground: true });
    await printPage.close();
  }
});
