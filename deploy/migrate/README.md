# VPS migration tooling

Scripts for standing up a fresh host from scratch — a brand-new self-hosted
deployment ([`deploy/README.md`](../README.md) section 0 is the guided path)
or the target of a move off a home server onto a rented one. `provision.sh`
builds the box; `verify.sh` checks the things whose failure is silent, before
you trust it with data.

| File | Runs on | Purpose |
| --- | --- | --- |
| `udp-sink.mjs` | candidate VPS | Echoes UDP and reports per-window counts |
| `udp-soak.mjs` | your machine | Sends media-rate UDP, reports loss — **the buy/don't-buy test** |
| `provision.sh` | new VPS, as root | Packages, coturn, LiveKit, firewall, empty DB |
| `render-turn-conf.sh` | called by provision | Renders `/etc/turnserver.conf` from the repo template |
| `render-turn-conf.test.sh` | anywhere | Tests the above; run it before you trust a provision |
| `verify.sh` | new VPS, as root | Checks the silent-failure config invariants |

Nothing here migrates data or changes DNS. Data movement is
`deploy/ops/restore.sh`, and only at cutover.

---

## Soak first, buy second

The uplink is the reason for moving: a home line cannot carry more than a
couple of streams, and `bps-capacity` was sized to 20 Mbps because of it. But
raw bandwidth is not the thing that decides which host works. **DDoS mitigation
is.**

A TURN relay plus an SFU is sustained UDP, arriving on a high port, from
several sources at once. To an automatic scrubber that is structurally what a
UDP flood looks like. A host whose mitigation is always-on and cannot be
disabled will decide, at some point mid-call, that Puca's own voice
traffic is an attack — and there is no setting to appeal to afterwards.

This is not something the terms of service settle. Read them and you get
"excessive use may be restricted" with no number attached, which is unfalsifiable
either way. Half an hour of real traffic settles it.

So: buy one month on the cheapest candidate, soak it, and only then commit.

```bash
# on the candidate VPS
sudo ufw allow 7882/udp
node deploy/migrate/udp-sink.mjs
```

```bash
# on your machine — 4.5 Mbps is one screen share
node deploy/migrate/udp-soak.mjs <vps-ip> 7882 4.5 30
```

Read the per-window output, not the average. What fails a host is a **cliff**:
loss at roughly zero for several windows, then jumping to most of the traffic
and staying there. That is mitigation engaging. Steady low loss is ordinary
internet and is fine.

If the first run is clean, run it twice more before believing it — packets-per-
second limits and bitrate limits are separate guards, and a host can pass one
while failing the other:

```bash
node deploy/migrate/udp-soak.mjs <ip> 7882 15 30        # a busy call
node deploy/migrate/udp-soak.mjs <ip> 7882 4.5 30 200   # same rate, 6x the pps
```

The soak reports the rate it **actually** achieved alongside the one you asked
for, and refuses to report PASS if it fell short — a run that did not deliver
the traffic cannot have tested anything, and would otherwise pass on any host.
If it says INVALID, suspect your own uplink before the VPS.

## After a host passes

```bash
bash deploy/migrate/render-turn-conf.test.sh          # first, on any machine
sudo ./provision.sh --public-ip <ip> --uplink-mbps 1000 --dry-run
sudo ./provision.sh --public-ip <ip> --uplink-mbps 1000
sudo ./verify.sh
```

`provision.sh` refuses to run where `/opt/puca/puca` already exists,
so it cannot be pointed at the live box by accident. It is otherwise re-runnable
— every file it replaces is backed up first.

`verify.sh` covers the failures that are invisible from the outside: a coturn
config the `turnserver` user cannot read (coturn then starts with defaults,
which is an **open relay**), a stale `external-ip` from the NAT'd host, a
LiveKit config missing `prometheus_port` (SFU admission silently loses its
measured branch and falls back to worst-case projection), and postgres or the
metrics port left open. It also probes the relay with a deliberately bogus
credential, because the logs of an open relay look exactly like the logs of a
working one.

Two settings that must not be carried over verbatim from a home-server deployment:

- **`external-ip` in `turnserver.conf`.** Correct on a NAT'd home box, fatal on
  a VPS that holds its public IP directly — relays get advertised at an address
  that does not exist. `provision.sh` detects which applies by comparing the
  NIC address to the public one, rather than assuming.
- **`JWT_SECRET`.** `provision.sh` writes a fresh one so the box is usable
  standalone, but at cutover you must copy the *old* value across. Changing it
  logs every user out and invalidates every token in flight.
