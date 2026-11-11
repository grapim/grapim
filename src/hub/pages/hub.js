// The hub's only script (the CSP allows no inline code): copy buttons and
// confirmation for destructive forms. Every page works without it.

document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  const input = document.getElementById(btn.dataset.copy);
  if (!input) return;
  input.select();
  try {
    await navigator.clipboard.writeText(input.value);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => (btn.textContent = 'Copy'), 2000);
});

document.addEventListener('submit', (e) => {
  const form = e.target.closest('form[data-confirm]');
  if (form && !window.confirm(form.dataset.confirm)) e.preventDefault();
});

// Select a freshly revealed secret so it can be copied straight away.
document.querySelector('.reveal-value')?.focus();
document.querySelector('.reveal-value')?.select();
