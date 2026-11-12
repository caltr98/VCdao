import { DurableObject } from "cloudflare:workers";
import { polygonProvider } from "./chain";
import { parseConfig, parseSettings, type RunnerState } from "./config";
import { failedRun, runTick, type Report, type Storage } from "./runner";
import { POLYGON } from "../../scripts/addresses";

/// One Durable Object per configured vault keeps the journal and the latest public report.
export class DaoRunner extends DurableObject<Env> {
  private running = false;

  async status() {
    return await this.ctx.storage.get<Report>("report") ?? { status: "awaiting-first-schedule" };
  }

  // Overlapping cron invocations reach the same object; the later one returns immediately.
  async tick() {
    if (this.running) return;
    this.running = true;
    const provider = polygonProvider(this.env.POLYGON_RPC_URL);
    try { await this.record(await this.runOnce(provider)); }
    finally { provider.destroy(); this.running = false; }
  }

  private async runOnce(provider: ReturnType<typeof polygonProvider>): Promise<Report> {
    try { return await runTick(parseSettings(this.env), { provider, storage: this.journal(), network: POLYGON }); }
    catch (error) { return failedRun("configuration", error); }
  }

  private journal(): Storage {
    return { load: () => this.ctx.storage.get<RunnerState>("state"), save: state => this.ctx.storage.put("state", state) };
  }

  private async record(report: Report) {
    await this.ctx.storage.put("report", report);
    console.log(JSON.stringify(report));
  }
}

export default {
  async fetch(request, env) {
    if (request.method !== "GET" || new URL(request.url).pathname !== "/health") return new Response("Not found", { status: 404 });
    const runner = env.RUNNER.getByName(runnerName(env.DAO_CONFIG));
    return Response.json(await runner.status(), { headers: { "Cache-Control": "no-store" } });
  },
  async scheduled(_controller, env, ctx) {
    const runner = env.RUNNER.getByName(runnerName(env.DAO_CONFIG));
    ctx.waitUntil(runner.tick());
  },
} satisfies ExportedHandler<Env>;

function runnerName(json: string) {
  try { return parseConfig(json)?.vault.toLowerCase() ?? "unconfigured"; }
  catch { return "invalid-configuration"; }
}
