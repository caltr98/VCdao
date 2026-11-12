import { env, SELF, createExecutionContext, createScheduledController, runInDurableObject, waitOnExecutionContext } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { polygonProvider } from "../src/chain";
import { parseSettings } from "../src/config";
import { runTick } from "../src/runner";
import { authHeaders } from "../src/transport";
import { POLYGON } from "../../scripts/addresses";

declare module "cloudflare:test" { interface ProvidedEnv extends Env {} }

describe("Hosted trigger runtime", () => {
  it("persists an honest unconfigured status after a scheduled invocation", async () => {
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env, ctx);
    await waitOnExecutionContext(ctx);
    const report = await env.RUNNER.getByName("unconfigured").status();
    expect(report.status).toBe("needs-deployment-config");
    expect(typeof report.checkedAt).toBe("string");
  });

  it("serves the stored report only through GET /health, uncached, with no transaction endpoint", async () => {
    const response = await SELF.fetch("https://example.com/health");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).not.toContain("GAS_PRIVATE_KEY");
    expect((await SELF.fetch("https://example.com/health", { method: "POST" })).status).toBe(404);
    expect((await SELF.fetch("https://example.com/execute", { method: "POST" })).status).toBe(404);
  });

  // The first tick is held open, as a slow RPC would; the second must return without running.
  it("runs one tick at a time when scheduled calls overlap", async () => {
    await runInDurableObject(env.RUNNER.getByName("overlap"), async (instance: any) => {
      let runs = 0, finish = () => {};
      instance.runOnce = async () => { runs++; await new Promise<void>(resolve => { finish = resolve; }); return { checkedAt: "held", status: "ok", issues: [] }; };
      const first = instance.tick();
      await instance.tick();
      expect(runs).toBe(1);
      finish();
      await first;
      expect(runs).toBe(1);
      expect((await instance.status()).checkedAt).toBe("held");
    });
  });

  // Expected value computed by polymarket-client 0.11.0's build_hmac_signature for the same inputs.
  it("signs CLOB requests like the official SDK for a URL-safe base64 secret", () => {
    const credentials = { address: "0x1111111111111111111111111111111111111111", key: "k", secret: "--___j4_AQID", passphrase: "p" };
    expect(authHeaders(credentials, "1700000000", "GET", "/data/order/0xabc").POLY_SIGNATURE).toBe("wu_QeGAp5Wi5V5qPCATja-EruSPq794eHxJKQTCv-5w=");
  });

  // The configured path in this runtime: the RPC is unreachable, so the tick must fail before any
  // transaction and report nothing secret, including a key-bearing RPC URL.
  it("fails closed with a configured DAO and an unreachable RPC without exposing secrets", async () => {
    const rpc = "http://127.0.0.1:9/v2/rpc-api-key-value";
    const key = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
    const clob = JSON.stringify({ address: "0x1111111111111111111111111111111111111111", key: "api-key-value", secret: "c2VjcmV0LXZhbHVl", passphrase: "passphrase-value" });
    const config = JSON.stringify({ governor: "0x2222222222222222222222222222222222222222", vault: "0x3333333333333333333333333333333333333333", automation: "0x4444444444444444444444444444444444444444", startBlock: 1 });
    const settings = parseSettings({ DAO_CONFIG: config, EXECUTION_ENABLED: "true", ORDER_SUBMISSION_ENABLED: "true", MAX_TOTAL_GAS_WEI: "1000", GAS_PRIVATE_KEY: key, CLOB_CREDENTIALS: clob });
    let saves = 0;
    const provider = polygonProvider(rpc);
    const report = await runTick(settings, { provider, network: POLYGON, storage: { load: async () => undefined, save: async () => { saves++; } } });
    provider.destroy();
    expect(report).toMatchObject({ status: "run-failed", phase: "deployment-validation", mode: "execution+submission" });
    expect(saves).toBe(0);
    for (const secret of [key.slice(2), "rpc-api-key-value", "api-key-value", "c2VjcmV0LXZhbHVl", "passphrase-value"]) expect(JSON.stringify(report)).not.toContain(secret);
  });

  it("prices transactions from the configured RPC, not ethers' external Polygon gas station", async () => {
    const provider = polygonProvider("https://rpc.invalid");
    const network = await provider.getNetwork();
    expect(network.chainId).toBe(137n);
    expect(network.getPlugin("org.ethers.plugins.network.FetchUrlFeeDataPlugin")).toBeNull();
    provider.destroy();
  });
});
