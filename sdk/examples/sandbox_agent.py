"""A platform backend gives an agent in a sandbox its own recorded, undoable workspace.

1. The backend (holding the gpk_ platform key) finds or creates the customer's
   workspace and mints a short-lived write token for it.
2. The agent runs in a separate process (standing in for an E2B or Modal
   sandbox) that gets only the workspace URL and that token, never the
   platform key, and writes files with optimistic concurrency.
3. The backend lists the workspace's runs and undoes the agent's run.

Run:  GRAPIM_API_KEY=gpk_test_... python sdk/examples/sandbox_agent.py
      (GRAPIM_BASE_URL defaults to https://app.grapim.com)
"""

import json
import os
import re
import subprocess
import sys

# In your app, after `pip install grapim`, just `import grapim`.
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "python", "src"))

from grapim import Grapim, NotFoundError, PreconditionFailedError  # noqa: E402

AGENT = "fixer"


# ---------------------------------------------------------------- the platform backend

def platform() -> None:
    grapim = Grapim(base_url=os.environ.get("GRAPIM_BASE_URL", "https://app.grapim.com"))  # key from GRAPIM_API_KEY
    external_id = os.environ.get("CUSTOMER_ID", "customer_42")

    # One workspace per end customer, found by your own id.
    found = grapim.workspaces.list(external_id=external_id, limit=1).first_page()["data"]
    if found:
        ws = found[0]
    else:
        # Workspace names are URL slugs: [a-z0-9-], 1 to 40.
        name = re.sub(r"[^a-z0-9]+", "-", external_id.lower()).strip("-")[:40] or "workspace"
        ws = grapim.workspaces.create(external_id=external_id, name=name, metadata={"plan": "pro"})
    print(f"workspace {ws['id']} for {external_id}: {ws['url']}", flush=True)

    # A write token for this one workspace, valid 15 minutes, with the agent's name pinned.
    tok = grapim.tokens.create(ws["id"], scope="write", ttl_seconds=900, agent_name=AGENT)
    print(f"minted a write token for {AGENT}, expires at {tok['expires_at']}", flush=True)

    # Start the agent in its "sandbox". It gets the URL and token only.
    env = {"PATH": os.environ.get("PATH", ""), "GRAPIM_WORKSPACE_URL": ws["url"], "GRAPIM_WORKSPACE_TOKEN": tok["token"]}
    if "SYSTEMROOT" in os.environ:
        env["SYSTEMROOT"] = os.environ["SYSTEMROOT"]
    subprocess.run([sys.executable, os.path.abspath(__file__), "--agent"], env=env, check=True)

    # What did it do?
    runs = grapim.runs.list(ws["id"])
    for r in runs:
        print(f"run {r['run']}: {r['files']} file(s), +{r['added']} -{r['removed']}, review {r['review']['status']}")
    run = next((r for r in runs if r["run"].endswith("/" + AGENT) or r["label"] == AGENT), None)
    if run is None:
        raise SystemExit("The agent run is missing.")

    # Look at the plan first, then undo it.
    plan = grapim.runs.undo(ws["id"], run["run"], apply=False)
    for f in plan["files"]:
        print(f"  would {f['action']} {f['path']}" + (f" ({f['reason']})" if f.get("reason") else ""))
    done = grapim.runs.undo(ws["id"], run["run"], apply=True)
    print(f"undid {done['run']}: {len(done['files'])} file(s), applied={str(done['applied']).lower()}")

    # Let the customer review in your app: a single-use URL for an iframe.
    embed = grapim.embed_sessions.create(ws["id"], mode="review", ttl_seconds=600)
    print(f"review desk for the customer: {embed['url']}")


# ---------------------------------------------------------------- the agent, in the sandbox

def agent() -> None:
    if os.environ.get("GRAPIM_API_KEY"):
        raise SystemExit("The sandbox must not see the platform key.")
    ws = Grapim.workspace(
        os.environ["GRAPIM_WORKSPACE_URL"],
        os.environ["GRAPIM_WORKSPACE_TOKEN"],
        agent=AGENT,
        intent="Add a README and a config",
    )
    upsert(ws, "README.md", lambda old: (old or "# Demo\n") + "\nEdited by the fixer agent.\n")
    upsert(ws, "config/app.json", lambda old: json.dumps({"retries": 3}, indent=2) + "\n")
    ws.release()
    files = ws.list("", recursive=True)["files"]
    print("[agent] the workspace now has " + ", ".join(f["path"] for f in files), flush=True)


def upsert(ws, path, change):
    """Read, change, write back only if nobody wrote in between; on a clash, read again."""
    for _ in range(3):
        try:
            text, sha = ws.read_text(path)
        except NotFoundError:
            text, sha = None, None
        try:
            w = ws.write(path, change(text), if_match=sha or "absent")
            print(f"[agent] wrote {path} ({w['sha'][:8]})", flush=True)
            return w
        except PreconditionFailedError as e:
            print(f"[agent] {path} changed under us (now {(e.current_sha or 'absent')[:8]}), retrying", flush=True)
    raise SystemExit(f"{path} kept changing")


if __name__ == "__main__":
    agent() if sys.argv[1:] == ["--agent"] else platform()
