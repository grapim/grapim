// Applies the theme you picked (shared with the review desk: localStorage
// "grapim.theme") before first paint, so a dark choice never flashes light.
try { const t = localStorage.getItem('grapim.theme'); if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t; } catch {}
