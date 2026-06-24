import { chromium } from 'playwright';

async function main() {
  const browser = await chromium.connectOverCDP('http://127.0.0.1:9222');
  const context = browser.contexts()[0];
  const page = context.pages()[0];

  const info = await page.evaluate(() => {
    const input = document.querySelector('div[contenteditable="true"][role="textbox"]');
    const button = Array.from(document.querySelectorAll('button')).find(b => b.innerText.includes('arrow_forward'));
    
    return {
      input: input ? {
        tagName: input.tagName,
        innerText: input.innerText,
        textContent: input.textContent,
        html: input.outerHTML.substring(0, 300)
      } : null,
      button: button ? {
        tagName: button.tagName,
        innerText: button.innerText,
        className: button.className,
        disabledProperty: button.disabled,
        disabledAttribute: button.getAttribute('disabled'),
        ariaDisabled: button.getAttribute('aria-disabled'),
        html: button.outerHTML.substring(0, 300)
      } : null
    };
  });

  console.log('DOM Info:', JSON.stringify(info, null, 2));
  await browser.close();
}

main().catch(console.error);
