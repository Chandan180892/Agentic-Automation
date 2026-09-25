/**
 * The quality gate against known-bad and known-good snippets: every checkable rule must flag
 * its bad example, leave the good one alone, and — where it fixes — produce code that passes.
 * No database, no model.
 */
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { RULES, qualityGate, rulebookPrompt } from "../src/lib/agents/rulebook";

const results: string[] = [];
let failures = 0;
const check = (n: string, c: boolean, e = "") => {
  if (!c) failures++;
  results.push(`${c ? "PASS" : "FAIL"} ${n}${e ? ` — ${e}` : ""}`);
};

const wrap = (body: string) => `import { test, expect } from "@playwright/test";\n\ntest("case", async ({ page, request }) => {\n${body}\n});\n`;
const spec = (body: string) => [{ path: "tests/x.spec.ts", content: wrap(body) }];

const CASES: Record<string, { bad: string; good: string; fixedTo?: RegExp }> = {
  "no-fixed-waits": {
    bad: `  await page.goto("/");\n  await page.waitForTimeout(1500);\n  await expect(page.getByRole("heading")).toBeVisible();`,
    good: `  await page.goto("/");\n  await expect(page.getByRole("heading")).toBeVisible();`,
    fixedTo: /^(?![\s\S]*waitForTimeout)/,
  },
  "web-first-assertions": {
    bad: `  expect(await page.getByRole("alert").isVisible()).toBe(true);`,
    good: `  await expect(page.getByRole("alert")).toBeVisible();`,
    fixedTo: /await expect\(page\.getByRole\("alert"\)\)\.toBeVisible\(\);/,
  },
  "stable-selectors": {
    bad: `  await page.locator('.btn-primary').click();\n  await expect(page.getByText("Paid")).toBeVisible();`,
    good: `  await page.getByRole("button", { name: "Pay" }).click();\n  await expect(page.getByText("Paid")).toBeVisible();`,
  },
  "no-element-handles": {
    bad: `  const el = await page.$("#pay");\n  await expect(page.getByText("x")).toBeVisible();`,
    good: `  const el = page.locator("#pay");\n  await expect(el).toBeVisible();`,
  },
  "no-force": {
    bad: `  await page.getByRole("button", { name: "Pay" }).click({ force: true });\n  await expect(page.getByText("Paid")).toBeVisible();`,
    good: `  await page.getByRole("button", { name: "Pay" }).click();\n  await expect(page.getByText("Paid")).toBeVisible();`,
    fixedTo: /\.click\(\);/,
  },
  "no-focused-tests": {
    bad: `  await expect(page).toHaveTitle(/Shop/);\n});\ntest.only("other", async ({ page }) => {\n  await expect(page).toHaveTitle(/Shop/);`,
    good: `  await expect(page).toHaveTitle(/Shop/);`,
    fixedTo: /^(?![\s\S]*\.only)/,
  },
  "no-skipped-tests": {
    bad: `  await expect(page).toHaveTitle(/Shop/);\n});\ntest.skip("other", async ({ page }) => {\n  await expect(page).toHaveTitle(/Shop/);`,
    good: `  await expect(page).toHaveTitle(/Shop/);`,
  },
  "independent-tests": {
    bad: `  await expect(page).toHaveTitle(/Shop/);\n});\ntest.describe.serial("flow", () => {`,
    good: `  await expect(page).toHaveTitle(/Shop/);`,
  },
  "no-retry-masking": {
    bad: `  test.describe.configure({ retries: 3 });\n  await expect(page).toHaveTitle(/Shop/);`,
    good: `  await expect(page).toHaveTitle(/Shop/);`,
  },
  "test-has-assertion": {
    bad: `  await page.goto("/checkout");\n  await page.getByRole("button", { name: "Pay" }).click();`,
    good: `  await page.goto("/checkout");\n  await expect(page.getByRole("button", { name: "Pay" })).toBeEnabled();`,
  },
  "assertion-can-fail": {
    bad: `  await page.goto("/");\n  expect(true).toBe(true);`,
    good: `  await page.goto("/");\n  await expect(page).toHaveURL(/checkout/);`,
  },
  "no-placeholders": {
    bad: `  // TODO: assert the refund\n  await expect(page).toHaveURL(/refund/);`,
    good: `  await expect(page).toHaveURL(/refund/);`,
  },
  "api-assert-body": {
    bad: `  const res = await request.post("/api/orders", { data: { sku: "A" } });\n  expect(res.status()).toBe(201);`,
    good: `  const res = await request.post("/api/orders", { data: { sku: "A" } });\n  expect(res.status()).toBe(201);\n  expect(await res.json()).toMatchObject({ sku: "A" });`,
  },
  "no-hardcoded-secrets": {
    bad: `  const password = "hunter2hunter2";\n  await expect(page).toHaveURL(/x/);`,
    good: `  const password = process.env.SHOPPER_PASSWORD ?? "";\n  await expect(page).toHaveURL(/x/);`,
  },
  "no-hardcoded-hosts": {
    bad: `  await page.goto("https://staging.shop.example/checkout");\n  await expect(page).toHaveURL(/checkout/);`,
    good: `  await page.goto("/checkout");\n  await expect(page).toHaveURL(/checkout/);`,
  },
  "unique-test-data": {
    bad: `  const res = await request.post("/api/orders", { data: { orderId: 12345 } });\n  expect(await res.json()).toMatchObject({ ok: true });`,
    good: `  const res = await request.post("/api/orders", { data: { orderId: crypto.randomUUID() } });\n  expect(await res.json()).toMatchObject({ ok: true });`,
  },
  "locale-independent": {
    bad: `  await expect(page.getByTestId("date")).toHaveText(new Date().toLocaleDateString());`,
    good: `  await expect(page.getByTestId("date")).toHaveText("2026-09-25");`,
  },
  "no-debug-output": {
    bad: `  console.log(await page.content());\n  await expect(page).toHaveURL(/x/);`,
    good: `  await expect(page).toHaveURL(/x/);`,
    fixedTo: /^(?![\s\S]*console\.log)/,
  },
};

for (const rule of RULES.filter((r) => r.check)) {
  const c = CASES[rule.id];
  if (!c) {
    check(`${rule.id} has a test case`, false);
    continue;
  }
  const bad = qualityGate(spec(c.bad));
  const hit = bad.findings.filter((f) => f.rule === rule.id);
  check(`${rule.id} flags the bad example`, hit.length > 0);
  const good = qualityGate(spec(c.good));
  check(`${rule.id} passes the good example`, !good.findings.some((f) => f.rule === rule.id), good.findings.map((f) => f.rule).join(","));
  if (c.fixedTo) {
    check(`${rule.id} fixes it automatically`, hit.every((f) => f.fixed) && c.fixedTo.test(bad.files[0].content), bad.files[0].content.split("\n").slice(3, 6).join(" ⏎ "));
    const again = qualityGate(bad.files);
    check(`${rule.id} fix passes a second run`, !again.findings.some((f) => f.rule === rule.id));
  }
}

const mixed = qualityGate([
  { path: "fixtures/users.ts", content: `export const user = { email: "a@example.com" };\n// TODO: rotate\n` },
  { path: "README.md", content: "await page.waitForTimeout(100)" },
]);
check("placeholders are checked in helper files too", mixed.findings.some((f) => f.rule === "no-placeholders" && f.path === "fixtures/users.ts"));
check("test-only rules skip helper files", !mixed.findings.some((f) => f.rule === "unique-test-data"));
check("non-code files are ignored", !mixed.findings.some((f) => f.path === "README.md"));
check("blocking count excludes what was fixed", qualityGate(spec(CASES["no-fixed-waits"].bad)).blocking === 0);
const prompt = rulebookPrompt();
check("the rulebook prompt names every rule", RULES.every((r) => prompt.includes(r.title)));
check("the rulebook prompt is stable", prompt === rulebookPrompt());
check("every rule cites a source", RULES.every((r) => r.sources.length > 0));

// The Pages app runs the same gate from a browser bundle; it must match this source.
const fresh = buildSync({
  entryPoints: ["src/lib/agents/rulebook.ts"],
  bundle: true,
  format: "iife",
  globalName: "Rulebook",
  target: "es2020",
  banner: { js: "/* Generated from src/lib/agents/rulebook.ts by npm run build:pages. Do not edit. */" },
  write: false,
}).outputFiles[0].text;
check("docs/rulebook.js is built from the current rulebook (npm run build:pages)", fresh === readFileSync("docs/rulebook.js", "utf8"));

console.log(results.join("\n"));
console.log(`\n${results.length - failures} passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
