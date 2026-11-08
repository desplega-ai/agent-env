#!/usr/bin/env bash
# Source this file with the suite name and its private directory.
set -euo pipefail
fixture_group=$1
fixture_root=$2
if [[ ! -f "$fixture_root/.agent-env-ci-owned" || "$(cat "$fixture_root/.agent-env-ci-owned")" != agent-env-ci ]]; then
  echo 'The fixture requires a directory that the E2E wrapper owns.' >&2
  return 1
fi

if [[ "$fixture_group" == ssh ]]; then
  [[ "$(uname -s)" == Linux ]] || { echo 'The SSH fixture requires Linux.' >&2; return 1; }
  mkdir -p "$fixture_root/ssh/workspace with spaces"
  ssh-keygen -q -t ed25519 -N '' -f "$fixture_root/ssh/client"
  ssh-keygen -q -t ed25519 -N '' -f "$fixture_root/ssh/host"
  cp "$fixture_root/ssh/client.pub" "$fixture_root/ssh/authorized_keys"
  fixture_port=$(node --input-type=module -e 'import net from "node:net"; const s=net.createServer(); s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')
  read -r fixture_keytype fixture_key _ < "$fixture_root/ssh/host.pub"
  printf '[127.0.0.1]:%s %s %s\n' "$fixture_port" "$fixture_keytype" "$fixture_key" > "$fixture_root/ssh/known_hosts"
  cat > "$fixture_root/ssh/command" <<EOF
#!/usr/bin/env bash
set -euo pipefail
export PATH='$PATH'
cd '$fixture_root/ssh/workspace with spaces'
exec /bin/bash -c "\$SSH_ORIGINAL_COMMAND"
EOF
  chmod 700 "$fixture_root/ssh/command"
  cat > "$fixture_root/ssh/sshd_config" <<EOF
ListenAddress 127.0.0.1
Port $fixture_port
HostKey $fixture_root/ssh/host
PidFile $fixture_root/ssh/sshd.pid
AuthorizedKeysFile none
AuthorizedKeysCommand /bin/cat $fixture_root/ssh/authorized_keys
AuthorizedKeysCommandUser $(id -un)
AllowUsers $(id -un)
PubkeyAuthentication yes
AuthenticationMethods publickey
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitEmptyPasswords no
PermitRootLogin no
UsePAM yes
StrictModes yes
AllowTcpForwarding local
GatewayPorts no
X11Forwarding no
PermitTunnel no
ForceCommand $fixture_root/ssh/command
LogLevel VERBOSE
EOF
  cat > "$fixture_root/ssh/config" <<EOF
Host agent-env-ci
  HostName 127.0.0.1
  Port $fixture_port
  User $(id -un)
  IdentityFile $fixture_root/ssh/client
  IdentitiesOnly yes
  UserKnownHostsFile $fixture_root/ssh/known_hosts
  GlobalKnownHostsFile /dev/null
  StrictHostKeyChecking yes
  BatchMode yes
  ConnectTimeout 3
EOF
  chmod 600 "$fixture_root/ssh/"{config,sshd_config,authorized_keys,known_hosts}
  sudo mkdir -p /run/sshd
  sudo /usr/sbin/sshd -t -f "$fixture_root/ssh/sshd_config"
  # The caller owns the private log. Only sshd needs elevated privileges.
  # shellcheck disable=SC2024
  sudo /usr/sbin/sshd -D -e -f "$fixture_root/ssh/sshd_config" > "$fixture_root/ssh/sshd.log" 2>&1 &
  export AGENT_ENV_TEST_SSH=agent-env-ci
  export AGENT_ENV_TEST_SSH_CONFIG="$fixture_root/ssh/config"
  fixture_ready=false
  for ((fixture_attempt=0; fixture_attempt<30; fixture_attempt++)); do
    if ssh -F "$AGENT_ENV_TEST_SSH_CONFIG" "$AGENT_ENV_TEST_SSH" 'docker info >/dev/null && command -v rsync >/dev/null'; then fixture_ready=true; break; fi
    sleep 1
  done
  if [[ "$fixture_ready" != true ]]; then cat "$fixture_root/ssh/sshd.log" >&2; return 1; fi
fi

if [[ "$fixture_group" == s3 ]]; then
  unset AWS_PROFILE AWS_DEFAULT_PROFILE AWS_SESSION_TOKEN AWS_SECURITY_TOKEN
  export AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
  AWS_ACCESS_KEY_ID=$(node -e 'console.log(require("node:crypto").randomBytes(12).toString("hex"))')
  AWS_SECRET_ACCESS_KEY=$(node -e 'console.log(require("node:crypto").randomBytes(24).toString("hex"))')
  export AWS_DEFAULT_REGION=us-east-1 AWS_REGION=us-east-1 AWS_EC2_METADATA_DISABLED=true AWS_PAGER=''
  export AWS_CONFIG_FILE="$fixture_root/aws-config" AWS_SHARED_CREDENTIALS_FILE="$fixture_root/aws-credentials"
  printf '{"identities":[{"name":"ci","credentials":[{"accessKey":"%s","secretKey":"%s"}],"actions":["Admin","Read","Write","List","Tagging"]}]}' "$AWS_ACCESS_KEY_ID" "$AWS_SECRET_ACCESS_KEY" > "$fixture_root/s3.json"
  fixture_container="agent-env-ci-s3-$(node -e 'console.log(require("node:crypto").randomBytes(8).toString("hex"))')"
  echo "$fixture_container" > "$fixture_root/s3-container"
  docker run -d --name "$fixture_container" --label "agent-env.ci.fixture=$fixture_root" --publish 127.0.0.1::8333 \
    --mount "type=bind,src=$fixture_root/s3.json,dst=/etc/seaweedfs/s3.json,readonly" \
    chrislusf/seaweedfs:4.52@sha256:57877e32bb90073b37dc109b438ba66e84fd5ed9ced5f5c04f56444ef243ce59 \
    server -ip=127.0.0.1 -ip.bind=0.0.0.0 -s3 -s3.config=/etc/seaweedfs/s3.json -volume.max=1 -master.volumeSizeLimitMB=64 >/dev/null
  fixture_port=$(docker port "$fixture_container" 8333/tcp)
  export AGENT_ENV_TEST_S3_ENDPOINT="http://$fixture_port"
  export AGENT_ENV_TEST_S3=s3://agent-env-ci/snapshots
  fixture_ready=false
  for ((fixture_attempt=0; fixture_attempt<60; fixture_attempt++)); do
    if AWS_MAX_ATTEMPTS=1 aws --cli-connect-timeout 2 --cli-read-timeout 2 --endpoint-url "$AGENT_ENV_TEST_S3_ENDPOINT" s3api list-buckets >/dev/null 2>&1; then fixture_ready=true; break; fi
    sleep 1
  done
  if [[ "$fixture_ready" != true ]]; then docker logs "$fixture_container" >&2; return 1; fi
  aws --endpoint-url "$AGENT_ENV_TEST_S3_ENDPOINT" s3api create-bucket --bucket agent-env-ci >/dev/null
fi
