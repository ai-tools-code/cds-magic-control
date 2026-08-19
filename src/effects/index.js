import { scratchEffect } from './scratch.js';
import { cardPhoneEffect } from './card-phone.js';
import { googleSingleEffect } from './google-single.js';
import { peekEffect } from './peek.js';
import { productLettersEffect } from './product-letters.js';

export function buildEffectScript(ctx) {
  switch (ctx.effect) {
    case 'scratch': return scratchEffect(ctx);
    case 'card_phone': return cardPhoneEffect(ctx);
    case 'google_single': return googleSingleEffect(ctx);
    case 'peek': return peekEffect(ctx);
    case 'product_letters': return productLettersEffect(ctx);
    default: return `(function(){try{if(typeof completion==='function')completion('Unknown effect')}catch(_){}})();`;
  }
}

export function wrapEffect(name, body) {
  return `(function(){"use strict";try{if(window.__cdsActiveEffect&&typeof window.__cdsActiveEffect.destroy==='function'){window.__cdsActiveEffect.destroy();}}catch(_){}\nvar __CDS_EFFECT=${JSON.stringify(name)};\n${body}\ntry{if(typeof completion==='function')completion('ready')}catch(_){}\n})();`;
}
