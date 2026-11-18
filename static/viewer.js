// PDF viewer. Opens at the page in the address, such as #page=12, and keeps it up to date.
const section = document.getElementById("viewer");
const vendor = new URL(section.dataset.vendor, location.href);
const pdfjs = await import(new URL("pdf.min.mjs", vendor).href);
pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdf.worker.min.mjs", vendor).href;

const canvas = document.getElementById("canvas");
const pageInput = document.getElementById("page");
const pdf = await pdfjs.getDocument({
  url: new URL(section.dataset.pdf, location.href).href,
  standardFontDataUrl: new URL("standard_fonts/", vendor).href,
  cMapUrl: new URL("cmaps/", vendor).href,
  cMapPacked: true,
  isEvalSupported: false,
}).promise;
document.getElementById("pages").textContent = pdf.numPages;
pageInput.max = pdf.numPages;

let current = 1;
let zoom = 1;
let renderTask = null;

function requestedPage() {
  const match = location.hash.match(/page=(\d+)/);
  return match ? Number(match[1]) : 1;
}

async function show(number) {
  current = Math.min(Math.max(number, 1), pdf.numPages);
  pageInput.value = current;
  if (renderTask) renderTask.cancel();
  const page = await pdf.getPage(current);
  const available = section.clientWidth - 24;
  const fit = available / page.getViewport({ scale: 1 }).width;
  const ratio = window.devicePixelRatio || 1;
  const viewport = page.getViewport({ scale: fit * zoom * ratio });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  canvas.style.width = `${viewport.width / ratio}px`;
  canvas.style.height = `${viewport.height / ratio}px`;
  renderTask = page.render({ canvasContext: canvas.getContext("2d"), viewport });
  try {
    await renderTask.promise;
  } catch (error) {
    if (error.name !== "RenderingCancelledException") throw error;
  }
}

function go(number) {
  history.replaceState(null, "", `#page=${number}`);
  show(number);
}

document.getElementById("prev").addEventListener("click", () => go(Math.max(current - 1, 1)));
document.getElementById("next").addEventListener("click", () => go(Math.min(current + 1, pdf.numPages)));
pageInput.addEventListener("change", () => go(Number(pageInput.value) || 1));
document.getElementById("zoom-in").addEventListener("click", () => { zoom *= 1.2; show(current); });
document.getElementById("zoom-out").addEventListener("click", () => { zoom /= 1.2; show(current); });
window.addEventListener("hashchange", () => show(requestedPage()));
await show(requestedPage());
if (location.hash.includes("page=")) section.scrollIntoView();
