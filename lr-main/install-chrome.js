const puppeteer = require('puppeteer');

(async () => {
  try {
    console.log("Installing Chromium via Puppeteer...");
    const browserFetcher = puppeteer.createBrowserFetcher();
    const revisionInfo = await browserFetcher.download('1181205'); // You can also use puppeteer.executablePath() default revision
    console.log('Chromium downloaded to:', revisionInfo.executablePath);
  } catch (err) {
    console.error("Failed to download Chromium:", err);
    process.exit(1);
  }
})();
