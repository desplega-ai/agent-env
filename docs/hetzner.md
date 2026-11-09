# Hetzner cloud machines

Install a current `hcloud` CLI. Select an authenticated context with access to the intended project.
Keep tokens in the private hcloud configuration or environment. Do not place tokens in project files.

```sh
hcloud version
hcloud context use YOUR_CONTEXT
hcloud server-type list
hcloud location list
```

`agent-env` defaults to type `cx23` and location `fsn1`.
These defaults do not guarantee capacity. Specify each choice when you need a different machine.
Names and numeric IDs work for the type and location.

```sh
agent-env up --name swarm --cloud hetzner --cloud-type cpx22 --location hel1 --idle-minutes 5 --ttl-hours 1
```

This command selects `cpx22` at `hel1`. It does not select an alternative if that choice fails.
Check live prices before you authorize an allocation.
The example is an explicit choice, not a promise of capacity or price.

## Availability and prices

Before a new allocation, `agent-env` reads the current server types and locations through hcloud.
It checks `server_types.locations[].available` at the selected location.
It rejects unknown types, unknown locations, unsupported combinations, and unavailable capacity before it creates keys, IPs, or an ownership record.
An interrupted allocation with an existing ownership record receives the same check if its server does not exist.
An existing server can resume even when Hetzner no longer offers its type for new allocations.

Availability is an indicator, not a guarantee. Hetzner can reject an allocation after a successful check.
`agent-env` preserves the safe provider error category and gives an action you can take.
If Hetzner rejects server capacity, `agent-env` requests fresh availability and alternatives.
It never silently changes the type, architecture, location, or price.

For a valid location, a rejected selection lists at most five available alternatives at that location.
Each alternative includes its architecture and live server prices per hour and month.
When the selected type is known, alternatives with the same architecture appear first. Price orders the alternatives within each architecture group.
The response states the currency, net tax basis, project VAT rate, and separate IPv4 prices.
Server prices exclude IPv4. Prices can change before allocation.
If the pricing request fails, the response states that live prices are unavailable.
An unknown location instead lists known locations. Select a location explicitly before comparing machines.

```sh
hcloud server-type list --output json
hcloud location list --output json
hcloud api /pricing
```

The `/pricing` response supplies the project currency and VAT rate.
Do not infer currency from server-type price values.
Additional services and traffic can incur separate charges.

Hetzner removed datacenter availability fields after 1 October 2026.
See the [official changelog](https://docs.hetzner.cloud/changelog) and [API reference](https://docs.hetzner.cloud/reference/cloud).

## Private diagnostics and recovery

Provider diagnostics retain known error codes and fixed guidance.
They exclude raw provider output, arguments, token/config output, keys, and user data.
Unknown provider errors receive generic guidance. Inspect your authenticated context privately when further diagnosis is necessary.

The existing credential binding and ownership checks still apply.
Use the original hcloud context, endpoint, and credential for an existing machine.
Keep local ownership records and keys until cleanup succeeds.

```sh
agent-env list
agent-env up swarm
agent-env down swarm
agent-env rm swarm --purge
```

`down` retains the machine and data. Hetzner continues to charge for retained resources.
`rm --purge` deletes only resources that match the ownership record.
Idle timeout stops the machine. TTL permits automatic removal while the local daemon runs.
Neither setting replaces explicit cleanup or an independent resource check.

## Verification

The preflight suite uses the installed CLI and the real Hetzner API.
By default, it tests missing credentials and an invalid token in an isolated configuration.
It does not use your authenticated context unless you set `AGENT_ENV_TEST_CLOUD=1`.

```sh
npm run test:cloud-preflight
```

Authenticated selection tests require explicit billing authorization.
They check unknown names, numeric IDs, unavailable types, unsupported combinations, prices, and private diagnostics.
They expect rejection before allocation. However, availability can change between API reads, and a regression can permit allocation.
These tests can therefore create billed resources. Each fixture uses a 30-minute TTL, a five-minute idle timeout, and explicit cleanup.
The suite skips unavailable or unsupported cases when the API supplies no matching selection.
It checks that no resources remain after cleanup. This check does not prove that no allocation occurred.

```sh
AGENT_ENV_TEST_CLOUD=1 npm run test:cloud-preflight
```

The cloud suite requires separate billing authorization. It creates one machine with a 30-minute TTL and five-minute idle timeout.
It tests synchronization, credential binding, shared forks, resume, data retention, and expiry.
It checks server, primary IP, and SSH key absence independently after cleanup.
Choose the machine explicitly. The test does not substitute a different machine after a failure.

```sh
AGENT_ENV_TEST_CLOUD=1 AGENT_ENV_TEST_CLOUD_TYPE=cpx22 AGENT_ENV_TEST_CLOUD_LOCATION=hel1 npm run test:cloud
```
