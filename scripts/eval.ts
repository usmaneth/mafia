#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { TeamService } from "../src/team";

const repoRoot = new URL("..", import.meta.url).pathname;
const check = spawnSync("bun", ["run", "check"], { cwd: repoRoot, stdio: "inherit" });
if (check.status !== 0) process.exit(check.status ?? 1);

if (!process.argv.includes("--live")) {
  console.log("mafia eval: deterministic checks passed");
  process.exit(0);
}

const spec = await Bun.file(join(repoRoot, "examples", "smoke-team.json")).json();
const teams = new TeamService();
const team = teams.create(spec.goal, spec);
console.log(`mafia eval: started ${team.id}`);

while (true) {
  const current = teams.get(team.id);
  if (current.state !== "queued" && current.state !== "running") {
    console.log(teams.collect(team.id));
    process.exit(current.state === "succeeded" ? 0 : 1);
  }
  await Bun.sleep(2000);
}
