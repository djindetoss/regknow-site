// Search and filters. Pagefind does the work in the browser, so no server is involved.
const PAGE_SIZE = 25;
const GROUPS = [
  ["doc_type", "Document type"], ["topic", "Topic"], ["issuer", "Issuer"], ["status", "Regulatory status"],
  ["language", "Language"], ["tag", "Tags"], ["access", "Availability"],
];
const el = (id) => document.getElementById(id);
const state = { q: "", selected: {}, yearFrom: "", yearTo: "", meaning: false };
const HYBRID_POOL = 50;
const RANK_OFFSET = 60;
let semantic = null;
let pagefind, labels, baseFilters, loaded = 0, currentResults = [], loadedItems = [], searchToken = 0;

function remembered() {
  try { return localStorage.getItem("regknow-meaning") === "1"; } catch { return false; }
}

function remember(on) {
  try { localStorage.setItem("regknow-meaning", on ? "1" : "0"); } catch { /* Only a convenience. */ }
}

function readUrl() {
  const params = new URLSearchParams(location.search);
  state.q = params.get("q") || "";
  state.yearFrom = params.get("from") || "";
  state.yearTo = params.get("to") || "";
  state.meaning = params.get("meaning") === "1" || remembered();
  state.selected = {};
  for (const [key] of GROUPS) if (params.has(key)) state.selected[key] = params.getAll(key);
}

function writeUrl() {
  const params = new URLSearchParams();
  if (state.q) params.set("q", state.q);
  if (state.yearFrom) params.set("from", state.yearFrom);
  if (state.yearTo) params.set("to", state.yearTo);
  if (state.meaning) params.set("meaning", "1");
  for (const [key, values] of Object.entries(state.selected)) values.forEach((v) => params.append(key, v));
  const query = params.toString();
  history.replaceState(null, "", query ? `?${query}` : location.pathname);
}

function buildFilters() {
  const filters = {};
  for (const [key, values] of Object.entries(state.selected)) if (values.length) filters[key] = { any: values };
  const years = Object.keys(baseFilters.year || {}).filter(
    (y) => (!state.yearFrom || y >= state.yearFrom) && (!state.yearTo || y <= state.yearTo));
  if (state.yearFrom || state.yearTo) filters.year = { any: years.length ? years : ["none"] };
  if (!state.q) filters.kind = "doc"; // Browsing lists each document once.
  return filters;
}

// Show Pagefind's excerpt as text, keeping only its <mark> tags.
function appendExcerpt(parent, excerpt) {
  const decoder = document.createElement("textarea");
  let marked = false;
  for (const part of excerpt.split(/(<\/?mark>)/)) {
    if (part === "<mark>") marked = true;
    else if (part === "</mark>") marked = false;
    else if (part) {
      decoder.innerHTML = part;
      const text = document.createTextNode(decoder.value);
      if (marked) parent.appendChild(document.createElement("mark")).appendChild(text);
      else parent.appendChild(text);
    }
  }
}

function renderResultGroups(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.meta.doc_id)) groups.set(item.meta.doc_id, { meta: item.meta, hits: [] });
    if (state.q && item.meta.where) groups.get(item.meta.doc_id).hits.push(item);
  }
  el("results").replaceChildren(...[...groups.values()].map(({ meta, hits }) => {
    const li = document.createElement("li");
    li.className = "result";
    const h3 = li.appendChild(document.createElement("h3"));
    const link = h3.appendChild(document.createElement("a"));
    link.href = `d/${meta.doc_id}/`;
    link.textContent = meta.title;
    const line = li.appendChild(document.createElement("p"));
    line.className = "meta";
    const type = labels.doc_type[meta.doc_type] || meta.doc_type;
    const status = meta.status ? labels.status[meta.status] || meta.status : "";
    line.textContent = [type, status, meta.issuer, meta.date.slice(0, 4),
      meta.access === "full-text" ? "" : labels.access[meta.access].toLowerCase()].filter(Boolean).join(" · ");
    for (const hit of hits.slice(0, 3)) {
      const a = li.appendChild(document.createElement("a"));
      a.className = "hit";
      a.href = hit.meta.href;
      const where = a.appendChild(document.createElement("span"));
      where.className = "where";
      where.textContent = hit.meta.where;
      appendExcerpt(a, hit.excerpt);
    }
    return li;
  }));
}

function checkbox(group, value, text, count, child) {
  const label = document.createElement("label");
  if (child) label.className = "child";
  const input = label.appendChild(document.createElement("input"));
  input.type = "checkbox";
  input.checked = (state.selected[group] || []).includes(value);
  input.addEventListener("change", () => {
    const values = new Set(state.selected[group] || []);
    input.checked ? values.add(value) : values.delete(value);
    state.selected[group] = [...values];
    run();
  });
  label.appendChild(document.createTextNode(text));
  const number = label.appendChild(document.createElement("span"));
  number.className = "count";
  number.textContent = count;
  return label;
}

function yearControl() {
  const years = Object.keys(baseFilters.year || {}).sort();
  const section = document.createElement("div");
  section.className = "filter-group";
  section.appendChild(document.createElement("h2")).textContent = "Date range";
  const row = section.appendChild(document.createElement("div"));
  row.className = "years";
  const build = (name, key) => {
    const select = row.appendChild(document.createElement("select"));
    select.setAttribute("aria-label", name);
    select.add(new Option(name, ""));
    years.forEach((y) => select.add(new Option(y, y)));
    select.value = state[key];
    select.addEventListener("change", () => { state[key] = select.value; run(); });
  };
  build("From", "yearFrom");
  build("To", "yearTo");
  return section;
}

function renderFilters(counts) {
  const sections = [yearControl()];
  for (const [key, title] of GROUPS) {
    const values = Object.keys(baseFilters[key] || {}).sort();
    if (!values.length) continue;
    const section = document.createElement("div");
    section.className = "filter-group";
    section.appendChild(document.createElement("h2")).textContent = title;
    for (const value of values) {
      const text = (labels[key] && labels[key][value]) || value;
      section.appendChild(checkbox(key, value, text, (counts[key] || {})[value] ?? 0,
        key === "topic" && value.includes("/")));
    }
    sections.push(section);
  }
  el("filters").replaceChildren(...sections);
}

const fold = (text) => text.normalize("NFKD").replace(/[^\p{L}\p{N}]/gu, "").toLowerCase();

// When a word has no match, Pagefind retries with ever shorter prefixes, so "zzzqqq" can
// find "Z." Keep a result only if a highlighted word starts like a word that was searched.
function reallyMatches(item) {
  if (!state.q) return true;
  const terms = state.q.split(/\s+/).map(fold).filter(Boolean).map((t) => t.slice(0, 3));
  const marks = [...item.excerpt.matchAll(/<mark>(.*?)<\/mark>/g)].map((m) => fold(m[1]));
  return marks.some((mark) => terms.some((term) => mark.startsWith(term)));
}

async function loadMore() {
  const wanted = loadedItems.length + PAGE_SIZE;
  while (loadedItems.length < wanted && loaded < currentResults.length) {
    const batch = currentResults.slice(loaded, loaded + PAGE_SIZE);
    const data = await Promise.all(batch.map((r) => r.data()));
    loaded += batch.length;
    loadedItems = [...loadedItems, ...data.filter(reallyMatches)];
  }
  renderResultGroups(loadedItems);
  el("more").hidden = loaded >= currentResults.length;
}

function allowedByFilters(filters) {
  for (const [key, values] of Object.entries(state.selected)) {
    if (values.length && !values.some((value) => (filters[key] || []).includes(value))) return false;
  }
  const year = (filters.year || [""])[0];
  return (!state.yearFrom || year >= state.yearFrom) && (!state.yearTo || year <= state.yearTo);
}

// Merge the keyword and meaning lists by rank. A passage found by both keeps its highlights.
async function hybridItems(token) {
  const data = await Promise.all(currentResults.slice(0, HYBRID_POOL).map((r) => r.data()));
  const keyword = data.filter(reallyMatches);
  const meaning = await semantic.search(state.q, allowedByFilters);
  if (token !== searchToken) return null;
  const merged = new Map();
  const add = (items) => items.forEach((item, rank) => {
    const entry = merged.get(item.meta.href) || { item, score: 0 };
    entry.score += 1 / (RANK_OFFSET + rank + 1);
    merged.set(item.meta.href, entry);
  });
  add(keyword);
  add(meaning);
  return [...merged.values()].sort((a, b) => b.score - a.score).map((entry) => entry.item);
}

async function run() {
  const token = ++searchToken;
  writeUrl();
  const result = await pagefind.search(state.q || null, { filters: buildFilters(), sort: state.q ? {} : { date: "desc" } });
  if (token !== searchToken) return;
  currentResults = result.results;
  loaded = 0;
  loadedItems = [];
  el("results").replaceChildren();
  const hybrid = state.meaning && state.q && semantic;
  // Pagefind only counts keyword matches, which would show zeros beside results by meaning.
  renderFilters(hybrid ? baseFilters : result.filters);
  if (hybrid) {
    const items = await hybridItems(token);
    if (!items) return;
    loaded = currentResults.length;
    loadedItems = items;
    renderResultGroups(items);
    el("more").hidden = true;
  } else {
    await loadMore();
  }
  if (token !== searchToken) return;
  const total = loadedItems.length;
  const plus = loaded < currentResults.length ? "+" : "";
  const noun = state.q ? (total === 1 ? "matching passage" : "matching passages") : (total === 1 ? "document" : "documents");
  const loose = hybrid ? " The closest in meaning can be only loosely related." : "";
  el("summary").textContent = total ? `${total}${plus} ${noun}.${loose}` : "Nothing matches. Try other words or fewer filters.";
}

// Nothing is downloaded until the reader turns this on.
async function turnOnMeaning(root) {
  el("summary").textContent = "Loading the model. The first time takes a minute or two…";
  try {
    if (!semantic) {
      const { loadSemantic } = await import("./semantic.js");
      semantic = await loadSemantic(root, (percent) => {
        el("summary").textContent = `Downloading the model: ${percent}%`;
      });
    }
  } catch (error) {
    console.error(error);
    state.meaning = false;
    el("meaning").checked = false;
    remember(false);
    await run();
    el("summary").textContent = `The model couldn't load, so this search used keywords only. ${el("summary").textContent}`;
    return;
  }
  await run();
}

async function setUpMeaning(root) {
  const box = el("meaning");
  if (!box) {
    state.meaning = false;
    return;
  }
  box.checked = state.meaning;
  box.addEventListener("change", () => {
    state.meaning = box.checked;
    remember(box.checked);
    state.meaning ? turnOnMeaning(root) : run();
  });
}

async function start() {
  readUrl();
  el("q").value = state.q;
  el("filter-panel").open = window.matchMedia("(min-width: 761px)").matches;
  const root = new URL("../", import.meta.url);
  [pagefind, labels] = await Promise.all([
    import(new URL("pagefind/pagefind.js", root).href),
    fetch(new URL("labels.json", root)).then((r) => r.json()),
  ]);
  await pagefind.options({ excerptLength: 40 });
  await pagefind.filters(); // Without this, results only count the filters used in the request.
  const docs = await pagefind.search(null, { filters: { kind: "doc" } });
  baseFilters = docs.filters;
  let timer;
  el("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = el("q").value.trim(); run(); }, 200);
  });
  el("search-form").addEventListener("submit", (event) => { event.preventDefault(); state.q = el("q").value.trim(); run(); });
  el("more").addEventListener("click", loadMore);
  await setUpMeaning(root);
  el("clear").addEventListener("click", () => {
    state.selected = {}; state.yearFrom = ""; state.yearTo = "";
    run();
  });
  await run();
  if (state.meaning) await turnOnMeaning(root);
}

start().catch((error) => {
  el("summary").textContent = "Search couldn't load. Please reload the page.";
  console.error(error);
});
