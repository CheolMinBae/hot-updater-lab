#!/usr/bin/env python3
"""Plan/create/remove the lab's GitHub OIDC role; writes require --execute."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import uuid


ROOT = Path(__file__).resolve().parents[1]
STATE_PATH = ROOT / "work/github-oidc-state.json"
REPO_PATH = ROOT / "work/github-repo.json"
ACCOUNT = "342170456378"
REGION = "ap-northeast-2"
ROLE_NAME = "hot-updater-lab-github"
POLICY_NAME = "hot-updater-lab-s3"
PROVIDER_URL = "https://token.actions.githubusercontent.com"
PROVIDER_ARN = f"arn:aws:iam::{ACCOUNT}:oidc-provider/token.actions.githubusercontent.com"
ROLE_ARN = f"arn:aws:iam::{ACCOUNT}:role/{ROLE_NAME}"
OWNER_TAG = "HotUpdaterLabOwner"


def aws(*arguments, missing=False):
    result = subprocess.run(
        ["aws", *arguments, "--region", REGION, "--output", "json"],
        capture_output=True, text=True, timeout=60,
        env={**os.environ, "AWS_PAGER": ""},
    )
    if result.returncode:
        if missing and "NoSuchEntity" in result.stderr:
            return None
        raise RuntimeError(f"AWS {' '.join(arguments[:2])} failed: {result.stderr.strip()}")
    return json.loads(result.stdout) if result.stdout.strip() else {}


def save(state):
    STATE_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE_PATH.with_suffix(".tmp")
    with temporary.open("w", encoding="utf8") as handle:
        json.dump(state, handle, indent=2)
        handle.write("\n")
    temporary.chmod(0o600)
    temporary.replace(STATE_PATH)


def repository():
    if REPO_PATH.exists():
        repo = json.loads(REPO_PATH.read_text())
    else:
        result = subprocess.run(
            ["gh", "api", "repos/CheolMinBae/hot-updater-lab"],
            check=True, capture_output=True, text=True, timeout=30,
        )
        repo = json.loads(result.stdout)
    if repo.get("full_name") != "CheolMinBae/hot-updater-lab":
        raise RuntimeError("Unexpected GitHub repository; refusing to configure trust")
    if not isinstance(repo.get("id"), int) or repo["id"] <= 0:
        raise RuntimeError("GitHub numeric repository ID is missing")
    return repo


def documents(bucket, repo):
    subjects = [
        "repo:CheolMinBae/hot-updater-lab:ref:refs/heads/main",
        f"repo:CheolMinBae@3682683/hot-updater-lab@{repo['id']}:ref:refs/heads/main",
    ]
    trust = {
        "Version": "2012-10-17",
        "Statement": [{
            "Effect": "Allow",
            "Principal": {"Federated": PROVIDER_ARN},
            "Action": "sts:AssumeRoleWithWebIdentity",
            "Condition": {"StringEquals": {
                "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
                "token.actions.githubusercontent.com:sub": subjects,
            }},
        }],
    }
    bucket_arn = f"arn:aws:s3:::{bucket}"
    permissions = {
        "Version": "2012-10-17",
        "Statement": [
            {"Sid": "BucketRegion", "Effect": "Allow", "Action": "s3:GetBucketLocation", "Resource": bucket_arn},
            {
                "Sid": "ListLabPrefixes", "Effect": "Allow", "Action": "s3:ListBucket",
                "Resource": bucket_arn,
                "Condition": {"StringLike": {"s3:prefix": ["metadata", "metadata/*", "bundles", "bundles/*"]}},
            },
            {
                "Sid": "PublishLabObjects", "Effect": "Allow",
                "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:AbortMultipartUpload", "s3:ListMultipartUploadParts"],
                "Resource": [f"{bucket_arn}/metadata/*", f"{bucket_arn}/bundles/*"],
            },
        ],
    }
    return trust, permissions


def is_owned(resource, state):
    return any(tag.get("Key") == OWNER_TAG and tag.get("Value") == state["ownership_token"]
               for tag in resource.get("Tags", []))


def assert_account():
    if aws("sts", "get-caller-identity")["Account"] != ACCOUNT:
        raise RuntimeError(f"Expected AWS account {ACCOUNT}; no changes made")


def up(args):
    repo = repository()
    trust, permissions = documents(args.bucket, repo)
    state = json.loads(STATE_PATH.read_text()) if STATE_PATH.exists() else {
        "schema_version": 1,
        "account": ACCOUNT,
        "region": REGION,
        "bucket": args.bucket,
        "repository": repo["full_name"],
        "repository_id": repo["id"],
        "ownership_token": str(uuid.uuid4()),
    }
    for key, value in {"account": ACCOUNT, "bucket": args.bucket, "repository_id": repo["id"]}.items():
        if state.get(key) != value:
            raise RuntimeError(f"State {key} differs from requested configuration")
    if not args.execute:
        print(json.dumps({"mode": "plan", "role_arn": ROLE_ARN, "provider_arn": PROVIDER_ARN,
                          "trust": trust, "permissions": permissions}, indent=2))
        return

    assert_account()
    save(state)
    tags = [{"Key": OWNER_TAG, "Value": state["ownership_token"]},
            {"Key": "Project", "Value": "hot-updater-lab"}]
    provider = aws("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", PROVIDER_ARN, missing=True)
    if provider is None:
        # Record intent before creating, so interrupted executions remain recoverable.
        state["provider"] = {"arn": PROVIDER_ARN, "owned": True, "status": "creating"}
        save(state)
        aws("iam", "create-open-id-connect-provider", "--url", PROVIDER_URL,
            "--client-id-list", "sts.amazonaws.com", "--tags", json.dumps(tags))
        state["provider"]["status"] = "created"
        save(state)
    else:
        if "sts.amazonaws.com" not in provider.get("ClientIDList", []):
            raise RuntimeError("Existing GitHub provider lacks sts.amazonaws.com; leaving it unchanged")
        if state.get("provider", {}).get("owned") and not is_owned(provider, state):
            raise RuntimeError("Provider ownership tag does not match state")
        state["provider"] = {"arn": PROVIDER_ARN, "owned": is_owned(provider, state), "status": "available"}
        save(state)

    result = aws("iam", "get-role", "--role-name", ROLE_NAME, missing=True)
    if result is None:
        state["role"] = {"arn": ROLE_ARN, "name": ROLE_NAME, "owned": True, "status": "creating"}
        save(state)
        aws("iam", "create-role", "--role-name", ROLE_NAME,
            "--assume-role-policy-document", json.dumps(trust), "--max-session-duration", "3600",
            "--description", "Hot Updater lab GitHub main-branch S3 deployment",
            "--tags", json.dumps(tags))
        state["role"]["status"] = "created"
        save(state)
    else:
        if not is_owned(result["Role"], state):
            raise RuntimeError(f"Existing role {ROLE_NAME} is not owned by this state; leaving it unchanged")
        state["role"] = {"arn": ROLE_ARN, "name": ROLE_NAME, "owned": True, "status": "available"}
        save(state)
        aws("iam", "update-assume-role-policy", "--role-name", ROLE_NAME,
            "--policy-document", json.dumps(trust))

    state["policy"] = {"name": POLICY_NAME, "role_name": ROLE_NAME, "owned": True, "status": "creating"}
    save(state)
    aws("iam", "put-role-policy", "--role-name", ROLE_NAME,
        "--policy-name", POLICY_NAME, "--policy-document", json.dumps(permissions))
    state["policy"]["status"] = "created"
    state["status"] = "ready"
    save(state)
    print(json.dumps({"role_arn": ROLE_ARN, "bucket": args.bucket, "repository_id": repo["id"],
                      "state_file": str(STATE_PATH)}, indent=2))


def references(value, target):
    if isinstance(value, dict):
        return any(references(child, target) for child in value.values())
    if isinstance(value, list):
        return any(references(child, target) for child in value)
    return value == target


def down(args):
    if not STATE_PATH.exists():
        raise RuntimeError("No ownership state exists; refusing to infer resources to delete")
    state = json.loads(STATE_PATH.read_text())
    if state.get("account") != ACCOUNT or state.get("bucket") != args.bucket:
        raise RuntimeError("State account/bucket does not match requested configuration")
    if not args.execute:
        print(json.dumps({"mode": "plan-delete-owned-only", "role": state.get("role"),
                          "policy": state.get("policy"), "provider": state.get("provider"),
                          "provider_guard": "Delete only if owned and no IAM role references it."}, indent=2))
        return

    assert_account()
    if state.get("role", {}).get("owned"):
        if state["role"].get("arn") != ROLE_ARN:
            raise RuntimeError("Unexpected role ARN in state")
        result = aws("iam", "get-role", "--role-name", ROLE_NAME, missing=True)
        if result:
            if not is_owned(result["Role"], state):
                raise RuntimeError("Role ownership tag mismatch; refusing deletion")
            if state.get("policy", {}).get("owned"):
                if state["policy"].get("name") != POLICY_NAME:
                    raise RuntimeError("Unexpected policy name in state")
                aws("iam", "delete-role-policy", "--role-name", ROLE_NAME, "--policy-name", POLICY_NAME, missing=True)
                state["policy"]["status"] = "deleted"
                save(state)
            inline = aws("iam", "list-role-policies", "--role-name", ROLE_NAME)["PolicyNames"]
            attached = aws("iam", "list-attached-role-policies", "--role-name", ROLE_NAME)["AttachedPolicies"]
            profiles = aws("iam", "list-instance-profiles-for-role", "--role-name", ROLE_NAME)["InstanceProfiles"]
            if inline or attached or profiles:
                raise RuntimeError("Role has other policies/instance profiles; preserving it for review")
            aws("iam", "delete-role", "--role-name", ROLE_NAME)
        state["role"]["status"] = "deleted"
        save(state)

    if state.get("provider", {}).get("owned"):
        if state["provider"].get("arn") != PROVIDER_ARN:
            raise RuntimeError("Unexpected OIDC provider ARN in state")
        provider = aws("iam", "get-open-id-connect-provider", "--open-id-connect-provider-arn", PROVIDER_ARN, missing=True)
        if provider:
            if not is_owned(provider, state):
                raise RuntimeError("Provider ownership tag mismatch; refusing deletion")
            roles = aws("iam", "list-roles")["Roles"]
            consumers = [role["RoleName"] for role in roles
                         if references(role.get("AssumeRolePolicyDocument"), PROVIDER_ARN)]
            if consumers:
                state["provider"]["status"] = "preserved-in-use"
                save(state)
                print(json.dumps({"provider_preserved": PROVIDER_ARN, "referenced_by": consumers}, indent=2))
            else:
                aws("iam", "delete-open-id-connect-provider", "--open-id-connect-provider-arn", PROVIDER_ARN)
                state["provider"]["status"] = "deleted"
                save(state)
        else:
            state["provider"]["status"] = "deleted"
            save(state)
    state["status"] = "removed-owned-role"
    save(state)
    print(json.dumps({"status": state["status"], "state_file": str(STATE_PATH)}, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["up", "down"])
    parser.add_argument("--bucket", required=True, help="Existing dedicated lab S3 bucket")
    parser.add_argument("--execute", action="store_true", help="Apply changes; omitted means plan only")
    args = parser.parse_args()
    if not re.fullmatch(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]", args.bucket):
        parser.error("--bucket must be an S3 bucket name, not an ARN or URI")
    (up if args.action == "up" else down)(args)


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, subprocess.SubprocessError) as error:
        print(f"ERROR: {error}", file=sys.stderr)
        sys.exit(1)
