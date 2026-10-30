import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname } from "node:path";

const media = { ".html": "text/html", ".css": "text/css", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain" };
const assets = new Set(["/index.html", "/styles.css", "/app.mjs", "/engine.mjs", "/memo.mjs", "/data/hts-snapshot.json", "/data/imports.json", "/README.md", "/DATA.md"]);

createServer(async (request, response) => {
  const pathname = new URL(request.url, "http://127.0.0.1").pathname;
  const file = pathname === "/" ? "/index.html" : pathname;
  if (!assets.has(file)) return response.writeHead(404).end();
  try {
    const content = await readFile(new URL("." + file, import.meta.url));
    response.writeHead(200, { "Content-Type": media[extname(file)] + "; charset=utf-8" }).end(content);
  } catch (error) {
    response.writeHead(error.code === "ENOENT" ? 404 : 500).end();
  }
}).listen(Number(process.argv[2] ?? 4177), "127.0.0.1", function () {
  console.log(`http://127.0.0.1:${this.address().port}`);
});
