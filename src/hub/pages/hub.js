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

// Report charts: a tooltip for any mark with data-tip (the tables under the
// charts hold the same numbers, so nothing depends on it).
const tip = document.createElement('div');
tip.className = 'tip';
tip.hidden = true;
tip.setAttribute('aria-hidden', 'true');
document.addEventListener('pointermove', (e) => {
  const el = e.target instanceof Element ? e.target.closest('.chart [data-tip], .bar-table [data-tip]') : null;
  if (!el) {
    tip.hidden = true;
    return;
  }
  if (!tip.isConnected) document.body.append(tip);
  tip.textContent = el.getAttribute('data-tip');
  tip.hidden = false;
  const w = tip.offsetWidth;
  const h = tip.offsetHeight;
  tip.style.left = `${Math.max(8, Math.min(e.clientX + 12, window.innerWidth - w - 8))}px`;
  tip.style.top = `${e.clientY - h - 12 < 8 ? e.clientY + 16 : e.clientY - h - 12}px`;
});

// Select a freshly revealed secret so it can be copied straight away.
document.querySelector('.reveal-value')?.focus();
document.querySelector('.reveal-value')?.select();
