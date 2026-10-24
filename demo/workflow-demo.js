(() => {
  const run = document.querySelector('#run-demo');
  const reset = document.querySelector('#reset-demo');
  const progress = document.querySelector('#demo-progress');
  const result = document.querySelector('#demo-result');
  const steps = [
    { label: 'Fill email', target: 'checkout-email', action: 'type', payload: { text: 'demo@example.test' } },
    { label: 'Select delivery', target: 'checkout-delivery', action: 'select', payload: { value: 'Send me a link' } },
    { label: 'Reveal the dynamic discount field', target: 'checkout-add-discount', action: 'click' },
    { label: 'Fill the newly discovered field', target: 'checkout-discount', action: 'type', payload: { text: 'DEMO' } },
    { label: 'Select gift wrapping inside the captured closed root', target: 'checkout-gift', action: 'click', container: '#shadow-host' },
    { label: 'Select the payment option inside the same-origin frame', target: 'payment-demo', action: 'click', container: 'iframe' },
    { label: 'Submit the sandbox checkout', target: 'checkout-submit', action: 'click' }
  ];
  reset.addEventListener('click', () => location.reload());
  window.addEventListener('load', () => {
    run.disabled = false;
    result.textContent = 'Ready. No account, model key, or payment needed.';
  }, { once: true });
  run.addEventListener('click', async () => {
    if (run.disabled) return;
    run.disabled = true;
    progress.replaceChildren();
    result.dataset.state = 'running';
    result.textContent = 'Running the sandbox workflow…';
    try {
      for (const step of steps) {
        const item = document.createElement('li');
        item.textContent = step.label;
        progress.append(item);
        const container = document.querySelector(step.container || `[data-agent-target="${step.target}"]`);
        if (!container) throw new Error(`Missing control: ${step.target}`);
        container.scrollIntoView({ behavior: 'instant', block: 'center' });
        await new Promise(requestAnimationFrame);
        await new Promise(requestAnimationFrame);
        await window.Navi.ready();
        const receipt = await window.Navi.execute(step.target, step.action, step.payload || {});
        if (receipt.dispatched !== true) throw new Error(`No dispatch confirmed for ${step.target}`);
        item.className = 'passed';
        item.textContent = `${step.label} — dispatched`;
      }
      const payment = document.querySelector('iframe').contentDocument.querySelector('[data-agent-target="payment-demo"]');
      const checks = [
        document.querySelector('#email').value === 'demo@example.test',
        document.querySelector('#shipping').value === 'Send me a link',
        document.querySelector('#promo').value === 'DEMO',
        document.querySelector('#shadow-host').dataset.selected === 'true',
        payment?.getAttribute('aria-pressed') === 'true',
        document.querySelector('#status').textContent === 'Sandbox checkout complete — no payment was made.'
      ];
      if (!checks.every(Boolean)) throw new Error('The sandbox fields or confirmation did not match the expected result');
      const verified = document.createElement('li');
      verified.className = 'passed';
      verified.textContent = 'Verified the sandbox fields, selected options, and confirmation';
      progress.append(verified);
      result.dataset.state = 'passed';
      result.textContent = 'Sandbox workflow verified. This checks local UI state; no real order or payment was created.';
    } catch (error) {
      const item = document.createElement('li');
      item.className = 'failed';
      item.textContent = `${error.code || 'DEMO_FAILED'}: ${error.message}`;
      progress.append(item);
      result.dataset.state = 'failed';
      result.textContent = 'Stopped. No step was retried. Reset the demo before trying again.';
    }
    document.querySelector('[data-agent-target="lab-refresh-map"]').click();
    result.scrollIntoView({ behavior: 'instant', block: 'center' });
  });
})();
