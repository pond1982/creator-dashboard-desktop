// Restore the saved appearance before the browser paints. The server supplies the authoritative settings.
try {
  const theme = localStorage.getItem('creator-dashboard.theme');
  if (['midnight', 'aurora', 'daylight'].includes(theme)) document.documentElement.dataset.theme = theme;
} catch {}
