"use client";

import { DEFAULT_LOCALE, LOCALE_COOKIE, normalizeLocale } from "./config";

let translationMap = {};
let currentLocale = DEFAULT_LOCALE;
let reloadCallbacks = [];

// Read locale from cookie
function getLocaleFromCookie() {
  if (typeof document === "undefined") return DEFAULT_LOCALE;
  const cookie = document.cookie
    .split(";")
    .find((c) => c.trim().startsWith(`${LOCALE_COOKIE}=`));
  const value = cookie ? decodeURIComponent(cookie.split("=")[1]) : DEFAULT_LOCALE;
  return normalizeLocale(value);
}

// Load translation map
async function loadTranslations(locale) {
  if (locale === "en") {
    translationMap = {};
    return;
  }
  
  try {
    const response = await fetch(`/i18n/literals/${locale}.json`);
    translationMap = await response.json();
  } catch (err) {
    console.error("Failed to load translations:", err);
    translationMap = {};
  }
}

// Translate text - exported for use in components
export function translate(text) {
  if (!text || typeof text !== "string") return text;
  const trimmed = text.trim();
  if (!trimmed) return text;
  if (currentLocale === "en") return text;
  return translationMap[trimmed] || text;
}

// Get current locale - exported for use in components
export function getCurrentLocale() {
  return currentLocale;
}

// Register callback for locale changes
export function onLocaleChange(callback) {
  reloadCallbacks.push(callback);
  return () => {
    reloadCallbacks = reloadCallbacks.filter(cb => cb !== callback);
  };
}

// Attributes that carry user-visible text. `aria-label` and `title` are the
// load bearing ones: a screen reader in a non-English locale read every
// icon-only control out in English, because this walker only ever visited text
// nodes (#2745). `alt` and `placeholder` are the same defect in visible form.
const TRANSLATED_ATTRIBUTES = ["placeholder", "title", "aria-label", "alt"];

function isSkipped(element) {
  let el = element;
  while (el) {
    if (el.hasAttribute && el.hasAttribute("data-i18n-skip")) return true;
    el = el.parentElement;
  }
  return false;
}

// Process text node
function processTextNode(node) {
  if (!node.nodeValue || !node.nodeValue.trim()) return;
  
  // Skip if parent is script, style, code, or structural elements
  const parent = node.parentElement;
  if (!parent) return;
  
  if (isSkipped(parent)) return;
  
  const tagName = parent.tagName?.toLowerCase();
  
  // Skip elements that don't allow text nodes
  const skipTags = [
    "script", "style", "code", "pre",
    "colgroup", "table", "thead", "tbody", "tfoot", "tr",
    "select", "datalist", "optgroup"
  ];
  
  if (skipTags.includes(tagName)) return;
  
  // Store original text if not already stored
  if (!node._originalText) {
    node._originalText = node.nodeValue;
  }
  
  // Use original text for translation. translate() looks the string up trimmed,
  // so writing its result back raw dropped whatever whitespace separated this
  // node from its inline siblings — "Total  requests" became "Toplamrequests"
  // (#2745). Keep the original padding around the translated core.
  const original = node._originalText;
  const [, lead, core, trail] = original.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const translated = lead + translate(core) + trail;
  
  // Only update if different to avoid unnecessary DOM mutations
  if (translated !== node.nodeValue) {
    node._translatedText = translated;
    node.nodeValue = translated;
  }
}

// Process the translatable attributes of one element
function processAttributes(element) {
  if (!element || !element.hasAttribute) return;
  if (isSkipped(element)) return;
  
  for (const attr of TRANSLATED_ATTRIBUTES) {
    const current = element.getAttribute(attr);
    if (!current || !current.trim()) continue;
    
    // Store the original once, so switching locale twice does not translate a
    // translation, exactly as the text-node path does.
    const key = `_i18nOriginal_${attr}`;
    if (!element[key]) element[key] = current;
    
    const translated = translate(element[key]);
    if (translated !== current) {
      element[`_i18nTranslated_${attr}`] = translated;
      element.setAttribute(attr, translated);
    }
  }
}

// Process all text nodes in element
function processElement(element) {
  if (!element) return;
  
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT,
    null,
    false
  );
  
  let node;
  const nodesToProcess = [];
  
  // Collect all nodes first to avoid live collection issues
  while ((node = walker.nextNode())) {
    nodesToProcess.push(node);
  }
  
  // Process collected nodes
  nodesToProcess.forEach(processTextNode);
  
  // Then the attributes, including the root's own: a walker rooted at an
  // element never visits that element.
  processAttributes(element);
  const elements = element.querySelectorAll?.("*");
  if (elements) elements.forEach(processAttributes);
}

// Initialize runtime i18n
export async function initRuntimeI18n() {
  if (typeof window === "undefined") return;
  
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Process existing DOM
  processElement(document.body);
  
  // Watch for new nodes
  const observer = new MutationObserver((mutations) => {
    mutations.forEach((mutation) => {
      // A framework writes a new value into an existing node. Unless it is the
      // value this walker just wrote, it is the new original.
      if (mutation.type === "characterData") {
        const node = mutation.target;
        if (node.nodeValue !== node._translatedText) {
          node._originalText = node.nodeValue;
          processTextNode(node);
        }
        return;
      }
      if (mutation.type === "attributes") {
        const el = mutation.target;
        const attr = mutation.attributeName;
        if (el.getAttribute(attr) !== el[`_i18nTranslated_${attr}`]) {
          el[`_i18nOriginal_${attr}`] = el.getAttribute(attr);
          processAttributes(el);
        }
        return;
      }
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) {
          processElement(node);
        } else if (node.nodeType === Node.TEXT_NODE) {
          processTextNode(node);
        }
      });
    });
  });
  
  observer.observe(document.body, {
    childList: true,
    characterData: true,
    attributes: true,
    attributeFilter: TRANSLATED_ATTRIBUTES,
    subtree: true,
  });
}

// Reload translations when locale changes
export async function reloadTranslations() {
  currentLocale = getLocaleFromCookie();
  await loadTranslations(currentLocale);
  
  // Notify all registered callbacks
  reloadCallbacks.forEach(callback => callback());
  
  // Re-process entire DOM (will use stored original text)
  processElement(document.body);
}
