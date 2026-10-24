# Licensing

Navi is MIT-licensed. Use it, modify it, embed it in a product you sell, or run it as a service.
There is no copyleft, no source-offer obligation and no permission to ask for.

| You want to… | Terms | Cost |
|---|---|---|
| Use, study, modify or self-host Navi and publish your changes | [MIT](LICENSE) | Free |
| Embed Navi in a proprietary product, or run a modified version as a closed network service | [MIT](LICENSE) | Free |
| Have someone else run the hosted part for you, with a quota | Hosted service, under the [service terms](COMMERCIAL-TERMS.md) | Starter, Pro or Enterprise |

## Where the boundary is

- **The code — MIT.** Everything in this repository: the in-page SDK (`src/`), the MCP transport
  (`src/mcp/`), the CLI (`bin/`), the reference host (`server/`), and the edge worker
  (`src/worker.ts`). You may keep your modifications private, ship them in a closed product, and
  operate them as a service without publishing anything.
- **The hosted service.** The running edge at the vendor's domain — its infrastructure, secrets,
  tenant data, quota and uptime — is a service rather than a code licence, and is governed by the
  [service terms](COMMERCIAL-TERMS.md) accepted at checkout. Running Navi yourself is not the
  hosted service and does not require a subscription.
- **The trademark.** MIT grants copyright and patent permissions, not rights to the Navi name or
  logo. A fork is welcome; presenting it as Navi is not.

## Why permissive rather than copyleft

The earlier releases of this project were AGPL-3.0-or-later, sold with a commercial exemption. That
model asked a legal team to approve a copyleft dependency before a single workflow ran, and
returned nothing while the project had no users to protect. The code is now MIT so that the only
question a prospective user faces is whether it works.

The trade-off is real and permanent: **a permissive grant cannot be withdrawn.** Releases published
before this change (up to and including v0.6.9 on npm) remain AGPL-3.0-or-later as published; their
archives and tags keep their original terms, and the release notes for those versions stay as they
were written. From v0.7.0 onward the code is MIT. If the project later needs copyleft protection
against a competitor hosting it, that option is gone — the mitigation is the hosted service's
operational value, not the licence.

Revenue therefore comes from running the service, not from granting an exemption: the paid plans
sell hosted bundle serving, sitemap writes and telemetry against a 30-day quota. Self-hosting is
free at every tier.

## Contributions

All code in this repository is copyright © Benjamin Wu. External contributions are accepted only
under the contributor terms in [CONTRIBUTING.md](CONTRIBUTING.md), which grant the right to
distribute the contribution under the project's licence. That grant is deliberately broad enough to
cover a future licence change, so a later decision does not require hunting down every contributor.

## Historical note

`LICENSE` at a tag before v0.7.0 is the AGPL-3.0 text and governs that tag. This file describes the
current tree only.

## Contact

Hosted service, volume terms or self-hosting questions: wub67608@gmail.com.
