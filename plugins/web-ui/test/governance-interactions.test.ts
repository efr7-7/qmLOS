import assert from "node:assert/strict";
import { test } from "node:test";
import { JSDOM } from "jsdom";
import { createServer } from "vite";

function cardAction(label: string): HTMLButtonElement {
  const found = [...document.querySelectorAll<HTMLButtonElement>(".gov-card-head .gov-ghost")].find(
    (b) => (b.textContent ?? "").trim() === label,
  );
  if (!found) throw new Error(`no card action labelled ${label}`);
  return found;
}

function installDom(): void {
  const dom = new JSDOM('<!doctype html><div id="app"></div><main id="main"></main>', {
    url: "http://localhost/web-ui/?view=governance",
  });
  Object.defineProperty(dom.window, "matchMedia", {
    value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
  });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { value() {} });
  const globals = {
    window: dom.window,
    document: dom.window.document,
    location: dom.window.location,
    history: dom.window.history,
    localStorage: dom.window.localStorage,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    HTMLDialogElement: dom.window.HTMLDialogElement,
    customElements: dom.window.customElements,
    Node: dom.window.Node,
    Event: dom.window.Event,
    MouseEvent: dom.window.MouseEvent,
    SubmitEvent: dom.window.SubmitEvent,
    InputEvent: dom.window.InputEvent,
    requestAnimationFrame: (callback: FrameRequestCallback) => setTimeout(() => callback(Date.now()), 0),
    cancelAnimationFrame: clearTimeout,
    getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  };
  for (const [key, value] of Object.entries(globals))
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const PEOPLE = {
  totalCostUsd: 20.69,
  total: 2,
  people: [
    {
      principalId: "ines",
      displayName: "Ines Ferreira",
      teamId: "growth",
      teamName: "Growth",
      isAdmin: false,
      calls: 40,
      costUsd: 20.69,
      lastActiveAt: 1_700_000_000_000,
      hasOwnAllocation: true,
    },
    {
      principalId: "demo",
      displayName: "Demo Admin",
      teamId: "platform",
      teamName: "Platform",
      isAdmin: true,
      calls: 12,
      costUsd: 5,
      lastActiveAt: 1_700_000_000_000,
      hasOwnAllocation: false,
    },
  ],
};

const TEAMS = {
  teams: [
    { id: "platform", name: "Platform", parentId: null, membersVersion: 'W/"m1-demo"' },
    { id: "growth", name: "Growth", parentId: null, membersVersion: 'W/"m1-ines"' },
  ],
};

const ALLOCATIONS = {
  allocations: [
    { id: "demo-org", subject: "org", limitUsd: 400, windowMs: 2_592_000_000, hard: true, spentUsd: 123.6 },
    { id: "ghost", subject: "principal:not-here", limitUsd: 10, windowMs: 86_400_000, hard: true, spentUsd: 0 },
  ],
};

const DETAIL = {
  principalId: "ines",
  displayName: "Ines Ferreira",
  totals: { calls: 40, costUsd: 20.69, totalTokens: 100, effectiveUsdPerMtok: 3 },
  breakdowns: { byModel: [], byHarness: [], byPhase: [], bySource: [] },
  outcomes: {
    runs: 25,
    costUsd: 22.92,
    ledgerCostUsd: 20.69,
    byOutcome: { "code-pushed": 9, artifact: 7, "sent-internal": 6, chat: 3 },
    produced: 22,
    costPerOutcomeUsd: 1.0417,
    ledgerCostPerOutcomeUsd: 0.9403,
  },
  team: { id: "growth", name: "Growth" },
  teamAncestry: [{ id: "growth", name: "Growth" }],
  allocations: [
    {
      id: "demo-principal-ines",
      subject: "principal:ines",
      kind: "principal",
      limitUsd: 5,
      windowMs: 86_400_000,
      hard: true,
      spentUsd: 0.23,
      remainingUsd: 4.77,
      utilization: 0.046,
      exceeded: false,
    },
    {
      id: "demo-team-growth",
      subject: "team:growth",
      kind: "team",
      limitUsd: 150,
      windowMs: 2_592_000_000,
      hard: false,
      spentUsd: 44.84,
      remainingUsd: 105.16,
      utilization: 0.3,
      exceeded: false,
    },
  ],
};

const RECEIPTS = {
  total: 1,
  receipts: [
    {
      runId: "demo-run-14",
      principalId: "ines",
      displayName: "Ines Ferreira",
      outcome: "code-pushed",
      outcomeCostUsd: 0.4554,
      costUsd: 0.4554,
      calls: 3,
      totalTokens: 54_911,
      model: "claude-fable-5",
      harness: "opencode",
      sessionId: "demo-thread-14",
      estimated: true,
      at: 1_784_448_245_212,
    },
  ],
};

const RECEIPT = {
  runId: "demo-run-14",
  principalId: "ines",
  displayName: "Ines Ferreira",
  sessionId: "demo-thread-14",
  at: 1_784_448_245_212,
  outcome: { kind: "code-pushed", costUsd: 0.4554, at: 1_784_448_245_212 },
  totals: {
    calls: 3,
    input: 1_000,
    output: 1_262,
    cacheRead: 500,
    cacheWrite: 0,
    costUsd: 0.4554,
    estimatedCalls: 1,
    totalTokens: 54_911,
    effectiveUsdPerMtok: 8.29,
  },
  items: [
    {
      phase: "turn",
      model: "claude-fable-5",
      harness: "opencode",
      source: "los",
      calls: 1,
      totalTokens: 16_387,
      costUsd: 0.0853,
      estimatedCalls: 0,
    },
    {
      phase: "external",
      model: "claude-fable-5",
      harness: "opencode",
      source: "claude-code",
      calls: 1,
      totalTokens: 38_094,
      costUsd: 0.3677,
      estimatedCalls: 1,
    },
    {
      phase: "screen",
      model: "claude-sonnet-5",
      harness: "opencode",
      source: "los",
      calls: 1,
      totalTokens: 430,
      costUsd: 0.0024,
      estimatedCalls: 0,
    },
  ],
  sources: ["los", "claude-code"],
  team: { id: "growth", name: "Growth" },
  teamAncestry: [{ id: "growth", name: "Growth" }],
  allocations: DETAIL.allocations,
};

test("a failed governance write keeps the page, names the action, and preserves the draft", async () => {
  installDom();
  let writesFail = false;
  let loadsFail = false;
  const fail = () => new Response(JSON.stringify({ error: "upstream error" }), { status: 502 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (method !== "GET") return writesFail ? fail() : Response.json({ ok: true });
    if (path.includes("/api/admin/utb/people/")) return loadsFail ? fail() : Response.json(DETAIL);
    if (path.includes("/api/admin/utb/people")) return loadsFail ? fail() : Response.json(PEOPLE);
    if (path.includes("/api/admin/utb/teams")) return loadsFail ? fail() : Response.json(TEAMS);
    if (path.includes("/api/admin/utb/allocations")) return loadsFail ? fail() : Response.json(ALLOCATIONS);
    if (path.includes("/api/admin/receipts")) return loadsFail ? fail() : Response.json(RECEIPTS);
    throw new Error(`Unexpected request: ${method} ${path}`);
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderGovernance, resetGovernanceState } = await vite.ssrLoadModule("/src/governance.ts");
    appState.me = { user: "demo", org: "acme" };
    appState.currentView = "governance";
    appState.mainEl = document.querySelector("#main");
    resetGovernanceState();

    await renderGovernance();
    const loadedRows = document.querySelectorAll(".gov-row").length;
    const loadedCards = document.querySelectorAll(".usage-card").length;
    assert.ok(loadedRows > 0 && loadedCards > 0, "the page loads with roster rows and cards");

    cardAction("New team").click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const idInput = document.querySelector<HTMLInputElement>(".gov-team-id")!;
    idInput.value = "qa-team";
    idInput.dispatchEvent(new InputEvent("input", { bubbles: true }));
    const nameInput = document.querySelector<HTMLInputElement>(".gov-team-name")!;
    nameInput.value = "QA Team";
    nameInput.dispatchEvent(new InputEvent("input", { bubbles: true }));

    writesFail = true;
    loadsFail = true;
    const create = [...document.querySelectorAll<HTMLButtonElement>(".gov-team-form .gov-primary")].at(-1)!;
    create.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // A failed write reports itself inline, beside the form that failed — not as a
    // page-level banner that yanks the user out of what they were doing.
    const strip = document.querySelector(".gov-trouble");
    assert.ok(strip, "a failed write reports itself inline");
    assert.equal(strip!.getAttribute("role"), "alert", "the failure is announced as an alert");
    assert.match(strip!.textContent ?? "", /Couldn't create team qa-team/, "the failure names the attempted action");
    assert.ok(
      [...strip!.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Retry")),
      "the failure offers a retry",
    );
    assert.ok(document.querySelector(".gov-team-form"), "the form the user was filling in stays open");
    assert.ok(document.querySelectorAll(".gov-row").length > 0, "the roster survives a failed write");
    assert.ok(document.querySelectorAll(".usage-card").length > 0, "the cards survive a failed write");
    assert.equal(
      document.querySelector<HTMLInputElement>(".gov-team-id")!.value,
      "qa-team",
      "the typed draft survives a failed write",
    );
    assert.equal(
      document.querySelectorAll(".gov-team-row").length,
      TEAMS.teams.length,
      "the optimistic row is rolled back, so the roster never shows a team that was refused",
    );
  } finally {
    await vite.close();
  }
});

test("usage labels allocation subjects and leaderboard teams the way governance does", async () => {
  installDom();
  const ORG_UTB = { totalCostUsd: 128, headcount: 4, pepmUsd: 32, groups: { model: [], source: [], harness: [] } };
  const BOARD = {
    mode: "teams",
    rows: [
      { teamId: "growth", members: 2, totalTokens: 1000, costUsd: 44.8, costPerOutcomeUsd: 2, outcomesProduced: 22 },
      { teamId: "platform", members: 2, totalTokens: 900, costUsd: 78.8, costPerOutcomeUsd: 4, outcomesProduced: 19 },
    ],
  };
  const MINE = {
    totalCostUsd: 5,
    totals: { input: 1, output: 1, cacheRead: 1, cacheWrite: 0 },
    byModel: [],
    byPhase: [],
  };
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const path = String(input);
    if (path.includes("/api/admin/utb/people")) return Response.json(PEOPLE);
    if (path.includes("/api/admin/utb/teams")) return Response.json(TEAMS);
    if (path.includes("/api/admin/utb/allocations")) return Response.json(ALLOCATIONS);
    if (path.includes("/api/admin/utb/leaderboard")) return Response.json(BOARD);
    if (path.includes("/api/admin/utb")) return Response.json(ORG_UTB);
    if (path.includes("/api/usage")) return Response.json(MINE);
    if (path.includes("/api/admin/receipts")) return Response.json(RECEIPTS);
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderUsage, resetUsageState } = await vite.ssrLoadModule("/src/usage.ts");
    appState.me = { user: "demo", org: "acme" };
    appState.currentView = "usage";
    appState.mainEl = document.querySelector("#main");
    resetUsageState();
    await renderUsage();

    const subjects = [...document.querySelectorAll(".usage-alloc-subject")].map((el) => ({
      chip: el.querySelector(".subj-chip")?.textContent?.trim(),
      name: el.querySelector(".subj-name")?.textContent?.trim(),
      id: el.querySelector(".subj-id")?.textContent?.trim(),
    }));
    assert.deepEqual(
      subjects,
      [
        { chip: "ORG", name: "Whole organization", id: undefined },
        { chip: "PERSON", name: "not-here", id: undefined },
      ],
      "usage resolves display names and carries the kind in a chip, not baked into the string",
    );
    const teamNames = [...document.querySelectorAll(".usage-team .subj-name")].map((el) => el.textContent?.trim());
    assert.deepEqual(teamNames, ["Growth", "Platform"], "the leaderboard names teams, it does not print raw ids");
  } finally {
    await vite.close();
  }
});

test("the drill-down names the cap that refuses first and demotes soft caps", async () => {
  installDom();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") !== "GET") return Response.json({ ok: true });
    if (path.includes("/api/admin/utb/people/")) return Response.json(DETAIL);
    if (path.includes("/api/admin/utb/people")) return Response.json(PEOPLE);
    if (path.includes("/api/admin/utb/teams")) return Response.json(TEAMS);
    if (path.includes("/api/admin/utb/allocations")) return Response.json(ALLOCATIONS);
    if (path.includes("/api/admin/receipts/")) return Response.json(RECEIPT);
    if (path.includes("/api/admin/receipts")) return Response.json(RECEIPTS);
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderGovernance, resetGovernanceState } = await vite.ssrLoadModule("/src/governance.ts");
    appState.me = { user: "demo", org: "acme" };
    appState.currentView = "governance";
    appState.mainEl = document.querySelector("#main");
    resetGovernanceState();
    await renderGovernance();

    document.querySelector<HTMLElement>(".gov-row")!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    const rows = [...document.querySelectorAll(".gov-stack-row")];
    assert.equal(rows.length, 2, "both governing caps are listed");
    assert.ok(rows[0]!.classList.contains("is-binding"), "the hard cap with the least headroom is first and badged");
    assert.match(rows[0]!.textContent ?? "", /refuses first/, "the binding cap says so");
    assert.ok(rows[1]!.classList.contains("is-soft"), "the soft cap is demoted");
    assert.match(rows[1]!.textContent ?? "", /warn only, never refuses/, "the soft cap is labelled non-enforcing");

    const receiptRow = document.querySelector<HTMLButtonElement>(".gov-drill .rcpt-list-row");
    assert.ok(receiptRow, "the drill-down lists the person's recent receipts");
    assert.match(receiptRow!.textContent ?? "", /Pushed code/, "each row names what the run produced");
    assert.match(receiptRow!.textContent ?? "", /\$0\.46/, "and what it cost");
    receiptRow!.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const paper = document.querySelector(".rcpt-paper");
    assert.ok(paper, "clicking a row opens the receipt");
    assert.match(paper!.textContent ?? "", /demo-run-14/, "the receipt is stamped with the run it settles");
    assert.match(paper!.textContent ?? "", /\$0\.4554/, "the total is the run's exact metered spend");
    assert.match(
      paper!.textContent ?? "",
      /\$0\.0024/,
      "a sub-cent line keeps its precision so the items still add up",
    );
    assert.match(paper!.textContent ?? "", /refuses the turn/, "the budget that can refuse a turn says so");
    assert.match(
      paper!.textContent ?? "",
      /priced by estimate/,
      "an estimated line is disclosed rather than passed off as reported",
    );
    document.querySelector<HTMLButtonElement>(".rcpt-close")!.click();
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(document.querySelector(".rcpt-paper"), null, "and it closes again");

    const orphan = [...document.querySelectorAll(".usage-alloc")].find((el) =>
      (el.textContent ?? "").includes("not-here"),
    );
    assert.ok(orphan, "the budgets card lists the unresolvable cap");
    assert.match(orphan!.textContent ?? "", /orphaned/, "an unresolvable subject is badged as orphaned");

    const teamForm = cardAction("New team");
    teamForm.click();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const parentSelect = [...document.querySelectorAll<HTMLSelectElement>(".gov-team-form select")].at(-1)!;
    assert.equal(parentSelect.getAttribute("aria-label"), "Parent team", "the create form offers a parent");
    assert.deepEqual(
      [...parentSelect.options].map((o) => o.value),
      ["", "platform", "growth"],
      "every existing team can be the parent",
    );
    assert.ok(
      [...document.querySelectorAll(".gov-team button")].some((b) => (b.textContent ?? "").trim() === "Edit"),
      "each team row can be reopened for rename or reparent",
    );
  } finally {
    await vite.close();
  }
});

test("a failed refresh keeps the last good data on screen and labels it as stale", async () => {
  installDom();
  let loadsFail = false;
  const fail = () => new Response(JSON.stringify({ error: "upstream error" }), { status: 502 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    if ((init?.method ?? "GET") !== "GET") return Response.json({ ok: true });
    if (loadsFail) return fail();
    if (path.includes("/api/admin/utb/people/")) return Response.json(DETAIL);
    if (path.includes("/api/admin/utb/people")) return Response.json(PEOPLE);
    if (path.includes("/api/admin/utb/teams")) return Response.json(TEAMS);
    if (path.includes("/api/admin/utb/allocations")) return Response.json(ALLOCATIONS);
    if (path.includes("/api/admin/receipts")) return Response.json(RECEIPTS);
    throw new Error(`Unexpected request: ${path}`);
  }) as typeof fetch;

  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: "custom" });
  try {
    const { appState } = await vite.ssrLoadModule("/src/shell-state.ts");
    const { renderGovernance, resetGovernanceState } = await vite.ssrLoadModule("/src/governance.ts");
    appState.me = { user: "demo", org: "acme" };
    appState.currentView = "governance";
    appState.mainEl = document.querySelector("#main");
    resetGovernanceState();

    await renderGovernance();
    const rows = document.querySelectorAll(".gov-row").length;
    assert.ok(rows > 0, "the page loads with roster rows");
    assert.equal(document.querySelector(".gov-stale"), null, "nothing is stale while loads succeed");

    loadsFail = true;
    await renderGovernance();

    assert.equal(document.querySelectorAll(".gov-row").length, rows, "the last good roster stays on screen");
    assert.ok(document.querySelector(".gov-stale"), "stale data is labelled as such");
    const banner = document.querySelector(".gov-notice");
    assert.ok(banner, "a failed page load is reported");
    assert.equal(banner!.getAttribute("role"), "alert", "and announced as an alert");
    assert.ok(
      [...banner!.querySelectorAll("button")].some((b) => (b.textContent ?? "").includes("Retry")),
      "and offers a retry",
    );
  } finally {
    await vite.close();
  }
});
