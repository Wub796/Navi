# Licensing

Navi is dual-licensed. The same source is available under two sets of terms, and you pick the one
that fits how you use it.

| You want to… | Terms | Cost |
|---|---|---|
| Use, study, modify or self-host Navi and publish your changes | [AGPL-3.0-or-later](LICENSE) | Free |
| Embed Navi in a proprietary product, or run a modified version as a closed network service | Commercial licence (Pro) | Included with the Pro plan |
| Run Navi self-hosted in Docker or air-gapped, without AGPL obligations | Commercial self-hosted licence (Enterprise) | Included with the Enterprise plan |
| Have someone else run it for you | The hosted service, under its subscription terms | Starter, Pro or Enterprise |

## Where the boundary is

- **Open-source core — AGPL-3.0-or-later.** Everything in this repository: the in-page SDK
  (`src/`), the MCP transport (`src/mcp/`), the CLI (`bin/`), the reference host (`server/`), and
  the edge worker (`src/worker.ts`). Section 13 applies: if you run a modified version as a network
  service you must offer its source (the host does this for you through `GET /v1/source` and
  `NAVI_SOURCE_URL`).
- **Commercial licence.** The same code, granted to a paying Pro or Enterprise customer under terms
  that waive the AGPL's copyleft and source-offer obligations for that customer's deployments,
  while the subscription is active. It does not grant trademark rights or transfer ownership. The
  binding text is section 2 of the [commercial terms](COMMERCIAL-TERMS.md).
- **Hosted service.** The running edge at the vendor's domain — its infrastructure, secrets,
  tenant data, uptime and support — is a service, not a code licence. It is governed by the
  [commercial terms](COMMERCIAL-TERMS.md) accepted at checkout, not by the AGPL.

## Who can grant the commercial licence

Dual licensing only works when one party holds the right to license every line. All code in this
repository is copyright © Benjamin Wu. External contributions are accepted only under the
contributor terms in [CONTRIBUTING.md](CONTRIBUTING.md), which grant the right to distribute the
contribution under both licences.

## Contact

Commercial licensing, volume terms or a licence without a hosted plan: wub67608@gmail.com.
