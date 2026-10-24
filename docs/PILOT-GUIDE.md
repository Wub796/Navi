# Navi pilot guide

## First customer hypothesis

Start with engineers building browser workflow agents for internal operations. Look for a repeated form-based task with dynamic controls, a known completion check, and failures they can reproduce. Treat this as a hypothesis to validate in interviews; we do not yet have evidence of customer demand.

Offer a two-week assisted evaluation of one workflow. The first deliverable is a reproducible before/after result on their task. Agree on a paid continuation only after they can see the result and confirm the hosted plan and service terms cover their intended use.

## A working local demonstration

From the repository, run `npm ci`, `npx playwright install chromium`, `npm run build`, and `npm run dev`. Open the displayed local URL and choose **Run sample workflow** to see the protocol work without configuring an agent. The progress list checks the resulting sandbox state and stops if any action is refused. To run the same checkout through the CLI, use another terminal:

```sh
npx navi run --url http://127.0.0.1:4173/ \
  --action-file flows/example-checkout.json --allow-consequential --json
```

This flow submits only the sandbox checkout and checks its confirmation text. No payment occurs. That final assertion proves the demo's UI result; it does not prove a real order was saved. `npm run benchmark:tcr` runs the separate checkout fixture with an independent server-side order check.

For MCP, start with the README configuration. Discover off-screen controls with `navi_get_actions({all:true})`, call `navi_scroll_to({target_id:...})` for a top-document control, and recheck its state before acting. Keep the existing browser driver for arbitrary page text, unsupported keyboard shortcuts, screenshots, and frame/shadow-container scrolling.

## Agree on success before the pilot

Record the customer's current tool, task frequency, failure rate, manual recovery time, and the person who owns the budget. Choose the outcome check before implementing the flow: for example, a saved record with the expected fields and unique identifier, verified through the customer's test API or database. An action returning `executed:true` or `settled:true` is insufficient.

Use the same application state, task instructions, model/version, limits, and completion check for the existing stack and Navi-assisted stack. Alternate run order. Keep every failed trial and retry. Separate setup/debug tasks from held-out evaluation tasks. Begin with 20 paired trials per workflow and report the sample size; this is an initial decision aid, not a universal reliability claim.

Record these fields for every trial:

| Field | What to record |
|---|---|
| Task and environment | Workflow, app version, initial state, tool and model versions |
| Verified outcome | Passed/failed, outcome evidence, failure stage |
| Retries and intervention | Attempts, human assistance, recovery minutes |
| End-to-end time | Include observations, actions, waits, retries, and verification |
| Model usage | Provider input/output token counts and billed cost, when available |
| Setup effort | Engineer time to integrate and maintain each path |

Calculate cost per **verified successful task**, including the spend on failed attempts. Report both first-attempt success and eventual success. Describe the conditions where Navi is worse as well as better. Agree in advance which improvement would justify adopting and paying for it.

## Real-model benchmark

The default `npm run benchmark:llm` can run a mock fixture; its output is not customer or live-model evidence. To call a real model, configure `LLM_ENDPOINT`, `LLM_MODEL`, and any required `LLM_API_KEY` in your local environment, then run `npm run benchmark:llm:live`. The harness accepts up to ten iterations per run and writes separate LIVE artifacts. Archive each run when collecting a larger sample.

Choose the model and spending limit before running paid trials. Provider usage and pricing must be available to make billed-cost claims. A local model is also supported through the harness's documented presets. The local checkout remains a fixture even with a real model; external pilot workflows need their own independent outcome checks.

## Two-week customer validation plan

These are working targets, not YC admission criteria.

1. Days 1–3: contact 20 relevant engineers from the researched prospect list. Ask about their most recent browser-agent failure and request a reproducible example. Aim for five substantive conversations.
2. Days 4–7: help three teams run one workflow each. Record time to first verified result and every setup obstacle. Publish a short demo showing the final result and the limitations.
3. Days 8–12: run the paired evaluation on the most promising workflow. Ask teams to use it again without prompting and record actual repeat usage.
4. Days 13–14: ask the team with the clearest benefit for a paid continuation. Write a factual application update: conversations, active teams, repeated tasks, measured outcome improvement, revenue actually collected, and what changed after feedback.

Promote the reproducible demo in relevant developer communities and GitHub Discussions after direct conversations reveal a recurring problem. Use measured outcomes in posts; avoid broad savings claims or customer logos without permission.

## Owner decisions and inputs

- Recruit the teams, conduct the interviews, and agree on the task and success criteria.
- Provide authorized test accounts, representative workflows, and an independent way to verify saved results.
- Choose a live model and budget, or provide a suitable local model.
- Confirm the hosted plan and current service terms cover the proposed use. The code is MIT, so embedding it in a product and using it for customer work need no permission; the terms govern the hosted service (quota, tenant data, uptime), not the code, and a prospect self-hosting it needs no plan at all.
- Confirm pricing with willingness-to-pay evidence and decide which buyer segment to pursue.
- Review and release the local changes to npm and the hosted site. Only then will published packages and the public page include these refinements.
