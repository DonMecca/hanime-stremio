/**
 * Hanime web request signer
 * Boots the site's embedded WASM (from vendor JS) in Node and exposes x-signature/x-time.
 */

let readyPromise = null;

class CustomEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.detail = init?.detail;
  }
}

function createWindowMock() {
  const listeners = {};
  const location = {
    href: 'https://hanime.tv/',
    origin: 'https://hanime.tv',
    protocol: 'https:',
    host: 'hanime.tv',
    hostname: 'hanime.tv',
    pathname: '/',
    search: '',
    hash: '',
    toString() {
      return this.href;
    }
  };

  const windowObj = {
    addEventListener(ev, fn) {
      (listeners[ev] ||= []).push(fn);
    },
    dispatchEvent(e) {
      for (const fn of listeners[e.type] || []) fn(e);
      return true;
    },
    setTimeout,
    clearTimeout,
    location,
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    crypto: require('crypto').webcrypto
  };

  windowObj.window = windowObj;
  windowObj.self = windowObj;
  windowObj.top = windowObj;
  windowObj.parent = windowObj;
  windowObj.frames = windowObj;
  windowObj.document = {
    currentScript: { src: 'https://hanime-cdn.com/js/vendor.js' },
    addEventListener() {},
    location
  };

  return { windowObj, listeners, location };
}

function installBrowserGlobals(windowObj, location) {
  global.window = windowObj;
  global.document = windowObj.document;
  global.self = windowObj;
  global.location = location;
  global.navigator = windowObj.navigator;
  global.CustomEvent = CustomEvent;

  // Force the vendor glue down the WEB path (embedded base64 wasm), not Node fs path
  process.type = 'renderer';
}

async function initSigner() {
  if (readyPromise) return readyPromise;

  readyPromise = (async () => {
    const { windowObj, location } = createWindowMock();
    installBrowserGlobals(windowObj, location);

    // Static require so bundlers include the vendor asset.
    // eslint-disable-next-line global-require
    require('../vendor/hanime-wasm-signer.js');

    const started = Date.now();
    while (!windowObj.stime) {
      if (Date.now() - started > 8000) {
        throw new Error('Hanime WASM signer failed to initialize');
      }
      await new Promise((r) => setTimeout(r, 25));
    }

    return windowObj;
  })();

  try {
    return await readyPromise;
  } catch (error) {
    readyPromise = null;
    throw error;
  }
}

/**
 * Get current request signature headers, refreshing via the site's "e" event.
 * @returns {Promise<{signature: string, time: number|string, userAgent: string}>}
 */
async function getSignatureHeaders() {
  const windowObj = await initSigner();
  windowObj.dispatchEvent(new CustomEvent('e'));

  if (!windowObj.ssignature || !windowObj.stime) {
    throw new Error('Hanime WASM signer produced empty signature');
  }

  return {
    signature: windowObj.ssignature,
    time: windowObj.stime,
    userAgent: windowObj.navigator.userAgent
  };
}

module.exports = {
  initSigner,
  getSignatureHeaders
};
