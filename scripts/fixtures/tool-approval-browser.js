async (page) => {
  const base = await page.evaluate(() => new URL(location.href).searchParams.get('runFixture'));
  if (!base || !/^http:\/\/127\.0\.0\.1:\d+$/.test(base) || /:(3000|3001)$/.test(base)) throw new Error('Isolated fixture required');
  await page.addInitScript(fixture => {
    const original = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), location.origin);
      if (url.port === '3001' && ['127.0.0.1', 'localhost'].includes(url.hostname)) {
        return original(fixture + url.pathname + url.search, { ...init, credentials: 'omit' });
      }
      return original(input, init);
    };
  }, base);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.reload();
  await page.getByRole('textbox', { name: '输入任务，按 Enter 发送...' }).waitFor();
  return await page.locator('body').ariaSnapshot();
}
