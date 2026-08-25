#!/usr/bin/env bun
import { ControlPlane, artifact } from "./control";
import { messageTypes, type MessageType } from "./types";

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function required(value: string | undefined, message: string): string {
  if (!value) throw new Error(message);
  return value;
}

function context() {
  const stateRoot = required(process.env.MAFIA_STATE_ROOT, "MAFIA_STATE_ROOT is not set.");
  const jobId = required(process.env.MAFIA_JOB_ID, "MAFIA_JOB_ID is not set.");
  return {
    stateRoot,
    jobId,
    teamId: process.env.MAFIA_TEAM_ID || undefined,
    host: process.env.MAFIA_HOST || "local",
    room: process.env.MAFIA_ROOM || (process.env.MAFIA_TEAM_ID ? `team:${process.env.MAFIA_TEAM_ID}` : "mafia"),
  };
}

function usage(): void {
  console.log(`mafia-agent - worker communication

usage:
  mafia-agent inbox [--read] [--json]
  mafia-agent send --body TEXT [--type TYPE] [--to JOB] [--room ROOM]
  mafia-agent broadcast --body TEXT [--type TYPE]
  mafia-agent artifact PATH [--description TEXT] [--kind TYPE]
  mafia-agent presence

types: ${messageTypes.join(", ")}`);
}

async function main(args = process.argv.slice(2)): Promise<void> {
  if (!args[0] || args[0] === "help" || args.includes("--help")) return usage();
  const ctx = context();
  const control = new ControlPlane(ctx.stateRoot);
  if (args[0] === "inbox") {
    const messages = control.inbox(ctx.jobId, args.includes("--read"));
    if (args.includes("--json")) console.log(JSON.stringify(messages, null, 2));
    else {
      for (const message of messages) {
        console.log(`[${message.type}] ${message.from}${message.to ? ` -> ${message.to}` : ""}: ${message.body}`);
        for (const ref of message.artifacts) console.log(`  artifact: ${ref.path}`);
      }
    }
    return;
  }
  if (args[0] === "send" || args[0] === "broadcast") {
    const type = (option(args, "--type") ?? "message") as MessageType;
    if (!messageTypes.includes(type)) throw new Error(`Unknown message type: ${type}`);
    const value = control.send({
      teamId: ctx.teamId,
      room: option(args, "--room") ?? ctx.room,
      from: ctx.jobId,
      to: args[0] === "broadcast" ? undefined : option(args, "--to"),
      type,
      body: required(option(args, "--body"), "--body is required."),
      host: ctx.host,
      jobId: ctx.jobId,
    });
    control.deliverLocal(value);
    console.log(value.id);
    return;
  }
  if (args[0] === "artifact") {
    const path = required(args[1], "The artifact path is required.");
    const ref = artifact(path, option(args, "--description"), option(args, "--kind"));
    const message = control.send({
      teamId: ctx.teamId,
      room: ctx.room,
      from: ctx.jobId,
      type: "finding",
      body: ref.description ?? `Artifact: ${path}`,
      artifacts: [ref],
      host: ctx.host,
      jobId: ctx.jobId,
    });
    control.deliverLocal(message);
    console.log(JSON.stringify(ref));
    return;
  }
  if (args[0] === "presence") {
    control.event({
      teamId: ctx.teamId,
      jobId: ctx.jobId,
      host: ctx.host,
      actor: ctx.jobId,
      type: "presence.heartbeat",
      data: { pid: process.ppid },
    });
    console.log("present");
    return;
  }
  throw new Error(`Unknown command: ${args[0]}`);
}

main().catch((error) => {
  console.error(`mafia-agent: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
