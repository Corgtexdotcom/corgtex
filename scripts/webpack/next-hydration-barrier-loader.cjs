"use strict";

// React can start hydrating a streamed App Router document before the browser
// finishes parsing it, then replace a valid server tree with error #418.
// Keep this scoped to Next's initial app entry; later React work is unaffected.
const { version } = require("next/package.json");

module.exports = function nextHydrationBarrierLoader(source) {
  if (version !== "15.5.26") {
    throw new Error(`Recheck the initial hydration barrier for Next ${version}.`);
  }

  const start = "function hydrate(instrumentationHooks) {";
  if (source.split(start).length !== 2) {
    throw new Error(`Expected one Next App Router hydrate entry in ${this.resourcePath}.`);
  }

  const barrier = `function hydrate(instrumentationHooks) {
    if (document.documentElement.id !== "__next_error__") {
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", () => hydrate(instrumentationHooks), { once: true });
            return;
        }
        if (Array.isArray(window.$RB) && window.$RB.length > 0) {
            setTimeout(() => hydrate(instrumentationHooks), 8);
            return;
        }
    }`;

  return source.replace(start, barrier);
};
