#!/usr/bin/env python3
"""Create/clean up isolated Hot Updater storage for one existing EC2 instance.

No instance, security group, or existing instance profile is changed/replaced.
Run `plan` without credentials; cloud changes require `up/down --execute`.
Keep work/ec2-storage-state.json until cleanup has completed.
Stop the application before cleanup so it does not continue writing to S3.
"""

import argparse
import datetime as dt
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
STATE = ROOT / "work/ec2-storage-state.json"
PROJECT = "hot-updater-lab"


class CommandError(RuntimeError):
    def __init__(self, operation, detail):
        self.detail = detail
        match = re.search(r"\(([^)]+)\)", detail)
        self.code = match.group(1) if match else "CommandFailed"
        # AWS CLI stderr never includes stdout or a credential file dump.
        super().__init__(f"{operation}: {detail.strip()[:500]}")


def aws(*args):
    proc = subprocess.run(
        ["aws", "--region", cfg.region, "--output", "json", "--no-cli-pager",
         "--no-cli-auto-prompt", *args], capture_output=True, text=True,
        env={**os.environ, "AWS_PAGER": ""},
    )
    if proc.returncode:
        raise CommandError(" ".join(args[:2]), proc.stderr)
    return json.loads(proc.stdout) if proc.stdout.strip() else {}


def save():
    STATE.parent.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.chmod(0o600)
    temporary.replace(STATE)


def remember(key, value):
    state["owned"][key] = value
    save()


def forget(key):
    state["owned"].pop(key, None)
    save()


def tags():
    return [{"Key": "Project", "Value": PROJECT},
            {"Key": "RunId", "Value": state["runId"]}]


def associations():
    return aws("ec2", "describe-iam-instance-profile-associations", "--filters",
               f"Name=instance-id,Values={cfg.instance_id}")["IamInstanceProfileAssociations"]


def verify_instance():
    reservations = aws("ec2", "describe-instances", "--instance-ids", cfg.instance_id)["Reservations"]
    instance = reservations[0]["Instances"][0]
    active = [a for a in associations() if a["State"] != "disassociated"]
    known = state["owned"].get("association", {})
    if known and not active:
        raise RuntimeError("Recorded profile association is gone; inspect the journal before recreating it.")
    if any(a["AssociationId"] != known.get("AssociationId") for a in active):
        raise RuntimeError("Instance already has an unowned profile association; refusing to replace it.")
    profile = instance.get("IamInstanceProfile")
    if profile and profile["Arn"] != known.get("IamInstanceProfile", {}).get("Arn"):
        raise RuntimeError("Instance already has an unowned IAM profile; refusing to replace it.")


def verify_bucket():
    item = state["owned"]["bucket"]
    aws("s3api", "head-bucket", "--bucket", item["name"], "--expected-bucket-owner", cfg.account_id)
    if item.get("tagged"):
        found = aws("s3api", "get-bucket-tagging", "--bucket", item["name"], "--expected-bucket-owner", cfg.account_id)["TagSet"]
        if {tag["Key"]: tag["Value"] for tag in found}.get("RunId") != state["runId"]:
            raise RuntimeError("Bucket ownership tag changed; refusing to modify it.")


def up():
    verify_instance()
    owned, bucket, role, profile = state["owned"], state["bucket"], state["role"], state["profile"]
    if not owned.get("bucket"):
        options = [] if cfg.region == "us-east-1" else ["--create-bucket-configuration", f"LocationConstraint={cfg.region}"]
        # A unique name is never adopted after an AlreadyExists error.
        aws("s3api", "create-bucket", "--bucket", bucket, *options)
        remember("bucket", {"name": bucket})
    else:
        verify_bucket()
    aws("s3api", "put-bucket-tagging", "--bucket", bucket,
        "--expected-bucket-owner", cfg.account_id, "--tagging", json.dumps({"TagSet": tags()}))
    remember("bucket", {"name": bucket, "tagged": True})
    aws("s3api", "put-public-access-block", "--bucket", bucket,
        "--expected-bucket-owner", cfg.account_id, "--public-access-block-configuration",
        json.dumps(dict.fromkeys(["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"], True)))
    aws("s3api", "put-bucket-encryption", "--bucket", bucket,
        "--expected-bucket-owner", cfg.account_id, "--server-side-encryption-configuration",
        json.dumps({"Rules": [{"ApplyServerSideEncryptionByDefault": {"SSEAlgorithm": "AES256"}}]}))
    if not owned.get("role"):
        trust = {"Version": "2012-10-17", "Statement": [{"Effect": "Allow", "Principal": {"Service": "ec2.amazonaws.com"}, "Action": "sts:AssumeRole"}]}
        result = aws("iam", "create-role", "--role-name", role, "--assume-role-policy-document", json.dumps(trust), "--tags", json.dumps(tags()))["Role"]
        remember("role", {"name": role, "id": result["RoleId"], "arn": result["Arn"]})
    else:
        check_identity("role")
    policy = {"Version": "2012-10-17", "Statement": [
        {"Effect": "Allow", "Action": ["s3:ListBucket", "s3:GetBucketLocation"], "Resource": f"arn:aws:s3:::{bucket}"},
        {"Effect": "Allow", "Action": ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], "Resource": f"arn:aws:s3:::{bucket}/*"},
    ]}
    aws("iam", "put-role-policy", "--role-name", role, "--policy-name", "HotUpdaterStorage", "--policy-document", json.dumps(policy))
    remember("rolePolicy", "HotUpdaterStorage")
    if not owned.get("profile"):
        result = aws("iam", "create-instance-profile", "--instance-profile-name", profile, "--tags", json.dumps(tags()))["InstanceProfile"]
        remember("profile", {"name": profile, "id": result["InstanceProfileId"], "arn": result["Arn"]})
    profile_data = check_identity("profile")
    names = [r["RoleName"] for r in profile_data["Roles"]]
    if names and names != [role]:
        raise RuntimeError("Owned profile now contains another role; refusing to modify it.")
    if not names:
        aws("iam", "add-role-to-instance-profile", "--instance-profile-name", profile, "--role-name", role)
    remember("profileRole", True)
    if not owned.get("association"):
        for attempt in range(8):
            verify_instance()
            try:
                result = aws("ec2", "associate-iam-instance-profile", "--instance-id", cfg.instance_id, "--iam-instance-profile", f"Arn={owned['profile']['arn']}")["IamInstanceProfileAssociation"]
                remember("association", result)
                break
            except CommandError as error:
                if attempt == 7 or error.code not in ("InvalidParameterValue", "InvalidParameter"):
                    raise
                print("Waiting 5s for IAM instance profile propagation...", flush=True)
                time.sleep(5)
    state["status"] = "active"
    save()
    print(json.dumps({"S3_BUCKET_NAME": bucket, "AWS_REGION": cfg.region,
                      "EC2_ROLE_ARN": owned["role"]["arn"],
                      "association": owned["association"]["AssociationId"]}, indent=2))


def check_identity(kind):
    item = state["owned"][kind]
    if kind == "role":
        value = aws("iam", "get-role", "--role-name", item["name"])["Role"]
        identifier = value["RoleId"]
    else:
        value = aws("iam", "get-instance-profile", "--instance-profile-name", item["name"])["InstanceProfile"]
        identifier = value["InstanceProfileId"]
    if identifier != item["id"]:
        raise RuntimeError(f"{kind} identity changed; refusing to touch a replacement resource.")
    return value


def down():
    owned = state["owned"]
    association = owned.get("association")
    if association:
        active = [a for a in associations() if a["AssociationId"] == association["AssociationId"] and a["State"] != "disassociated"]
        if active:
            if active[0]["IamInstanceProfile"]["Arn"] != association["IamInstanceProfile"]["Arn"]:
                raise RuntimeError("Association profile changed; cleanup stopped.")
            if active[0]["State"] != "disassociating":
                aws("ec2", "disassociate-iam-instance-profile", "--association-id", association["AssociationId"])
            for _ in range(12):
                if not any(a["AssociationId"] == association["AssociationId"] and a["State"] != "disassociated" for a in associations()):
                    break
                time.sleep(5)
            else:
                raise RuntimeError("Disassociation is still propagating; rerun down later.")
        forget("association")
    if owned.get("profile"):
        try:
            profile = check_identity("profile")
            all_associations = aws("ec2", "describe-iam-instance-profile-associations")["IamInstanceProfileAssociations"]
            if any(a["State"] != "disassociated" and a.get("IamInstanceProfile", {}).get("Arn") == profile["Arn"] for a in all_associations):
                raise RuntimeError("The profile is still associated with an instance; refusing deletion.")
            names = [r["RoleName"] for r in profile["Roles"]]
            if any(name != state["role"] for name in names):
                raise RuntimeError("Another role was added to the profile; refusing cleanup.")
            if names:
                aws("iam", "remove-role-from-instance-profile", "--instance-profile-name", state["profile"], "--role-name", state["role"])
            aws("iam", "delete-instance-profile", "--instance-profile-name", state["profile"])
        except CommandError as error:
            if error.code != "NoSuchEntity":
                raise
        forget("profile")
        forget("profileRole")
    if owned.get("role"):
        try:
            check_identity("role")
            if owned.get("rolePolicy"):
                try:
                    aws("iam", "delete-role-policy", "--role-name", state["role"], "--policy-name", owned["rolePolicy"])
                except CommandError as error:
                    if error.code != "NoSuchEntity":
                        raise
            aws("iam", "delete-role", "--role-name", state["role"])
        except CommandError as error:
            if error.code != "NoSuchEntity":
                raise
        forget("role")
        forget("rolePolicy")
    if owned.get("bucket"):
        bucket = owned["bucket"]["name"]
        try:
            verify_bucket()
            # No versioning is enabled by this helper. Refuse unexpected versions.
            versioning = aws("s3api", "get-bucket-versioning", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id)
            if versioning.get("Status"):
                raise RuntimeError("Bucket versioning was changed externally; inspect before cleanup.")
            while True:
                uploads = aws("s3api", "list-multipart-uploads", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id, "--max-uploads", "1000", "--no-paginate").get("Uploads", [])
                if not uploads:
                    break
                for upload in uploads:
                    aws("s3api", "abort-multipart-upload", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id, "--key", upload["Key"], "--upload-id", upload["UploadId"])
            while True:
                objects = aws("s3api", "list-objects-v2", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id, "--max-keys", "1000", "--no-paginate").get("Contents", [])
                if not objects:
                    break
                result = aws("s3api", "delete-objects", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id, "--delete", json.dumps({"Objects": [{"Key": item["Key"]} for item in objects], "Quiet": True}))
                if result.get("Errors"):
                    raise RuntimeError("Some S3 objects could not be deleted; rerun cleanup after inspection.")
            aws("s3api", "delete-bucket", "--bucket", bucket, "--expected-bucket-owner", cfg.account_id)
        except CommandError as error:
            if error.code not in ("NoSuchBucket", "404"):
                raise
        forget("bucket")
    state["status"] = "deleted"
    save()
    print("Owned storage resources removed. The EC2 instance and security groups were preserved.")


def main():
    global cfg, state
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["plan", "up", "down"])
    parser.add_argument("--execute", action="store_true", help="Allow cloud mutations for up/down")
    parser.add_argument("--region", default="ap-northeast-2")
    parser.add_argument("--account-id", default="342170456378")
    parser.add_argument("--instance-id", default="i-03fb00cdb34ea1b74")
    cfg = parser.parse_args()
    if STATE.exists():
        state = json.loads(STATE.read_text())
        for key, expected in (("account", cfg.account_id), ("region", cfg.region), ("instance", cfg.instance_id)):
            if state[key] != expected:
                raise RuntimeError(f"State {key} does not match requested target; refusing to proceed.")
    else:
        run = dt.datetime.now(dt.timezone.utc).strftime("%Y%m%d") + "-" + uuid.uuid4().hex[:8]
        state = {"account": cfg.account_id, "region": cfg.region, "instance": cfg.instance_id,
                 "runId": run, "bucket": f"hot-updater-lab-{cfg.account_id}-{run}",
                 "role": f"ota-lab-ec2-{run}", "profile": f"ota-lab-ec2-{run}",
                 "owned": {}, "status": "planned"}
    print(json.dumps({key: state[key] for key in ["account", "region", "instance", "bucket", "role", "profile", "status"]}, indent=2))
    print("1 private S3 bucket + 1 IAM role + 1 instance profile + 1 association; no new EC2 instance.")
    if cfg.command == "plan" or not cfg.execute:
        print("Read-only preview. Use up/down --execute for cloud changes; preview names are provisional until up.")
        return
    if cfg.command == "down" and not STATE.exists():
        raise RuntimeError("No ownership journal exists; nothing may be deleted.")
    if cfg.command == "up" and state["status"] == "deleted":
        raise RuntimeError("This journal is retired. Archive it explicitly before starting a new lab.")
    actual_account = aws("sts", "get-caller-identity")["Account"]
    if actual_account != cfg.account_id:
        raise RuntimeError("AWS identity account does not match the recorded/expected account.")
    save()
    up() if cfg.command == "up" else down()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, IndexError) as error:
        print(f"ERROR: {error}\nOwnership journal: {STATE}", file=sys.stderr)
        sys.exit(1)
