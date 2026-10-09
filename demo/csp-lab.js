// External wiring for the strict-CSP fixture. Loaded as a classic script from the
// same origin, because inline handlers and inline scripts are what the policy bans.
document.addEventListener('DOMContentLoaded', () => {
  const submit = document.querySelector('[data-agent-target="csp-submit"]');
  const name = document.querySelector('[data-agent-target="csp-name"]');
  const email = document.querySelector('[data-agent-target="csp-email"]');
  const status = document.getElementById('csp-status');
  if (submit && name && email && status) {
    submit.addEventListener('click', () => {
      status.textContent = `submitted:${name.value}:${email.value}`;
    });
  }

  const trusted = document.querySelector('[data-agent-target="csp-trusted"]');
  const trustedStatus = document.getElementById('csp-trusted-status');
  if (trusted && trustedStatus) {
    trusted.addEventListener('click', () => {
      trustedStatus.textContent = 'trusted-fired';
    });
  }
});
