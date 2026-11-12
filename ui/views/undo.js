// The undo dialog. Undo rewrites files in the working tree, so it is never one
// keystroke: fetch the plan (apply: false), show what happens to every file,
// ask for the run's short id, then apply and show what was actually done.

import { api } from '../api.js';
import { html, render } from '../app.js';
import { agentChip, icon, pluralize, shortId, sk, withCode } from './shared.js';

const CLEAN = new Set(['revert', 'delete', 'restore']);
const WHY = {
  revert: 'Its edits are taken out. Later work by others in this file stays.',
  delete: 'Created by this run and unchanged since, so it is deleted.',
  restore: 'Deleted by this run, so it is put back.',
  nothing: 'Its changes are already gone.',
};
const DONE = { revert: 'Reverted', delete: 'Deleted', restore: 'Restored', conflict: 'Conflict', skipped: 'Skipped', nothing: 'Nothing' };
const PLAN = { revert: 'Revert', delete: 'Delete', restore: 'Restore', conflict: 'Conflict', skipped: 'Skip', nothing: 'Nothing' };

// Resolves true when something was applied, false otherwise.
export function openUndo(run, turn, ctx) {
  return new Promise((resolve) => {
    const s = { step: 'loading', plan: null, result: null, error: null, typed: '' };
    const code = shortId(run.label);
    const name = `${run.label}${turn === null ? '' : ` · turn ${turn}`}`;
    let applied = false;

    const d = ctx.openDialog(html``, { className: 'undo', label: `Undo ${name}`, onClose: () => resolve(applied) });

    const row = (f, verbs, why) => html`
      <li class="plan-row">
        <span class="act ${f.action}">${verbs[f.action] || f.action}</span>
        <span class="p">${f.path}</span>
        <span class="why">${why}</span>
      </li>`;
    const group = (title, items, verbs, whyOf) => (items.length ? html`
      <section class="plan-group"><h3>${title} <span class="n num">${items.length}</span></h3>
        <ul>${items.map((f) => row(f, verbs, whyOf(f)))}</ul></section>` : '');

    function body() {
      if (s.step === 'loading') {
        return html`<div aria-busy="true" aria-label="Working out the plan">${[0, 1, 2].map(() => html`<div class="plan-row"><span>${sk('56px', 20)}</span><span>${sk('60%')}</span></div>`)}</div>`;
      }
      if (s.error) {
        return html`<div class="error" role="alert">${icon('alert')}<div><h3>${s.step === 'applying' || s.result ? 'The undo didn’t finish' : 'Couldn’t work out the plan'}</h3>
          <p>${withCode(humanError(s.error))}</p>${s.error.code === 'busy' || s.error.code === 'offline' ? html`<button class="btn sm" type="button" data-retry>Try again</button>` : ''}</div></div>`;
      }
      if (s.result) {
        const fs = s.result.files;
        const changed = fs.filter((f) => CLEAN.has(f.action));
        return html`
          <p class="result-sum">${changed.length ? `${pluralize(changed.length, 'file')} changed.` : 'No file was changed.'}
            ${fs.some((f) => f.action === 'conflict') ? ` ${pluralize(fs.filter((f) => f.action === 'conflict').length, 'conflict')} left untouched for you.` : ''}
            ${fs.some((f) => f.action === 'skipped') ? ` ${fs.filter((f) => f.action === 'skipped').length} skipped.` : ''}</p>
          <ul>${fs.map((f) => row(f, DONE, f.reason ? sentence(f.reason) : (CLEAN.has(f.action) ? '' : WHY[f.action] || '')))}</ul>`;
      }
      const fs = s.plan.files;
      const clean = fs.filter((f) => CLEAN.has(f.action) && !f.reason);
      const skip = fs.filter((f) => (CLEAN.has(f.action) && f.reason) || f.action === 'skipped');
      const conflicts = fs.filter((f) => f.action === 'conflict');
      const nothing = fs.filter((f) => f.action === 'nothing');
      return html`
        ${group('Will change', clean, PLAN, (f) => WHY[f.action])}
        ${group('Left for you: overlaps later work', conflicts, PLAN, (f) => `${sentence(f.reason || 'Later edits overlap this run’s lines')} The file is not touched.`)}
        ${group('Will be skipped', skip.map((f) => ({ ...f, action: 'skipped' })), PLAN, (f) => sentence((f.reason || '').replace(/, so --yes will skip it$/, '')))}
        ${group('Already gone', nothing, PLAN, () => WHY.nothing)}`;
    }

    function foot() {
      if (s.result || s.error) {
        return html`<button class="btn" type="button" data-close>${s.result ? 'Done' : 'Close'}</button>`;
      }
      if (s.step === 'loading') return html`<button class="btn" type="button" data-close>Cancel</button><button class="btn danger-solid" type="button" disabled>Undo</button>`;
      const n = s.plan.files.filter((f) => CLEAN.has(f.action) && !f.reason).length;
      if (!n) return html`<span class="muted" style="margin-right:auto">There is nothing Grapim can undo cleanly.</span><button class="btn" type="button" data-close>Close</button>`;
      const ok = s.typed.trim().toLowerCase() === code.toLowerCase();
      return html`
        <form class="confirm" data-confirm>
          <label for="undo-confirm">Type <b class="mono">${code}</b> to confirm</label>
          <input id="undo-confirm" name="confirm" autocomplete="off" autocapitalize="off" spellcheck="false" value="${s.typed}" aria-describedby="undo-lead" data-key="undo-confirm">
        </form>
        <button class="btn" type="button" data-close>Cancel</button>
        <button class="btn danger-solid" type="button" data-apply ${ok && s.step !== 'applying' ? '' : 'disabled'}>${s.step === 'applying' ? 'Undoing…' : `Undo ${pluralize(n, 'file')}`}</button>`;
    }

    function draw() {
      const result = !!s.result;
      render(d, html`
        <div class="dlg">
          <div class="dlg-head">
            <h2 class="dlg-title" id="dlg-title">${icon('undo')} ${result ? 'Undo finished' : 'Undo'} ${agentChip(run.label)}${turn === null ? '' : html`<span class="badge">turn ${turn}</span>`}</h2>
            <p class="dlg-lead" id="undo-lead">${result
              ? 'Recorded as its own run, so blame and history stay right.'
              : html`Takes this run’s changes out of your working tree. Edits other agents made later, even in the same files, stay. Nothing changes until you confirm.`}</p>
            ${!result && run.active ? html`<div class="notice warn" style="margin:12px 0 0">${icon('alert')}<span>${run.label} is still working and may write these files again afterwards.</span></div>` : ''}
          </div>
          <div class="dlg-body">${body()}</div>
          <div class="dlg-foot">${foot()}</div>
        </div>`);
    }

    async function plan() {
      s.step = 'loading';
      s.error = null;
      draw();
      try {
        s.plan = await api.undo(run.run, { turn, apply: false });
        s.step = 'plan';
      } catch (e) {
        s.error = e;
      }
      draw();
      d.querySelector('#undo-confirm')?.focus();
    }

    async function apply() {
      if (s.typed.trim().toLowerCase() !== code.toLowerCase() || s.step === 'applying') return;
      s.step = 'applying';
      s.error = null; // a retry after a failed apply starts clean
      draw();
      try {
        s.result = await api.undo(run.run, { turn, apply: true });
        applied = s.result.files.some((f) => CLEAN.has(f.action));
        if (applied) ctx.emit('grapim:undone', { run: run.run, turn, files: s.result.files.filter((f) => CLEAN.has(f.action)).map((f) => f.path) });
        ctx.toast(applied ? `Undid ${name}.` : `Nothing was undone for ${name}.`);
        ctx.refreshShell();
      } catch (e) {
        s.error = e;
      }
      s.step = 'done';
      draw();
      d.querySelector('[data-close]')?.focus();
    }

    d.oninput = (e) => {
      if (e.target.id !== 'undo-confirm') return;
      s.typed = e.target.value;
      const btn = d.querySelector('[data-apply]');
      const ok = s.typed.trim().toLowerCase() === code.toLowerCase();
      if (btn) btn.disabled = !ok;
      d.__html = null; // the input's value changed outside render
    };
    d.onsubmit = (e) => { e.preventDefault(); apply(); };
    d.onclick = (e) => {
      if (e.target.closest('[data-apply]')) apply();
      if (e.target.closest('[data-retry]')) (s.plan && s.step !== 'loading' ? apply() : plan());
    };

    plan();
  });
}

function humanError(e) {
  return e?.message || 'Something went wrong.';
}

// "held by x right now" -> "Held by x right now."
function sentence(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return t[0].toUpperCase() + t.slice(1) + (/[.!?]$/.test(t) ? '' : '.');
}
