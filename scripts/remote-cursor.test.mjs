import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
  AuthRequiredError,
  ConfigError,
  DEFAULT_REPOSITORY,
  assertAgentId,
  assertAllowedRepository,
  buildFollowupPayload,
  buildLaunchPayload,
  parseArgs,
  resolveConfig,
  runRemoteCursor,
} from "./remote-cursor.mjs";

test("launch payload uses allowlisted repo and PR flag", () => {
  const payload = buildLaunchPayload({
    prompt: "Privacy metnini güncelle",
    repository: "https://github.com/berkyuo2-cpu/menajer-defteri-privacy.git",
    mode: "plan",
    autoCreatePr: false,
  });
  assert.deepEqual(payload, {
    prompt: { text: "Privacy metnini güncelle" },
    repos: [
      {
        url: "https://github.com/berkyuo2-cpu/menajer-defteri-privacy",
        startingRef: "main",
      },
    ],
    autoCreatePR: false,
    mode: "plan",
  });
});

test("rejects repositories outside berkyuo2-cpu", () => {
  assert.throws(
    () =>
      assertAllowedRepository("https://github.com/someone-else/secret-repo"),
    /izin listesinde değil/,
  );
});

test("rejects empty launch prompt", () => {
  assert.throws(
    () =>
      buildLaunchPayload({
        prompt: "  ",
        repository: DEFAULT_REPOSITORY,
        mode: "agent",
        autoCreatePr: true,
      }),
    /prompt gerekli/,
  );
});

test("followup payload requires bc-uuid", () => {
  assert.throws(() => assertAgentId("not-an-id"), /bc-uuid/);
  const payload = buildFollowupPayload({
    prompt: "CI kırıldı, düzelt",
    agentId: "bc-78ec5574-ace1-453c-9bac-d68448705793",
    mode: "agent",
  });
  assert.equal(payload.body.prompt.text, "CI kırıldı, düzelt");
});

test("resolveConfig reads GitHub Actions env without leaking key into action", () => {
  const config = resolveConfig(
    {
      CURSOR_REMOTE_ACTION: "launch",
      CURSOR_REMOTE_PROMPT: "çok satırlı\ngörev",
      CURSOR_REMOTE_REPOSITORY: DEFAULT_REPOSITORY,
      CURSOR_REMOTE_MODE: "agent",
      CURSOR_REMOTE_AUTO_CREATE_PR: "true",
      CURSOR_API_KEY: "crsr_test_not_for_logs",
    },
    ["node", "scripts/remote-cursor.mjs"],
  );
  assert.equal(config.action, "launch");
  assert.equal(config.prompt, "çok satırlı\ngörev");
  assert.equal(config.apiKey, "crsr_test_not_for_logs");
});

test("parseArgs maps CLI flags", () => {
  const args = parseArgs([
    "node",
    "scripts/remote-cursor.mjs",
    "list",
    "--dry-run",
  ]);
  assert.equal(args.action, "list");
  assert.equal(args.dryRun, true);
});

test("missing API key is AUTH_REQUIRED unless dry-run", async () => {
  await assert.rejects(
    () =>
      runRemoteCursor(
        {
          action: "list",
          prompt: "",
          repository: DEFAULT_REPOSITORY,
          agentId: "",
          mode: "agent",
          autoCreatePr: true,
          dryRun: false,
          apiKey: "",
        },
        { fetch: async () => { throw new Error("fetch should not run"); } },
      ),
    (error) => {
      assert.ok(error instanceof AuthRequiredError);
      assert.match(error.message, /AUTH_REQUIRED/);
      assert.equal(error.exitCode, 2);
      return true;
    },
  );
});

test("dry-run launch does not call fetch", async () => {
  const chunks = [];
  const result = await runRemoteCursor(
    {
      action: "launch",
      prompt: "README düzelt",
      repository: DEFAULT_REPOSITORY,
      agentId: "",
      mode: "agent",
      autoCreatePr: true,
      dryRun: true,
      apiKey: "",
    },
    {
      fetch: async () => {
        throw new Error("fetch should not run");
      },
      stdout: { write: (chunk) => chunks.push(chunk) },
    },
  );
  assert.equal(result.action, "launch");
  assert.match(chunks.join(""), /"autoCreatePR": true/);
});

test("list prints agent rows from API", async () => {
  const chunks = [];
  let calledUrl = "";
  await runRemoteCursor(
    {
      action: "list",
      prompt: "",
      repository: DEFAULT_REPOSITORY,
      agentId: "",
      mode: "agent",
      autoCreatePr: true,
      dryRun: false,
      apiKey: "crsr_test",
    },
    {
      fetch: async (url, init) => {
        calledUrl = String(url);
        assert.equal(init.headers.Authorization, "Bearer crsr_test");
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              items: [
                {
                  id: "bc-78ec5574-ace1-453c-9bac-d68448705793",
                  name: "Uzaktan imleç kontrol sistemi",
                  status: "ACTIVE",
                  url: "https://cursor.com/agents/bc-78ec5574-ace1-453c-9bac-d68448705793",
                },
              ],
            }),
        };
      },
      stdout: { write: (chunk) => chunks.push(chunk) },
    },
  );
  assert.match(calledUrl, /\/v1\/agents\?limit=20/);
  assert.match(chunks.join(""), /ACTIVE\tbc-78ec5574/);
});

test("unknown action fails closed", async () => {
  await assert.rejects(
    () =>
      runRemoteCursor(
        {
          action: "delete-prod",
          prompt: "",
          repository: DEFAULT_REPOSITORY,
          agentId: "",
          mode: "agent",
          autoCreatePr: true,
          dryRun: true,
          apiKey: "",
        },
        { fetch: async () => { throw new Error("no"); } },
      ),
    (error) => error instanceof ConfigError,
  );
});

test("kumanda page keeps official launch paths and does not ask for API keys", () => {
  const html = fs.readFileSync(
    path.resolve("kumanda/index.html"),
    "utf8",
  );
  const workflow = fs.readFileSync(
    path.resolve(".github/workflows/remote-cursor.yml"),
    "utf8",
  );
  assert.match(html, /https:\/\/cursor\.com\/agents/);
  assert.match(html, /https:\/\/github\.com\/berkyuo2-cpu\/berkyuo2-cpu\.github\.io\/actions\/workflows\/remote-cursor\.yml/);
  assert.doesNotMatch(html, /<input[^>]+type="password"/i);
  assert.match(html, /noindex/);
  assert.match(workflow, /secrets\.CURSOR_API_KEY/);
  assert.doesNotMatch(workflow, /echo \$\{?CURSOR_API_KEY/);
});
