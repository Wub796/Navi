# Navi: first paid pilot prospecting pack

**Purpose:** find one team with a real, recurring browser workflow, prove Navi helps on that workflow, and convert the proof into the first paid engagement. This is a founder working plan, not evidence that any listed company wants Navi.

## The offer to test

**Buyer hypothesis:** a small product/engineering team already runs browser agents or browser-driven workflows using a Node/Playwright-compatible stack, and spends meaningful time recovering from dynamic controls, UI drift, or unverified submissions.

**Positioning:** Navi is an MIT-licensed interaction layer that can augment an existing browser stack with named DOM action maps, live actionability checks, guarded execution, compact observations, and optional settlement. It is not a hosted browser, a full agent, a visual browser driver, or a replacement for Playwright/Stagehand/Browser Use. The customer keeps its current driver for screenshots, unsupported keyboard shortcuts, and frame/shadow-root scrolling.

**First offer to validate (not yet a published service or proven price):** a $750 fixed-fee, two-week workflow evaluation. One staging/test workflow, one existing-stack baseline, and up to 20 matched runs per path. Agree on an independent saved-state check before testing. Deliver an integration, setup, and failure-recovery session plus a short results readout covering verified completion, first-attempt success, human interventions, recovery time, end-to-end time, setup effort, and model/provider cost when available. Proposed payment: 50% at kickoff and 50% with the readout. No production writes, real purchases, PHI, or other sensitive data; no reliability or savings guarantee. Confirm exact scope and terms with the buyer before invoicing.

This is deliberately a services-led wedge: Navi's hosted $29/$49/$199 monthly plans buy metered bundle serving and sitemap writes, not browser hours or implementation help. Do not imply that those plans include this pilot. The source is MIT, so licensing is not a reason to subscribe. Only sell hosted access when the buyer actually needs that service.

## Ranked prospect hypotheses

These are leads to qualify, not endorsements or known prospects. Public job posts can expire; check their live status before using them. Use public company contact routes, never inferred personal addresses.

| Rank | Team | Public signal and source | Pilot hypothesis | Public approach |
|---|---|---|---|---|
| 1 | **Payna** | Its public software-engineering role asks for browser automation and agents against state/federal licensing systems and lists Playwright as a bonus. [YC role](https://www.ycombinator.com/companies/payna/jobs/ikNEbqz-software-engineer-full-time); [developer docs](https://payna.com/docs) | Safely test one draft/status workflow in a sandbox or approved non-production portal: discover controls, perform a reversible step, independently verify the saved status. This is the strongest stack/workflow match in the list. Never use real applicant data or submit a live filing in an initial pilot. | The company terms list `hello@payna.com`; verify the address and job are still current. [Terms/contact](https://payna.com/terms-of-service) |
| 2 | **Zalos** | Its AI-engineering role describes computer-use agents for enterprise UIs such as SAP and ServiceNow, with evaluation/replay needs and Playwright as a nice-to-have. [YC role](https://www.ycombinator.com/companies/zalos/jobs/q9x1zkX-senior-ai-engineer) | Compare one reversible staging UI step, such as preparing a record, with the team's current runner. Confirm persistence independently and keep consequential actions behind their approval gate. | Official [contact page](https://www.zalos.ai/contact-us) or [careers page](https://www.zalos.ai/careers) |
| 3 | **Karumi** | Its public materials describe agents that operate live product demos, navigate apps, and fill sample forms; a YC role describes browser-agent evaluation work. [Karumi](https://karumi.ai/); [agentic demos](https://karumi.ai/blog/agentic-demos); [YC role](https://www.ycombinator.com/companies/karumi/jobs/Ht5Bs00-ai-ml-harness-engineer) | Test one seeded demo flow where a deterministic action map might make a brittle form interaction easier to inspect and recover. Judge the final demo state, not whether a click returned success. | Start via the official [Karumi site](https://karumi.ai/) and its demo path. |
| 4 | **Asteroid** | Its product post reports production agents across healthcare and government systems and describes integration/MCP delivery. [Asteroid Integrate](https://asteroid.ai/blog/asteroid-integrate/); [YC profile](https://www.ycombinator.com/companies/asteroid) | A single synthetic-data portal interaction could test fit, but Asteroid builds an overlapping agent platform; treat as a technical-partner/design-partner hypothesis, not a likely straightforward buyer. Do not use PHI without approved agreements and security review. | The post offers a scoping/demo call. |
| 5 | **Rye** | Engineering posts describe a checkout agent fallback when deterministic merchant paths are unavailable. [Universal checkout paper](https://rye.com/blog/whitepaper-universal-checkout-api-agentic-commerce); [durable execution](https://rye.com/blog/durable-execution-agentic-checkout) | Possible test on a test merchant through review/shipping only, stopping before order or payment. Rye already offers a higher-level checkout API, so fit is less clear. | Official [API support](https://rye.com/docs/api-v2/support) |
| 6 | **Momentic** | Its official materials describe AI-assisted browser testing and checkout workflows with explicit confirmation assertions. [YC profile](https://www.ycombinator.com/companies/momentic); [agentic testing](https://momentic.ai/agentic-testing) | A known critical flow could test Navi as a lower-level augmentation, but Momentic directly overlaps the QA-agent use case. Lower-priority integration conversation, not the first buyer to pursue. | Official [sales/demo](https://momentic.ai/sales) |

**Qualification gate before offering a pilot:** ask whether the current stack is Node/Playwright-compatible; what recent failure took real recovery time; whether a test/sandbox workflow and independent result oracle exist; what data/action permissions are allowed; and who owns the budget. If no measurable recurring pain or safe verification path exists, do not force a pilot.

## Outreach drafts

Personalize only the bracketed observation after checking the public page is current. Send individually; do not bulk-blast. These are drafts, not messages sent.

### Payna — first choice

**Subject:** A measured test for one licensing-portal workflow

Hi Payna team — I saw your public engineering role mentions browser agents for state and federal licensing systems, with Playwright as a bonus. I’m building Navi, an MIT-licensed Node/Playwright interaction layer that exposes named DOM controls and checks whether they’re actionable before an agent uses them.

Would you be open to evaluating one safe, non-production portal workflow against your current approach? I’m proposing a two-week, $750 fixed-fee pilot: one workflow, up to 20 matched runs per path, and an independent saved-state check agreed before testing. I’ll report failures and human recovery effort as well as successes; this is a test, not a claim that Navi already improves your results. No real applicant data or live filings.

If the stack or workflow is a fit, could we spend 20 minutes choosing a safe test and a success threshold? If not, I’d still value knowing which browser failures are most costly for your team.

— Benjamin

### Zalos

**Subject:** Testing a guarded browser step in an enterprise UI

Hi Zalos team — your public AI-engineering role describes computer-use agents for enterprise interfaces and calls out evaluation/replay work. Navi is a small MIT-licensed interaction layer for existing Node/Playwright workflows: named DOM targets, live actionability checks, and guarded execution, while leaving the rest of your browser stack in place.

I’d like to test one reversible step in a staging UI against your current runner, with an independent check that the record actually persisted. My proposed two-week pilot is $750 fixed fee, capped at one workflow and 20 matched runs per path, with a readout that includes failures, interventions, and setup effort. No production writes or actions outside your approval policy.

Would a short scoping call make sense if your current runner is compatible? I’m happy to start from one workflow you already consider brittle.

— Benjamin

### Karumi

**Subject:** A small reliability experiment for a seeded product demo

Hi Karumi team — I saw your public materials on agents operating live product demos and sample app workflows. Navi is an MIT-licensed Node/Playwright interaction layer that makes controls explicit and checks actionability before dispatch; it is intended to augment, not replace, your agent or browser infrastructure.

Would one seeded demo flow be worth comparing with your current interaction path? I’m proposing a two-week, $750 fixed-fee evaluation, one flow, up to 20 matched runs per path, and a final-state check agreed in advance. The report includes failures and manual recovery, not just a success rate. I would avoid production/customer sessions.

If that is relevant, could we use 20 minutes to choose a flow where the agent currently needs retries or human rescue?

— Benjamin

### General fallback for Asteroid, Rye, or a qualified team

**Subject:** Compare one browser-agent workflow against your current stack

Hi [team] — I’m looking for one team with a recurring browser workflow that is hard to keep reliable as the UI changes. Navi is a small MIT-licensed interaction layer for existing Node/Playwright setups, focused on named DOM controls, current actionability checks, and guarded execution. It is not a hosted-browser or full-agent replacement.

I’d propose a paid, two-week test of one safe workflow: agree on the baseline and independent success check first, run up to 20 matched trials per path, then review completed outcomes, failures, human interventions, recovery effort, and setup cost. Proposed fee is $750 fixed, pending scope. We would use a test environment and stop before any real purchase, filing, or sensitive-data operation.

Is there one workflow where this comparison would be useful, or is your current browser layer already working well?

— Benjamin

## Ten-business-day execution checklist

1. **Day 1:** verify three priority public signals are still live; validate the public contact routes. Send only the Payna note first.
2. **Days 2–3:** if there is a response, qualify stack, reproducible pain, safe environment, independent oracle, permissions, and buyer. Do not build a bespoke feature before those are clear. If no response, send the Zalos and Karumi drafts individually through their public routes.
3. **Days 4–6:** contact up to 10 more qualified teams from public engineering/job/product signals. Seek workflow conversations rather than mailing-list signups. Record signal URL, date checked, route used, response, and next step.
4. **Days 7–8:** scope only a workflow with a repeatable test state and outcome oracle. Get written approval for access/data/actions and agree the comparison protocol and fee before work starts.
5. **Days 9–10:** invoice the agreed kickoff amount before implementation. Run the baseline and Navi path on the same environment/task/model; preserve failures. Deliver the factual readout, then ask for paid continuation only if the buyer confirms value.

## Message and evidence guardrails

- The existing controlled hard-checkout study has mixed results by model, is on one local fixture, and is not a customer-site result. Beam's observed deficit is inconclusive under the paired test (p=0.125); gpt-oss completed only 21/40 Navi trials. Report both rather than hiding them. Cite [the study](../reports/LLM-TCR-BENCHMARK-MULTI.md) only with its limitations.
- The separate small scripted checkout and token measurements are also fixture results; they do not establish production savings, general reliability, or cost reduction.
- Never claim Navi beats Playwright MCP, Stagehand, Browser Use, or the prospect's stack: there is no head-to-head evidence against those products or that customer's system.
- Report cost per independently verified successful task only when provider-billed usage is available; include failed attempts and human recovery.
- Do not send unsolicited bulk mail, fabricate familiarity, imply a prospect uses Navi, or claim that a job post proves buying intent.
- Existing hosted checkout and plan prices are separate from this proposed services pilot. The public site has not yet been redeployed with the recent landing-page changes.

## What counts as progress toward revenue

A reply, meeting, or free test is not revenue. Count revenue only after an agreed paid scope is invoiced and payment clears. Track: qualified conversations; safe workflows reproduced; paid pilots offered; paid pilots started; pilot outcomes; renewals/continuations; cash collected. The next best outcome is one signed, paid pilot with a customer-owned success check—not more feature breadth without a buyer's problem.