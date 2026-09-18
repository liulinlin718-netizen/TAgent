async (page) => {
  const base = await page.evaluate(() => {
    const value = new URL(location.href).searchParams.get('admissionFixture');
    if (!value) return null;
    const url = new URL(value);
    return url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.port && !['3000', '3001'].includes(url.port) ? url.origin : null;
  });
  if (!base) throw new Error('An isolated admission fixture is required');
  await page.context().route(/^http:\/\/(localhost|127\.0\.0\.1):3001\//, route => route.abort());
  await page.context().addInitScript(fixture => {
    const native = window.fetch.bind(window);
    window.__admissionResponses = [];
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.href);
      const response = await (url.pathname.startsWith('/api/') ? native(fixture + url.pathname + url.search, { ...init, credentials: 'omit' }) : native(input, init));
      if (url.pathname === '/api/agent/orchestrate') {
        void response.clone().text().then(text => window.__admissionResponses.push({ status: response.status, text }));
      }
      return response;
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`http://127.0.0.1:3000/?admissionFixture=${encodeURIComponent(base)}`);
  return { base, fixtureOnly: true };
}
