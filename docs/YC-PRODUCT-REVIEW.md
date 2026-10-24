# Navi: three product review passes

Reviewed October 24, 2026, starting from commit `c279b28`. This review excludes founder issues, market-size arguments, and user-count arguments. It evaluates the product, its evidence, and the experience of trying it.

## YC selection estimate

Use **approximately 1% as a planning assumption**, with substantial uncertainty. This is an overall base-rate anchor, not a calibrated probability for Navi. Product inspection cannot isolate an admission probability while holding the rest of an application constant.

YC currently describes its typical acceptance rate as 1% on its [investor resources page](https://www.ycombinator.com/investors). Its published Winter 2024 figures were 260 companies from more than 27,000 applications: `260 / 27,000 × 100 = 0.963%`, an upper bound for that historical batch because the denominator was larger. [Official batch announcement](https://www.ycombinator.com/blog/meet-the-yc-winter-2024-batch).

I cannot justify claiming that these code changes raise Navi's odds to 5%, 10%, or any other specific figure. The product is easier to evaluate and more complete after the three passes. Whether that makes an application compelling depends on proving a distinctive advantage on an important workflow. No admission uplift was measured.

## What the latest agent already improved

The starting revision already had accurate benchmark caveats, a free local quickstart, explicit scrolling, scoped text reading, clearer commercial terms, and stronger statements about hosted limits. I retained those changes. The work below adds functionality and evidence rather than taking credit for that earlier work.

## Pass 1: observation size and the claimed advantage

**Finding:** rich action maps spend context on coordinates and repeated state-field names even when a planner only needs to choose an available control. The existing checkout benchmark also shows Navi using more observation tokens than its Playwright baseline. A general token-savings claim would still be unsupported.

**Change:** added opt-in `navi_get_actions({compact:true})`. Entries contain target identity, role, name, action, availability, and reasons an unavailable control is blocked. Coordinates remain available in the full response. Execution continues to obtain and check full live state. Differential updates retain removal tombstones and reset/cursor metadata.

**Verification:** the official MCP client compares both formats on the same sandbox page, alternates their order over five pairs, checks target identities and availability, executes a form submission from the compact observation, and checks the resulting UI text. Separate checks cover every blocked-state reason and removed targets.

**Measured result:** the final sandbox fixture returned 1,369 full-map tokens versus 558 compact-map tokens with `cl100k_base`, consistently across five pairs: `(1,369 - 558) / 1,369 × 100 = 59.2%` fewer observation tokens. This counts serialized observation payloads only. No model was called and no provider bill, end-to-end model cost, task-planning improvement, or competitor advantage was measured. Earlier passes used a smaller version of the sandbox and produced different counts.

**Reassessment:** this fixes avoidable verbosity and creates a testable product benefit. Compact context is not a defensible differentiator by itself: [Playwright MCP](https://github.com/microsoft/playwright-mcp) documents targeted snapshot searches and scoped snapshots too. YC reassessment: retain the approximately 1% base-rate planning assumption; a smaller payload alone provides no calibrated admission uplift.

## Pass 2: keyboard-dependent workflows

**Finding:** click/type/select did not cover Enter submission, Escape dismissal, or keyboard navigation. These are ordinary workflow requirements. [Playwright MCP](https://github.com/microsoft/playwright-mcp) already exposes native key input, so omitting it makes Navi require another driver for basic tasks.

**Change:** added `navi_press_key` for a bounded set of common keys and combinations. An optional expected `target_id` checks that a unique top-document control is focused and actionable before dispatch. The tool does not click or change focus automatically and respects `--no-fallback`. Failed native dispatches report that a key may already have applied and are never retried. Zero-config typing and selection now focus their controls consistently with SDK-backed input.

**Verification:** real browser tests cover Enter submitting exactly once, trusted keyboard events, unfocused-target refusal, unsupported keys, Escape dismissing a modal, strict-session refusal, SDK and zero-config paths, and the MCP envelope followed by a separate outcome read.

**Reassessment:** common keyboard workflows now fit within Navi. Unsupported shortcuts, file interactions, multi-tab workflows, and other browser controls still require the existing driver. This is a completeness improvement, not proof of greater reliability than a competitor. YC reassessment: retain approximately 1%; closing a basic capability gap does not establish a distinctive advantage.

## Pass 3: time to a visible result

**Finding:** the sandbox showed a form and raw JSON but required the visitor to configure an agent or understand the protocol before seeing a complete workflow. A visual architecture illustration on the landing page also cannot substitute for execution evidence.

**Change:** added **Run sample workflow**, a progress list, explicit success/failure feedback, and **Reset demo**. The sequence fills the form, discovers a dynamically added field, interacts with the captured closed root and same-origin frame, and submits the sandbox form. It then separately checks the fields, selected options, and confirmation. The UI says that it is scripted and that no AI model or real payment is involved.

**Verification:** browser tests complete and reset the flow at 1,360 px and 390 px widths. A disabled-input case proves that a refusal stops the flow without a success message or automatic retry. I also ran the demo in the app's browser and inspected its visible completion result.

**Reassessment:** a reviewer can now see the protocol work with one click after starting the sandbox. The public release still needs to expose the updated experience; a source checkout remains additional setup. This demonstration verifies local UI state, not a real backend order. YC reassessment: retain approximately 1%; the stronger demonstration helps explain the product, but production differentiation remains unproven.

## Remaining product reasons the application may not stand out

| Product issue | Why it matters | Next concrete step |
|---|---|---|
| The reason to switch is not established | Compact observations and named controls are useful building blocks, but broader tools offer overlapping capabilities. | Choose one difficult, repeatable workflow and compare verified outcomes against a tuned existing stack. |
| Closed-root access is conditional and not exclusive | Navi must capture roots when they are created; already-created closed roots are not generally accessible. Browserbase documents closed-root and cross-origin-frame support in [Stagehand v4](https://www.browserbase.com/blog/stagehand-v4). That is a vendor capability claim, not an independent benchmark here. | Describe the exact supported setup and prove an advantage beyond closed-root access. |
| The browser surface is still narrower | File uploads/downloads, visual-only controls, and multi-tab workflows can block complete tasks even when individual clicks work. | Pick the missing capability required by the chosen workflow, rather than adding every competing feature. |
| Production outcome verification is application-specific | DOM quiet or confirmation text can precede a failed server write. | Integrate an independent saved-record check and test delayed commits, failures, and duplicate-submission prevention. |
| Evidence is still concentrated in controlled fixtures | Passing regression tests and a scripted demo do not establish autonomous planning quality on unfamiliar applications. | Run the same live model and task budget on held-out workflows. Keep all failures and record total usage and recovery effort. |
| The product story remains technical | A small SDK, protocol, hosted map store, and workflow compiler can be hard to connect to a single finished outcome. | Lead the application and demo with a concrete task, its failure mode, and the verified result. Explain the architecture afterward. |

## What still needs the owner's input

1. Select the specific workflow and application where Navi should have an advantage.
2. Supply authorized representative test access and a way to verify the backend result independently.
3. Select a real model and an acceptable paid-run budget, or provide a suitable local model. The mock benchmark is not a substitute.
4. Review and release the updated package and hosted experience. Local changes do not update npm or the public site automatically.
5. Record a short demonstration of the actual task and use measured results in the YC application. The sandbox can explain the mechanism, but it cannot establish the production advantage.

## Engineering verification and scope

No runtime dependency was added, and the browser SDK source and its byte budget were preserved. Compact formatting lives in a small pure module; native key dispatch lives in the adapter that already owns origin checks, busy state, and native-input policy. The MCP transport exposes these operations through its existing tool pattern.

The structural review found that `src/mcp/server.js` was already over 1,000 lines (1,391 before, 1,427 after). This work did not cross that threshold. I kept transport dispatch consistent and avoided a broad server reorganization while adding the bounded features above. Splitting the session/runtime from transport plumbing remains sensible maintenance work, but is not an admission differentiator.

Final checks passed on Node 22.23.3: gate self-test, build, strict bundle and loader budgets, typecheck, all **285 Chromium-suite tests**, the traversal long-task gate, and the package boundary check. The browser SDK remains 14,929 bytes raw and the loader 689 bytes. [Machine-readable verification](../reports/product-refinement-verification.json).

Historical checkout and differential benchmark reports were preserved; the compact comparison above is separate evidence. Ollama is installed locally but its usual endpoint was not running when checked. I did not start an unspecified model or incur paid model charges.
