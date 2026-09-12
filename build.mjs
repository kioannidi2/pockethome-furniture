#!/usr/bin/env node
/**
 * PocketHome furniture site — scheduled rebuild
 * ------------------------------------------------------------------
 * Regenerates index.html from template.html + photos_data.json, and
 * folds in any NEW furniture-items from the Strapi database (api.pockethome.gr)
 * that aren't already part of the hand-curated CATALOG in template.html.
 *
 * Design goals (per explicit product decisions for this site):
 *  - The hand-curated CATALOG/packages in template.html are never rewritten
 *    by this script — Strapi items are only ever ADDED (via the
 *    STRAPI_EXTRA / STRAPI_EXTRA_COLORS placeholders), never replacing or
 *    editing existing entries. Re-running this script is idempotent.
 *  - Strapi currently mirrors most of the already-curated catalog too (same
 *    products, entered for other reasons e.g. the source-URL/supplier
 *    bookkeeping), so this script must recognise "this Strapi item is
 *    actually already on the site" and skip it, rather than showing every
 *    product twice under two slightly different names.
 *  - Only PocketHome's own naming (category + model) is ever shown on the
 *    page — supplier, SKU and sourceUrl are never fetched or embedded here.
 *  - If Strapi is unreachable or returns nothing usable, the build FAILS
 *    LOUDLY and does not touch index.html — the last good build stays live.
 *    (The site must keep working even when the backend is down.)
 *  - Any Strapi item that can't be safely mapped (unknown category, missing
 *    price, missing image) is skipped with a warning, not guessed at.
 */

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const STRAPI_URL = process.env.STRAPI_URL || 'https://api.pockethome.gr';
const TEMPLATE_PATH = path.join(__dirname, 'template.html');
const PHOTOS_PATH = path.join(__dirname, 'photos_data.json');
const OUTPUT_PATH = path.join(__dirname, 'index.html');

// Strapi's free-text `category` field -> {catalogKey, keyPrefix}. Based on the
// actual category values observed in the database (Sofa, Bed, Bedside,
// Wardrobe, Armchair, Sideboard, ...) — extend this list if new category
// strings show up in Strapi (an unmapped category is skipped, not guessed).
const CATEGORY_RULES = [
  { test: /single/i, and: /bed/i, cat: 'bed_single', prefix: 'bed_single_' },
  { test: /bed/i, cat: 'bed', prefix: 'bed_' },
  { test: /bedside|night ?stand|κομοδιν/i, cat: 'nightstand', prefix: 'ns_' },
  { test: /wardrobe|ντουλαπ/i, cat: 'wardrobe', prefix: 'wd_' },
  { test: /arm ?chair|πολυθρον/i, cat: 'armchair', prefix: 'ac_' },
  { test: /sofa|couch|καναπ/i, cat: 'sofa', prefix: 'sf_' },
  { test: /coffee ?table|^table$|τραπεζ/i, cat: 'table', prefix: 'ct_' },
  { test: /sideboard|tv ?unit|τηλεορασ/i, cat: 'tvunit', prefix: 'tv_' },
];

// Same colour vocabulary as the page's own chat assistant (template.html COLOR_WORDS),
// so Strapi's `color` field (English or Greek) maps to the site's colour tokens.
const COLOR_WORDS = {
  grey: ['grey', 'gray', 'anthracite', 'ανθρακι', 'γκρι'],
  beige: ['beige', 'cream', 'ivory', 'sonoma', 'εκρου', 'κρεμ', 'μπεζ'],
  black: ['black', 'μαυρ'],
  brown: ['brown', 'wood', 'wenge', 'walnut', 'castillo', 'βενγκε', 'καφε', 'ξυλ'],
  white: ['white', 'λευκ', 'ασπρ'],
  blue: ['blue', 'navy', 'petrol', 'μπλε', 'γαλαζι', 'πετρολ'],
  green: ['green', 'πρασιν'],
  teal: ['teal', 'mint', 'turquoise', 'τιρκουαζ', 'βεραμαν', 'μεντ'],
  yellow: ['yellow', 'gold', 'κιτριν'],
  red: ['red', 'κοκκιν'],
  pink: ['pink', 'ροζ'],
  orange: ['orange', 'πορτοκαλ'],
};

function log(...args) { console.log('[build]', ...args); }
function warn(...args) { console.warn('[build] WARN:', ...args); }

function slugify(s) {
  return String(s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function mapCategory(strapiCategory) {
  if (!strapiCategory) return null;
  for (const rule of CATEGORY_RULES) {
    if (rule.and) {
      if (rule.test.test(strapiCategory) && rule.and.test(strapiCategory)) return rule;
    } else if (rule.test.test(strapiCategory)) {
      return rule;
    }
  }
  return null;
}

function mapColors(strapiColor) {
  if (!strapiColor) return null;
  const lower = String(strapiColor).toLowerCase();
  const found = [];
  for (const [token, words] of Object.entries(COLOR_WORDS)) {
    if (words.some((w) => lower.indexOf(w) !== -1)) found.push(token);
  }
  return found.length ? found : null;
}

function buildModelLabel(name, catKey) {
  const trimmed = String(name).trim();
  const last = trimmed.split(/\s+/).pop() || trimmed;
  let label = last.toUpperCase();
  if (catKey === 'sofa') {
    const lower = trimmed.toLowerCase();
    const tags = [];
    if (/corner|γωνιακ/.test(lower)) tags.push('γωνιακός');
    if (/sofa[- ]bed|καναπε[- ]κρεβατ/.test(lower)) tags.push('καναπές-κρεβάτι');
    if (tags.length) label += ' (' + tags.join(', ') + ')';
  }
  return label;
}

// Extracts the hand-curated CATALOG object literal out of template.html and
// evaluates it, so this script always checks against the real, current
// catalog rather than a copy that could drift out of sync.
function extractCatalog(templateSrc) {
  const startMarker = 'var CATALOG = ';
  const endMarker = '\n  var CAT_ORDER';
  const start = templateSrc.indexOf(startMarker);
  const end = templateSrc.indexOf(endMarker);
  if (start === -1 || end === -1) {
    throw new Error('could not locate the CATALOG object in template.html (markers not found)');
  }
  let objSrc = templateSrc.slice(start + startMarker.length, end).trim();
  if (objSrc.endsWith(';')) objSrc = objSrc.slice(0, -1);
  // eslint-disable-next-line no-new-func -- trusted, our own template file, not user input
  return new Function('return (' + objSrc + ')')();
}

// Is this Strapi item actually the same product as something already in the
// hand-curated catalog, just entered under a slightly different name? Match
// by checking whether any significant (Latin, 3+ letter) word from an
// existing option's model label appears as a whole word in the Strapi name.
function isAlreadyCurated(catalogCategory, name) {
  if (!catalogCategory) return false;
  const upperName = name.toUpperCase();
  return catalogCategory.options.some((opt) => {
    const words = opt.model
      .replace(/\(.*?\)/g, '')
      .toUpperCase()
      .split(/\s+/)
      .filter((w) => w.length >= 3 && /^[A-Z0-9]+$/.test(w));
    return words.some((w) => new RegExp('\\b' + w + '\\b').test(upperName));
  });
}

async function fetchStrapiItems() {
  const url = `${STRAPI_URL}/api/furniture-items?populate=images&pagination[pageSize]=100`;
  log('fetching', url);
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Strapi returned HTTP ${res.status}`);
  const json = await res.json();
  if (!json || !Array.isArray(json.data)) throw new Error('Unexpected Strapi response shape');
  return json.data;
}

function firstImageUrl(item) {
  const images = item.images?.data || item.images || null;
  let img = null;
  if (Array.isArray(images) && images.length) img = images[0];
  else if (images && !Array.isArray(images)) img = images;
  if (!img) return null;
  const attrs = img.attributes || img; // Strapi v4 nests under attributes; v5 is flat
  const url = attrs?.url;
  if (!url) return null;
  return url.startsWith('http') ? url : `${STRAPI_URL}${url}`;
}

async function toDataUri(imageUrl) {
  const res = await fetch(imageUrl, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`image fetch HTTP ${res.status}`);
  const contentType = res.headers.get('content-type') || 'image/jpeg';
  const buf = Buffer.from(await res.arrayBuffer());
  return `data:${contentType};base64,${buf.toString('base64')}`;
}

async function main() {
  const [template, photosRaw] = await Promise.all([
    readFile(TEMPLATE_PATH, 'utf8'),
    readFile(PHOTOS_PATH, 'utf8'),
  ]);
  const basePhotos = JSON.parse(photosRaw);
  const catalog = extractCatalog(template);

  let items;
  try {
    items = await fetchStrapiItems();
  } catch (err) {
    console.error('[build] FATAL: could not fetch Strapi furniture-items —', err.message);
    console.error('[build] Leaving index.html untouched (last good build stays live).');
    process.exit(1);
  }

  const extra = {}; // { catKey: [{key, model, price}] }
  const extraColors = {}; // { key: [colorTokens] }
  const extraPhotos = {}; // { key: dataUri }
  let added = 0, skipped = 0, alreadyCurated = 0;

  for (const raw of items) {
    const item = raw.attributes || raw; // support both Strapi v4 (attributes) and v5 (flat) shapes
    const name = item.name;
    if (!name) { warn('item without a name, skipping (id ' + raw.id + ')'); skipped++; continue; }

    if (item.availabilityStatus && !/available/i.test(item.availabilityStatus)) {
      log(`"${name}" — availabilityStatus is "${item.availabilityStatus}", skipping`);
      skipped++; continue;
    }

    const rule = mapCategory(item.category);
    if (!rule) { warn(`"${name}" — unrecognised category "${item.category}", skipping`); skipped++; continue; }

    if (isAlreadyCurated(catalog[rule.cat], name)) {
      alreadyCurated++;
      continue;
    }

    const price = Number(item.baseMonthlyPrice);
    if (!price || price <= 0) { warn(`"${name}" — no baseMonthlyPrice set, skipping`); skipped++; continue; }

    const imgUrl = firstImageUrl(item);
    if (!imgUrl) { warn(`"${name}" — no image uploaded, skipping`); skipped++; continue; }

    const key = rule.prefix + slugify(name.split(/\s+/).pop());
    if (basePhotos[key] || extraPhotos[key]) { alreadyCurated++; continue; } // exact key collision safety net

    try {
      extraPhotos[key] = await toDataUri(imgUrl);
    } catch (err) {
      warn(`"${name}" — could not download image (${err.message}), skipping`);
      skipped++; continue;
    }

    if (!extra[rule.cat]) extra[rule.cat] = [];
    extra[rule.cat].push({ key, model: buildModelLabel(name, rule.cat), price });

    const colors = mapColors(item.color);
    if (colors) extraColors[key] = colors;

    added++;
    log(`+ "${name}" -> ${rule.cat}/${key} (€${price}/μήνα)`);
  }

  log(`${added} new item(s) added from Strapi, ${alreadyCurated} already on the site, ${skipped} skipped (missing data).`);

  const mergedPhotos = { ...basePhotos, ...extraPhotos };

  let out = template;
  out = out.replace('/*__PHOTOS_JSON__*/', JSON.stringify(mergedPhotos));
  out = out.replace('/*__STRAPI_EXTRA__*/ {}', JSON.stringify(extra));
  out = out.replace('/*__STRAPI_EXTRA_COLORS__*/ {}', JSON.stringify(extraColors));

  if (out.indexOf('__PHOTOS_JSON__') !== -1 || out.indexOf('__STRAPI_EXTRA__') !== -1 || out.indexOf('__STRAPI_EXTRA_COLORS__') !== -1) {
    throw new Error('one or more placeholders were not found/replaced in template.html — aborting to avoid publishing a broken page');
  }

  await writeFile(OUTPUT_PATH, out, 'utf8');
  log(`wrote ${OUTPUT_PATH} (${(out.length / 1024).toFixed(0)} KB)`);
}

main().catch((err) => {
  console.error('[build] FATAL:', err);
  process.exit(1);
});
