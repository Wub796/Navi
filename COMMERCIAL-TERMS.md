# Navi Hosted Service Terms

Last updated: 24 October 2026

These terms govern paid Navi subscriptions (Starter, Pro and Enterprise). You accept them by
checking the terms box at checkout. "We" means Benjamin Wu, who operates the hosted service. "You"
means the person or organisation that buys the subscription.

These terms cover the **hosted service only**. The Navi source code is licensed separately under the
[MIT licence](LICENSE), which needs no subscription, grants no rights that these terms can remove,
and is not affected by whether you subscribe.

## 1. Subscription

1.1 You buy a monthly subscription to a plan listed at https://navi-edge.sysctl.workers.dev/. Each
plan includes a 30-day event allowance on the hosted service.

1.2 Fees are billed in advance through Stripe and are non-refundable, except where the law
requires a refund. We may change prices with 30 days' notice. A change applies from your next
billing period.

1.3 You can cancel at any time through Stripe. Cancellation takes effect at the end of the
current billing period.

## 2. What a subscription buys

2.1 A subscription buys **hosted capacity**: serving the Navi browser bundle to your tenants,
accepting sitemap writes, and ingesting the telemetry those produce, metered against the plan's
30-day allowance. It does not buy a licence to the code, because the code is MIT and needs none.

2.2 Self-hosting is free at every tier. You may run the reference host yourself, without a
subscription, for any purpose, including products you sell.

2.3 Exceeding the allowance is not a breach. Requests past the window are refused with `429` and a
`Retry-After` header until it resets; there is no automatic overage billing.

2.4 Commercial support, an uptime commitment or an air-gapped deployment review are available only
under a separate written agreement. They are not included in Starter or Pro.

2.5 You get no rights to the Navi name or logo. The MIT licence grants copyright and patent
permissions; it does not grant trademark rights.

## 3. When a subscription ends

3.1 Your hosted access ends at the end of the paid period: the tenant key stops being served and
ingest answers `429`. No code rights are affected, because none came from the subscription.

3.2 You may keep using, modifying and self-hosting any copy of Navi you already have under the
[MIT licence](LICENSE), before or after cancelling.

3.3 We may suspend or end your subscription if you do not pay or if you breach these terms. We
will give you 14 days' notice where we reasonably can.

## 4. Hosted service

4.1 We run the hosted service on a commercially reasonable basis. We do not offer an uptime
guarantee unless a separate written agreement says otherwise.

4.2 You are responsible for your API keys, for the pages that embed Navi, and for every action
your agents execute. Navi does not authorise payments or other transactions on your behalf.

4.3 We process the telemetry and audit data your tenant sends only to provide the service. We
delete it according to the retention settings described in the documentation.

## 5. Disclaimer and liability

5.1 The hosted service is provided "as is", without warranties of any kind, to the extent the law
allows. This does not narrow the permissions the MIT licence grants in the code.

5.2 Neither party is liable for indirect, incidental, special or consequential damages, or for
lost profits or lost data. Each party's total liability under these terms is limited to the fees
you paid in the 12 months before the claim.

## 6. General

6.1 These terms are governed by the laws of the State of Texas, USA.

6.2 We may update these terms with 30 days' notice. The updated terms apply from your next
billing period. If you do not accept them, you can cancel before they take effect.

6.3 These terms, together with [LICENSING.md](LICENSING.md), are the whole agreement about your
subscription. They do not modify the [MIT licence](LICENSE) that governs the code.

6.4 Contact: wub67608@gmail.com.
