// Runs before first paint (a blocking script in <head>), so a chosen theme never flashes.
try {
  var t = localStorage.getItem('memnest-theme');
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
