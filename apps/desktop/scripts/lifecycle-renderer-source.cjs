// Data crossing executeJavaScript must remain a literal, never source or selector syntax.
const sourceLiteral = value => {
  const json = JSON.stringify(value);
  if (json === undefined) throw new TypeError('Renderer source requires JSON data');
  return json.replace(/[<>\u2028\u2029]/g, c => {
    const escapes = { '<': '\\u003c', '>': '\\u003e', '\u2028': '\\u2028', '\u2029': '\\u2029' };
    return escapes[c];
  });
};
const buttonSource = text => `(()=>{const text=${sourceLiteral(text)};const e=[...document.querySelectorAll('button')].find(e=>e.textContent.trim()===text);if(!e)throw Error('Missing button '+text);e.click()})()`;
const keySource = (id, key) => `(()=>{const id=${sourceLiteral(id)};const e=[...document.querySelectorAll('[aria-label]')].find(e=>e.getAttribute('aria-label')===id);if(!e)throw Error('Missing input '+id);e.focus();window.dispatchEvent(new KeyboardEvent('keydown',{key:${sourceLiteral(key)},ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))})()`;
module.exports = { sourceLiteral, buttonSource, keySource };
