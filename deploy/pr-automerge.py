#!/usr/bin/env python3
"""Enable GitHub auto-merge for approved pull requests that pass all local gates."""
import json
import subprocess
from datetime import datetime, timezone

AUTHOR = "usmaneth"
ADVISORY = {"Cursor Bugbot", "Greptile Review", "GitGuardian Security Checks"}
REPOS = [
    "zeta-chain/ai-memoryless-client",
    "zeta-chain/ai-portal",
    "anuma-ai/nearby",
    "anuma-ai/sdk",
]


def log(message):
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%SZ")
    print(f"{stamp}  {message}", flush=True)


def gh(args, timeout=120):
    try:
        result = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return None, "timeout"
    if result.returncode:
        return None, (result.stderr or result.stdout).strip()[:300]
    return result.stdout, None


def gh_json(args):
    output, error = gh(args)
    if output is None:
        return None, error
    try:
        return json.loads(output), None
    except Exception as exc:
        return None, str(exc)


def open_prs(repo):
    value, error = gh_json([
        "pr", "list", "--repo", repo, "--author", AUTHOR, "--state", "open",
        "--limit", "50", "--json", "number,isDraft,title",
    ])
    if value is None:
        log(f"WARN {repo}: cannot list pull requests ({error})")
        return []
    return [item for item in value if not item.get("isDraft")]


def unresolved_threads(repo, number):
    owner, name = repo.split("/")
    query = (
        '{ repository(owner:"%s", name:"%s") { pullRequest(number:%d) { '
        "reviewThreads(first:100){ nodes { isResolved isOutdated } } } } }"
        % (owner, name, number)
    )
    value, _ = gh_json(["api", "graphql", "-f", "query=" + query])
    if value is None:
        return None
    try:
        nodes = value["data"]["repository"]["pullRequest"]["reviewThreads"]["nodes"]
        return len([item for item in nodes if not item["isResolved"] and not item["isOutdated"]])
    except Exception:
        return None


def details(repo, number):
    value, _ = gh_json([
        "pr", "view", str(number), "--repo", repo, "--json",
        "state,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest",
    ])
    if value is None:
        return None
    failed = []
    pending = []
    for check in value.get("statusCheckRollup") or []:
        name = check.get("name") or check.get("context") or "?"
        state = check.get("conclusion") or check.get("state") or ""
        if name in ADVISORY:
            continue
        if state in ("FAILURE", "ERROR", "TIMED_OUT", "CANCELLED"):
            failed.append(name)
        elif state in ("PENDING", "IN_PROGRESS", "QUEUED", "", None):
            pending.append(name)
    value["_failed"] = failed
    value["_pending"] = pending
    return value


def consider(repo, pr):
    number = pr["number"]
    tag = f"{repo.split('/')[-1]}#{number}"
    value = details(repo, number)
    if not value or value.get("state") != "OPEN":
        return "unreadable"
    if value.get("autoMergeRequest"):
        return "queued"
    if value.get("reviewDecision") != "APPROVED":
        return "awaiting-approval"
    threads = unresolved_threads(repo, number)
    if threads is None:
        return "threads-unknown"
    if threads:
        return "threads-open"
    if value.get("mergeable") == "CONFLICTING":
        return "conflicting"
    if value.get("mergeStateStatus") == "BEHIND":
        output, error = gh(["pr", "update-branch", str(number), "--repo", repo])
        log(f"{tag} behind main - {'updated' if error is None else 'update failed: ' + error}")
        return "updated-from-main"
    if value["_failed"]:
        return "ci-failing"
    if value["_pending"]:
        return "checks-pending"
    _, error = gh(["pr", "merge", str(number), "--repo", repo, "--auto", "--squash"])
    if error is None:
        log(f"QUEUED {tag} - {pr.get('title', '')[:70]}")
        return "queued"
    log(f"{tag} auto-merge refused: {error}")
    return "merge-refused"


def main():
    tally = {}
    for repo in REPOS:
        for pr in open_prs(repo):
            try:
                verdict = consider(repo, pr)
            except Exception as exc:
                verdict = "error"
                log(f"ERROR {repo}#{pr.get('number')}: {exc}")
            tally[verdict] = tally.get(verdict, 0) + 1
    log("pass: " + "  ".join(f"{key}={value}" for key, value in sorted(tally.items())))


if __name__ == "__main__":
    main()
