# Commercial licensing for Púca

> **This document is an offer to negotiate, not a license grant.** Nothing
> here changes the terms of the AGPL, and no commercial rights exist until a
> written agreement is signed. Like [`CLA.md`](CLA.md), this page follows the
> standard dual-licensing pattern but has not been reviewed by a lawyer —
> have one look over any actual agreement before it is signed.

## The short version

Púca is free software under the
[GNU AGPL-3.0-or-later](LICENSE). That license lets **anyone** — individuals
and companies alike — use, study, modify and self-host Púca at no cost,
**provided they meet its conditions**, the important one being: if you run a
modified Púca and let others interact with it over a network, you must offer
those users the complete corresponding source of your modified version.

For many companies those conditions don't fit: embedding Púca in a
proprietary product, running a modified deployment without publishing the
modifications, or building a hosted service on top of it without releasing
the surrounding stack. **For those uses we sell commercial licenses** — the
long-standing "selling exceptions" model. A commercial license grants the
rights you need without the AGPL's copyleft obligations, under terms agreed
per deal.

## Who needs a commercial license

You likely need one if you want to:

- distribute Púca (or a derivative) as part of a **closed-source product**;
- offer Púca — modified or wrapped — **as a service** without providing your
  users the complete corresponding source of what you run;
- integrate Púca's code into a codebase whose license is
  **incompatible with the AGPL**;
- receive **contractual support, warranties or indemnities**, which the AGPL
  explicitly does not provide.

You do **not** need one to:

- self-host unmodified Púca for yourself, your family, your community, or
  your company's internal use;
- modify Púca and comply with the AGPL (publish your modifications to your
  network users);
- evaluate Púca internally.

If you are unsure which side you fall on, ask — the answer is often "you're
fine under the AGPL".

## Why this is possible

All Púca copyright is held by the maintainer (**Fossferous**): original work
plus contributions received under [`CLA.md`](CLA.md), which grants the
maintainer the right to license contributions under additional terms. That is
what makes offering a second license lawful; it is also why the CLA exists.

## How to get one

Open a GitHub issue on this repository titled **"Commercial license
inquiry"** (say roughly what you want to do — product, service, scale), or
contact the maintainer through their GitHub profile. Terms, pricing and
duration are agreed per deal.

## What stays true regardless

- The AGPL version of Púca remains free, forever — a commercial program
  doesn't take anything away from self-hosters.
- End-to-end encryption, the wire protocol and the data formats are identical
  in every licensed form; there is no "commercial-only" protocol.
