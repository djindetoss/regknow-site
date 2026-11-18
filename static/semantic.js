// Search by meaning, entirely in the browser. Loaded only after the reader turns it on.
const MAX_MATCHES = 10;

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// The library comes from a CDN, so run it only if it's the exact file the site was built with.
async function importLibrary(root) {
  const runtime = await fetch(new URL("semantic/runtime.json", root)).then((r) => r.json());
  const code = await fetch(runtime.library_url).then((r) => {
    if (!r.ok) throw new Error(`Couldn't fetch the library: ${r.status}`);
    return r.arrayBuffer();
  });
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", code));
  const hex = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  if (hex !== runtime.library_sha256) throw new Error("The library doesn't match the site's copy.");
  const url = URL.createObjectURL(new Blob([code], { type: "text/javascript" }));
  try {
    return await import(url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function loadSemantic(root, onProgress) {
  const [index, buffer] = await Promise.all([
    fetch(new URL("semantic/index.json", root)).then((r) => r.json()),
    fetch(new URL("semantic/vectors.bin", root)).then((r) => r.arrayBuffer()),
  ]);
  const vendor = new URL("vendor/transformers/", root).href;
  const { env, pipeline } = await importLibrary(root);
  env.allowLocalModels = false;
  env.backends.onnx.wasm.wasmPaths = vendor;
  env.backends.onnx.wasm.numThreads = 1; // GitHub Pages can't send the headers threads need.
  const extract = await pipeline("feature-extraction", index.model, {
    dtype: index.dtype,
    device: "wasm",
    progress_callback: (event) => {
      if (event.status === "progress_total" || (event.status === "progress" && event.file?.endsWith(".onnx"))) {
        onProgress(Math.round(event.progress));
      }
    },
  });
  const vectors = new Int8Array(buffer);
  const size = index.dimensions;

  return {
    // Return items shaped like Pagefind's results, best match first.
    async search(query, allowed) {
      const output = await extract(`query: ${query}`, { pooling: "mean", normalize: true });
      const embedded = output.data;
      const scored = [];
      index.passages.forEach((passage, position) => {
        const doc = index.documents[passage.doc];
        if (!allowed(doc.filters)) return;
        let score = 0;
        const start = position * size;
        for (let i = 0; i < size; i++) score += embedded[i] * vectors[start + i];
        score /= 127;
        if (score >= index.min_score) scored.push({ passage, doc, score });
      });
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, MAX_MATCHES).map(({ passage, doc }) => ({
        excerpt: escapeHtml(passage.excerpt),
        meta: {
          ...doc,
          doc_id: passage.doc,
          href: passage.href,
          where: passage.where,
        },
      }));
    },
  };
}
